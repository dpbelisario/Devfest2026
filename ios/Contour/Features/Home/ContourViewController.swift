import AVFoundation
import CoreLocation
import Speech
import SwiftUI
import UIKit
import UserNotifications
import WebKit

final class ContourViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, CLLocationManagerDelegate {
    private(set) var web: WKWebView!
    private let location = CLLocationManager()
    private let indoorTracker = IndoorStepTracker()
    private let haptics = AlertHaptics()
    private let audio = AVAudioEngine()
    private var launchObstacleDemo = ProcessInfo.processInfo.arguments.contains("--bundled-obstacle-demo")
    private weak var obstacleScanner: ObstacleScanViewController?
    private weak var indoorScanner: IndoorDestinationScanViewController?
    private var speechTask: SFSpeechRecognitionTask?
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var pendingAlert: ContourAlert?
    private var pageReady = false
    private var overlayTransferTask: Task<Void, Never>?
    private var returningFromOverlay = false
    var floorOverlayJSON: () async throws -> String = { try await NativeFloorOverlayTransfer.json() }
    private var usingFallback = false
    private var retriedLateMap = false
    private var timeout: DispatchWorkItem?
    private var microphoneTapInstalled = false
    private var notificationStatus = false
    private var requestingLocation = false
    private var requestingFloorHeading = false
    private var sessionGeneration = 0
    private var speechGeneration = 0
    private let hostedURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "ContourUIURL") as? String ?? "")
    private let bundledURL = Bundle.main.url(forResource: "contour", withExtension: "html")!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "contour")
        for resource in ["bridge", "native-floor-overlay"] {
            if let script = Bundle.main.url(forResource: resource, withExtension: "js"),
               let source = try? String(contentsOf: script, encoding: .utf8) {
                config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(refreshSavedFloorOverlay),
            name: NativeFloorOverlayTransfer.savedNotification, object: nil)
        config.allowsInlineMediaPlayback = true
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile ContourApp/1.0 ContourIOS/1.0"
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        indoorTracker.onUpdate = { [weak self] pose in
            guard let self else { return }
            if let data = try? JSONEncoder().encode(pose), let object = try? JSONSerialization.jsonObject(with: data) {
                self.call("contourIOSIndoorPose", [object])
            }
            self.indoorScanner?.refreshIndoorPose()
        }
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        location.headingFilter = 3
        if !launchObstacleDemo, let url = hostedURL, url.scheme == "https" {
            web.load(URLRequest(url: url))
            let task = DispatchWorkItem { [weak self] in self?.fallBack() }
            timeout = task
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: task)
        } else { fallBack() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        let focus = returningFromOverlay
        returningFromOverlay = false
        syncSavedFloorOverlay(focus: focus)
    }

    @objc private func refreshSavedFloorOverlay() { syncSavedFloorOverlay(focus: true) }

    private func syncSavedFloorOverlay(focus: Bool) {
        overlayTransferTask?.cancel()
        guard pageReady, isOurs(web.url) else { return }
        let expectedURL = web.url
        overlayTransferTask = Task { [weak self] in
            do {
                let json = try await self?.floorOverlayJSON() ?? "null"
                guard let self, !Task.isCancelled, self.pageReady,
                      self.web.url == expectedURL, self.isOurs(self.web.url) else { return }
                _ = try await self.web.callAsyncJavaScript(
                    "const plan = JSON.parse(json); if (plan) plan.visible = false; return window.ContourNativeFloorOverlay?.apply(plan, false) ?? false;",
                    arguments: ["json": json, "focus": focus], in: nil, in: .page)
            } catch {
                // Keep the existing page intact on storage/navigation failure; the native editor reports disk errors.
                NSLog("Saved floor overlay could not be restored: %@", error.localizedDescription)
            }
        }
    }

    @objc private func openFloorOverlay() {
        presentFloorOverlay()
    }
    private func presentFloorOverlay(showWalkingConnections: Bool = false) {
        guard presentedViewController == nil else { return }
        if #available(iOS 17.0, *) {
            returningFromOverlay = true
            let editor = UIHostingController(rootView: NativeFloorOverlay(showWalkingConnections: showWalkingConnections))
            editor.modalPresentationStyle = .fullScreen
            present(editor, animated: true)
        } else {
            let notice = UIAlertController(title: "Floor overlay", message: "The native editor requires iOS 17 or later.", preferredStyle: .alert)
            notice.addAction(UIAlertAction(title: "OK", style: .default))
            present(notice, animated: true)
        }
    }

    private func fallBack() {
        guard !usingFallback else { return }
        usingFallback = true
        timeout?.cancel()
        web.loadFileURL(bundledURL, allowingReadAccessTo: bundledURL.deletingLastPathComponent())
    }

    private func isOurs(_ url: URL?) -> Bool {
        guard let url else { return false }
        if url.isFileURL { return url.standardizedFileURL == bundledURL.standardizedFileURL }
        return hostedURL.map { WebOrigin.sameOrigin(url, $0) } ?? false
    }

    private func isOurs(_ origin: WKSecurityOrigin) -> Bool {
        if origin.protocol == "file" { return web.url?.isFileURL == true && isOurs(web.url) }
        return hostedURL.map { WebOrigin.sameOrigin(scheme: origin.protocol, host: origin.host, port: origin.port, to: $0) } ?? false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if isOurs(url) || (navigationAction.targetFrame?.isMainFrame == false && url.absoluteString == "about:blank") {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated && ["https", "http", "tel"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageReady = false
        requestingFloorHeading = false
        indoorTracker.stop()
        overlayTransferTask?.cancel()
        sessionGeneration += 1
        stopDeviceActivity()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isOurs(web.url) else { return }
        timeout?.cancel()
        pageReady = true
        startLocationIfAllowed()
        syncSavedFloorOverlay(focus: false)
        refreshNotificationStatus()
        deliverAlert()
        openLaunchDemoIfReady()
        recordMapState()
    }

    func webView(_ webView:WKWebView,didCommit navigation:WKNavigation!) {
        // A real page arrived. Slow third-party map assets must not force a file:// fallback.
        if webView.url?.scheme == "https", isOurs(webView.url) { timeout?.cancel() }
    }

    private func recordMapState() {
        let expectedURL=web.url
        DispatchQueue.main.asyncAfter(deadline:.now()+8) { [weak self] in
            guard let self,self.pageReady,self.web.url==expectedURL,self.isOurs(self.web.url) else { return }
            self.web.evaluateJavaScript("({source:location.protocol==='file:'?'bundled':'hosted',provider:document.getElementById('map')?.dataset.mapProvider||'loading',sdkReady:!!window.google?.maps,online:navigator.onLine})") { value,_ in
                guard let value=value as? [String:Any],let data=try? JSONSerialization.data(withJSONObject:value),
                      let directory=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask).first else { return }
                // Provider/source only: never persist keys, request URLs, camera data or location.
                try? data.write(to:directory.appendingPathComponent("map-load-state.json"),options:[.atomic,.completeFileProtectionUnlessOpen])
                if value["source"] as? String == "hosted",value["provider"] as? String == "offline",
                   value["sdkReady"] as? Bool == true,value["online"] as? Bool == true,
                   !self.retriedLateMap,self.presentedViewController == nil {
                    // A late SDK can leave the earlier offline choice in place. Retry once, outside AR.
                    self.retriedLateMap=true;self.web.reloadFromOrigin()
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fallBack() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fallBack() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400 {
            decisionHandler(.cancel); fallBack()
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // WebKit can supply a nil frame request during camera authorization on physical iPhones.
        let ours = frame.isMainFrame && isOurs(webView.url) && origin.protocol == "https" && isOurs(origin)
        decisionHandler(ours && type == .camera ? .prompt : .deny)
    }

    private func openLaunchDemoIfReady() {
        guard launchObstacleDemo, pageReady, UIApplication.shared.applicationState == .active else { return }
        launchObstacleDemo = false
        startObstacleScan(exitDemo: true)
    }

    private func startObstacleScan(exitDemo: Bool = false, floorGoal: FloorARGoal? = nil) {
        guard presentedViewController == nil, UIApplication.shared.applicationState == .active else { return }
        let generation = sessionGeneration
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self, self.pageReady, generation == self.sessionGeneration, self.presentedViewController == nil, UIApplication.shared.applicationState == .active else { return }
                guard granted else {
                    self.call("contourObstacle", [["status": "unknown", "reason": "camera-denied"]])
                    if floorGoal != nil { self.showMessage("Allow camera access in Settings to open AR navigation.") }
                    return
                }
                let report: (String, String) -> Void = { [weak self] status, reason in
                    guard let self, generation == self.sessionGeneration else { return }
                    self.call("contourObstacle", [["status": status, "reason": reason, "source": "ios-native"]])
                }
                if let floorGoal {
                    let scanner = IndoorDestinationScanViewController()
                    scanner.floorGoal = floorGoal
                    scanner.indoorTracker = self.indoorTracker
                    scanner.modalPresentationStyle = .fullScreen
                    scanner.completion = report
                    self.indoorScanner = scanner
                    self.present(scanner, animated: true)
                } else {
                    let scanner = ObstacleScanViewController()
                    scanner.exitDemo = exitDemo
                    scanner.indoorTracker = self.indoorTracker
                    scanner.modalPresentationStyle = .fullScreen
                    scanner.completion = report
                    self.obstacleScanner = scanner
                    self.present(scanner, animated: true)
                }
            }
        }
    }

    private func call(_ name: String, _ arguments: [Any]) {
        guard pageReady, isOurs(web.url), let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window[\"\(name)\"] && window[\"\(name)\"].apply(null, \(json))", completionHandler: nil)
    }

    func presentAlert(_ alert: ContourAlert) {
        DispatchQueue.main.async { [weak self] in self?.pendingAlert = alert; self?.deliverAlert() }
    }

    private func deliverAlert() {
        guard pageReady, let alert = pendingAlert else { return }
        pendingAlert = nil
        guard isOurs(web.url), let data = try? JSONSerialization.data(withJSONObject: alert.payload),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("typeof window.contourAlert === 'function' && window.contourAlert(\(json))") { [weak self] result, error in
            if error == nil, result as? Bool == true, UIApplication.shared.applicationState == .active {
                self?.haptics.start()
            }
        }
    }

    func resumeDeviceActivity() {
        openLaunchDemoIfReady()
        startLocationIfAllowed()
        if requestingFloorHeading && CLLocationManager.headingAvailable() { location.startUpdatingHeading() }
        refreshNotificationStatus()
    }

    func refreshNotificationStatus() {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                self?.notificationStatus = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
                self?.call("contourIOSNotificationStatus", [self?.notificationStatus ?? false])
            }
        }
    }

    private func enableNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] _, _ in self?.refreshNotificationStatus() }
    }

    private func testAlert(_ delay: Double) {
        let content = UNMutableNotificationContent()
        content.title = "Contour earthquake test"
        content.body = "Test only. Protect your head during strong shaking."
        content.sound = .default
        content.userInfo = ["kind": "eew", "title": content.title, "text": content.body]
        let request = UNNotificationRequest(identifier: "contour-earthquake-test", content: content,
                                            trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, min(delay, 60)), repeats: false))
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
            guard granted else {
                DispatchQueue.main.async {
                    if let alert = ContourAlert(payload: content.userInfo) { self?.presentAlert(alert) }
                }
                return
            }
            UNUserNotificationCenter.current().add(request) { [weak self] error in
                if error != nil { DispatchQueue.main.async { self?.showMessage("Could not schedule the test notification.") } }
            }
            self?.refreshNotificationStatus()
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, isOurs(message.frameInfo.securityOrigin), isOurs(web.url),
              let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "openFloorOverlay": openFloorOverlay()
        case "openWalkingConnections": presentFloorOverlay(showWalkingConnections: true)
        case "planLandmarkRoute":
            guard let request = body["request"] as? [String: Any],
                  let requestID = request["requestID"] as? String, !requestID.isEmpty, requestID.count <= 80,
                  let startID = request["startID"] as? String, let start = UUID(uuidString: startID),
                  let destinationID = request["destinationID"] as? String, let destination = UUID(uuidString: destinationID),
                  let floor = request["floor"] as? String, ["B1", "1F", "2F", "3F", "4F"].contains(floor),
                  let revision = request["routingRevision"] as? String, revision.count == 64 else { return }
            let generation = sessionGeneration
            Task { [weak self] in
                do {
                    let route = try await OverlayDisk.shared.landmarkRoute(start: start, destination: destination, floor: floor, revision: revision)
                    guard let self, self.pageReady, generation == self.sessionGeneration else { return }
                    let data = try JSONEncoder().encode(route)
                    guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                    object["requestID"] = requestID
                    self.call("contourIOSLandmarkRoute", [object])
                } catch {
                    guard let self, self.pageReady, generation == self.sessionGeneration else { return }
                    self.call("contourIOSLandmarkRoute", [["requestID": requestID, "status": "error", "floor": floor,
                        "routingRevision": revision, "message": "The saved floor map could not be read. Reopen Floor Maps and try again."]])
                }
            }
        case "startLibraryExitAR": startObstacleScan(exitDemo: true)
        case "startObstacleScan": startObstacleScan()
        case "startIndoorTracking":
            guard let request = body["request"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: request),
                  let config = try? JSONDecoder().decode(IndoorStepRequest.self, from: data), config.isValid else { return }
            indoorTracker.start(config)
        case "pauseIndoorTracking": indoorTracker.pause()
        case "clearIndoorTracking": indoorTracker.stop()
        case "startFloorAR":
            guard let payload = body["goal"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let goal = try? JSONDecoder().decode(FloorARGoal.self, from: data), goal.isValid else {
                showMessage("Choose a destination and confirm your starting position before opening AR.")
                return
            }
            guard let pose = indoorTracker.pose, pose.sessionID == goal.trackingID, pose.floor == goal.floor,
                  pose.status == "tracking", abs(Date().timeIntervalSince1970 * 1000 - pose.timestamp) < 2000 else {
                showMessage("Set your starting position and allow Motion & Fitness access before opening indoor AR.")
                return
            }
            startObstacleScan(floorGoal: goal)
        case "stopObstacleScan":
            obstacleScanner?.pause(); obstacleScanner?.dismiss(animated: false)
            indoorScanner?.pause(); indoorScanner?.dismiss(animated: false)
        case "floorHeadingStart":
            requestingFloorHeading = true
            if CLLocationManager.headingAvailable() { location.startUpdatingHeading() }
        case "floorHeadingStop": requestingFloorHeading = false; location.stopUpdatingHeading()
        case "locationStart":
            requestingLocation = true
            location.requestWhenInUseAuthorization()
            startLocationIfAllowed()
        case "locationStop": requestingLocation = false; location.stopUpdatingLocation()
        case "notifications": enableNotifications()
        case "notificationStatus": refreshNotificationStatus()
        case "settings":
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        case "testAlert": testAlert(Double(body["delayMs"] as? Int ?? 5000) / 1000)
        case "stopHaptics": haptics.stop()
        case "startListening": startSpeech(body["language"] as? String ?? "en-US")
        case "stopListening": stopSpeech()
        default: break
        }
    }

    private func startLocationIfAllowed() {
        guard requestingLocation else { return }
        switch location.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            location.startUpdatingLocation()
            // A location can arrive before WebKit finishes loading. Replay a fresh real fix once callbacks are ready.
            if let fix = location.location { locationManager(location, didUpdateLocations: [fix]) }
        case .denied, .restricted: call("contourIOSLocationError", [1, "Location permission denied."])
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading heading: CLHeading) {
        guard requestingFloorHeading, heading.headingAccuracy >= 0 else { return }
        let degrees = heading.trueHeading >= 0 ? heading.trueHeading : heading.magneticHeading
        call("contourIOSHeading", [["degrees": degrees, "accuracy": heading.headingAccuracy,
                                   "timestamp": heading.timestamp.timeIntervalSince1970 * 1000]])
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { startLocationIfAllowed() }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix = locations.last, fix.horizontalAccuracy >= 0, abs(fix.timestamp.timeIntervalSinceNow) <= 30 else { return }
        call("contourIOSLocation", [["timestamp": fix.timestamp.timeIntervalSince1970 * 1000,
                                    "coords": ["latitude": fix.coordinate.latitude, "longitude": fix.coordinate.longitude,
                                               "accuracy": fix.horizontalAccuracy, "altitude": fix.altitude,
                                               "altitudeAccuracy": fix.verticalAccuracy >= 0 ? fix.verticalAccuracy as Any : NSNull(),
                                               "heading": fix.course >= 0 ? fix.course as Any : NSNull(),
                                               "speed": fix.speed >= 0 ? fix.speed as Any : NSNull()]]])
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        call("contourIOSLocationError", [2, "Location is temporarily unavailable."])
    }

    private func startSpeech(_ language: String) {
        stopSpeech()
        let generation = sessionGeneration
        let speech = speechGeneration
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            AVAudioSession.sharedInstance().requestRecordPermission { allowed in
                DispatchQueue.main.async {
                    guard let self, generation == self.sessionGeneration, speech == self.speechGeneration, self.pageReady else { return }
                    guard status == .authorized, allowed else { self.call("onSpeechError", [9]); return }
                    self.beginSpeech(language)
                }
            }
        }
    }

    private func beginSpeech(_ language: String) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else { call("onSpeechError", [12]); return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
            speechRequest = request
            let input = audio.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in request.append(buffer) }
            microphoneTapInstalled = true
            audio.prepare()
            try audio.start()
            let speech = speechGeneration
            speechTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                DispatchQueue.main.async {
                    guard let self, speech == self.speechGeneration else { return }
                    if let result { self.call(result.isFinal ? "onSpeechFinal" : "onSpeechPartial", [result.bestTranscription.formattedString]) }
                    if error != nil { self.call("onSpeechError", [5]) }
                    if error != nil || result?.isFinal == true { self.stopSpeech() }
                }
            }
        } catch { stopSpeech(); call("onSpeechError", [3]) }
    }

    private func stopSpeech() {
        speechGeneration += 1
        audio.stop()
        if microphoneTapInstalled { audio.inputNode.removeTap(onBus: 0); microphoneTapInstalled = false }
        speechRequest?.endAudio()
        speechTask?.cancel()
        speechRequest = nil
        speechTask = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func stopDeviceActivity() {
        obstacleScanner?.pause()
        indoorScanner?.pause()
        sessionGeneration += 1
        haptics.stop()
        stopSpeech()
        location.stopUpdatingLocation()
        location.stopUpdatingHeading()
    }

    private func showMessage(_ text: String) {
        let alert = UIAlertController(title: "SEA", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}
