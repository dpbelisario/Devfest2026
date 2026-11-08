import AVFoundation
import CoreLocation
import Speech
import UIKit
import UserNotifications
import WebKit

final class ContourViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, CLLocationManagerDelegate {
    private(set) var web: WKWebView!
    private let location = CLLocationManager()
    private let haptics = AlertHaptics()
    private let audio = AVAudioEngine()
    private weak var obstacleScanner: ObstacleScanViewController?
    private var speechTask: SFSpeechRecognitionTask?
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var pendingAlert: ContourAlert?
    private var pageReady = false
    private var usingFallback = false
    private var timeout: DispatchWorkItem?
    private var microphoneTapInstalled = false
    private var notificationStatus = false
    private var requestingLocation = false
    private var sessionGeneration = 0
    private var speechGeneration = 0
    private let hostedURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "ContourUIURL") as? String ?? "")
    private let bundledURL = Bundle.main.url(forResource: "contour", withExtension: "html")!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "contour")
        if let script = Bundle.main.url(forResource: "bridge", withExtension: "js"),
           let source = try? String(contentsOf: script, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
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
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        if let url = hostedURL, url.scheme == "https" {
            web.load(URLRequest(url: url))
            let task = DispatchWorkItem { [weak self] in self?.fallBack() }
            timeout = task
            DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: task)
        } else { fallBack() }
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
        sessionGeneration += 1
        stopDeviceActivity()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isOurs(web.url) else { return }
        timeout?.cancel()
        pageReady = true
        refreshNotificationStatus()
        deliverAlert()
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

    private func startObstacleScan() {
        guard presentedViewController == nil, UIApplication.shared.applicationState == .active else { return }
        let generation = sessionGeneration
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self, self.pageReady, generation == self.sessionGeneration, self.presentedViewController == nil, UIApplication.shared.applicationState == .active else { return }
                guard granted else { self.call("contourObstacle", [["status": "unknown", "reason": "camera-denied"]]); return }
                let scanner = ObstacleScanViewController()
                scanner.modalPresentationStyle = .fullScreen
                scanner.completion = { [weak self] status, reason in
                    guard let self, generation == self.sessionGeneration else { return }
                    self.call("contourObstacle", [["status": status, "reason": reason, "source": "ios-native"]])
                }
                self.obstacleScanner = scanner
                self.present(scanner, animated: true)
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
        startLocationIfAllowed()
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
        case "startObstacleScan": startObstacleScan()
        case "stopObstacleScan": obstacleScanner?.pause(); obstacleScanner?.dismiss(animated: false)
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
        case .authorizedWhenInUse, .authorizedAlways: location.startUpdatingLocation()
        case .denied, .restricted: call("contourIOSLocationError", [1, "Location permission denied."])
        default: break
        }
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
        sessionGeneration += 1
        haptics.stop()
        stopSpeech()
        location.stopUpdatingLocation()
    }

    private func showMessage(_ text: String) {
        let alert = UIAlertController(title: "Contour", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}
