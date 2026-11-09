import SwiftUI
import MapKit
import PhotosUI
import UniformTypeIdentifiers
import ImageIO
import Vision
import CryptoKit
import ContourShared

private enum NativeOverlayError: Error { case invalid }

actor OverlayDisk {
    static let shared = OverlayDisk()
    private var file: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Contour/geographic-overlay.json")
    }
    func load() throws -> GeographicOverlay? {
        let source: URL
        if FileManager.default.fileExists(atPath: file.path) { source = file }
        else if let bundled = Bundle.main.url(forResource: "default-floor-overlay", withExtension: "json") { source = bundled }
        else { return nil }
        let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 18_000_000 else { throw NativeOverlayError.invalid }
        var value = try JSONDecoder().decode(GeographicOverlay.self, from: Data(contentsOf: source))
        guard value.isValid else { throw NativeOverlayError.invalid }
        if let pins = value.destinations { value.destinations = FloorLabelDeduplicator.deduplicate(pins) }
        return value
    }
    func json() throws -> String {
        guard let value = try load() else { return "null" }
        let data = try JSONEncoder().encode(value)
        guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeOverlayError.invalid }
        let digest = SHA256.hash(data: value.image).map { String(format: "%02x", $0) }.joined()
        object["libraryReferenceImage"] = value.floorName == "2F" && digest == LibraryExitGeometry.shared.imageSha256
        return String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }
    func save(_ value: GeographicOverlay) throws {
        guard value.isValid else { throw NativeOverlayError.invalid }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(value).write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
    }
    /// Downsample and normalize EXIF orientation before passing image data to the UI.
    func prepare(_ data: Data, name: String, center: CLLocationCoordinate2D) throws -> GeographicOverlay {
        guard data.count <= 20_000_000,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048
              ] as CFDictionary),
              let png = UIImage(cgImage: thumbnail).pngData() else { throw NativeOverlayError.invalid }
        let aspect = Double(thumbnail.height) / Double(thumbnail.width)
        let value = GeographicOverlay(name: String(name.prefix(80)), image: png,
            latitude: center.latitude, longitude: center.longitude, width: min(60, 2000 / aspect), aspect: aspect)
        guard value.isValid else { throw NativeOverlayError.invalid }
        return value
    }
    /// Vision runs on the disk actor, not the UI thread; no image leaves the device.
    func detectLabels(_ data: Data) throws -> [FloorDestination] {
        try Task.checkCancellation()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.automaticallyDetectsLanguage = true
        let supported = try request.supportedRecognitionLanguages()
        request.recognitionLanguages = ["en-US", "ja-JP"].filter { supported.contains($0) }
        request.minimumTextHeight = 0.004
        try VNImageRequestHandler(data: data, orientation: .up).perform([request])
        try Task.checkCancellation()
        let raw: [FloorDestination] = (request.results ?? []).compactMap { observation in
            guard let text = observation.topCandidates(1).first, text.confidence >= 0.25 else { return nil }
            return FloorDestination.recognized(name: text.string, boundingBox: observation.boundingBox, confidence: text.confidence)
        }
        return Array(FloorLabelDeduplicator.deduplicate(raw).prefix(120))
    }
    func read(_ url: URL) throws -> Data {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 20_000_000 else { throw NativeOverlayError.invalid }
        return try Data(contentsOf: url)
    }
}

@MainActor
private final class NativeOverlayStore: ObservableObject {
    @Published var saved: GeographicOverlay?
    @Published var draft: GeographicOverlay?
    @Published var busy = true
    @Published var message = "Loading saved floor plan…"
    @Published var focusID = UUID()
    @Published var review: [FloorDestination]?
    private let disk = OverlayDisk.shared
    var value: GeographicOverlay? { draft ?? saved }
    init() {
        Task {
            do {
                saved = try await disk.load()
                if let value = saved, UIImage(data: value.image) == nil { throw NativeOverlayError.invalid }
                message = saved == nil ? "Pan to your building, then import a floor plan." : "Saved floor plan loaded."
                focusID = UUID()
            } catch { saved = nil; message = "Saved overlay could not be opened. Import an image to recover." }
            busy = false
        }
    }
    func detectLabels() async {
        guard let value, !busy else { return }
        busy = true; message = "Detecting labels on this iPhone…"
        defer { busy = false }
        do {
            let detected = try await disk.detectLabels(value.image)
            let pins = FloorLabelDeduplicator.merge(existing: value.destinations ?? [], detected: detected)
            review = pins
            message = detected.isEmpty ? "No readable labels found. You can add pins manually in review." : "Review the suggested labels before saving."
        } catch is CancellationError { message = "Label detection cancelled." }
        catch { message = "Text recognition failed. Try a clearer image, or review/add pins manually." }
    }
    func applyDestinations(_ pins: [FloorDestination]) async {
        guard var value, !busy else { return }
        value.destinations = pins
        guard value.isValid else { message = "Check pin names and positions before saving."; return }
        let wasEditing = draft != nil
        draft = value; review = nil
        if wasEditing { message = "Pins updated. Save alignment to keep these changes." }
        else { await save() }
    }
    func edit() { draft = saved; message = "Editing alignment. Save to keep your changes." }
    func cancel() { draft = nil; message = "Edits discarded. Saved alignment restored." }
    func save() async {
        guard let draft, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await disk.save(draft)
            saved = draft; self.draft = nil; message = "Alignment saved on this iPhone."
            NotificationCenter.default.post(name: NativeFloorOverlayTransfer.savedNotification, object: nil)
        } catch { message = "Could not save. Your edits are still open. Check available storage and retry." }
    }
    func toggleVisibility() async {
        guard var value = saved, !busy else { return }
        value.visible.toggle(); busy = true
        defer { busy = false }
        do { try await disk.save(value); saved = value; NotificationCenter.default.post(name: NativeFloorOverlayTransfer.savedNotification, object: nil); message = value.visible ? "Overlay shown." : "Overlay hidden." }
        catch { message = "Visibility could not be saved. Please retry." }
    }
    func importPhoto(_ item: PhotosPickerItem, center: CLLocationCoordinate2D) async {
        guard !busy, draft == nil else { return }
        busy = true
        defer { busy = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { throw NativeOverlayError.invalid }
            draft = try await disk.prepare(data, name: "Floor plan", center: center)
            focusID = UUID(); message = "Move, pinch, or rotate the image. Save when aligned."
        } catch { message = "Could not import this photo. Choose a smaller image (up to 20 MB)." }
    }
    func importFile(_ url: URL, center: CLLocationCoordinate2D) async {
        guard !busy, draft == nil else { return }
        busy = true
        defer { busy = false }
        do {
            let data = try await disk.read(url)
            draft = try await disk.prepare(data, name: url.deletingPathExtension().lastPathComponent, center: center)
            focusID = UUID(); message = "Move, pinch, or rotate the image. Save when aligned."
        } catch { message = "Could not import this file. Choose an image up to 20 MB." }
    }
}

@available(iOS 17.0, *)
struct NativeFloorOverlay: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = NativeOverlayStore()
    @State private var photo: PhotosPickerItem?
    @State private var showFiles = false
    @State private var controls = true
    @State private var panelCollapsed = false
    @GestureState private var panelDrag: CGFloat = 0
    @State private var movePlan = true
    @State private var center = CLLocationCoordinate2D(latitude: 35.1545, longitude: 136.9645)

    private var displayValue: GeographicOverlay? {
        guard var value = store.value else { return nil }
        if store.draft != nil { value.visible = true }
        return value
    }
    private func binding<T>(_ key: WritableKeyPath<GeographicOverlay, T>, fallback: T) -> Binding<T> {
        Binding(get: { store.draft?[keyPath: key] ?? fallback }, set: { store.draft?[keyPath: key] = $0 })
    }
    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ZStack(alignment: .bottom) {
                    GeographicOverlayMap(value: displayValue, editing: store.draft != nil && movePlan && !store.busy,
                        focusID: store.focusID, center: $center) { value in
                            if store.draft != nil && !store.busy { store.draft = value }
                        }
                        .ignoresSafeArea(edges: .bottom)
                    if controls {
                        parameterPanel(maximumHeight: min(store.draft == nil ? 260 : 410, max(140, geometry.size.height * 0.65)))
                            .padding()
                    }
                }
            }
            .navigationTitle("Floor overlay").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button("Standard") { NotificationCenter.default.post(name: .overlayMapStyle, object: MKMapType.standard.rawValue) }
                        Button("Satellite") { NotificationCenter.default.post(name: .overlayMapStyle, object: MKMapType.satellite.rawValue) }
                    } label: { Label("Base map", systemImage: "map") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(controls ? "Hide controls" : "Controls") {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                            controls.toggle()
                            if controls { panelCollapsed = false }
                        }
                    }
                }
            }
            .sheet(isPresented: Binding(get: { store.review != nil }, set: { if !$0 { store.review = nil } })) {
                if let pins = store.review, let value = store.value, let image = UIImage(data: value.image) {
                    FloorDestinationReview(image: image, initial: pins) { pins in
                        Task { await store.applyDestinations(pins) }
                    }
                }
            }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image]) { result in
                switch result {
                case .success(let url): Task { await store.importFile(url, center: center) }
                case .failure: store.message = "File import cancelled or unavailable."
                }
            }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                Task { await store.importPhoto(item, center: center); photo = nil; movePlan = true }
            }
        }
    }
    private func setPanelCollapsed(_ collapsed: Bool) {
        if collapsed { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { panelCollapsed = collapsed }
    }
    private func parameterPanel(maximumHeight: CGFloat) -> some View {
        let minimumHeight: CGFloat = 58
        let restingHeight = panelCollapsed ? minimumHeight : maximumHeight
        let height = min(maximumHeight, max(minimumHeight, restingHeight - panelDrag))
        return VStack(spacing: 0) {
            VStack(spacing: 5) {
                Capsule().fill(.secondary.opacity(0.5)).frame(width: 40, height: 5)
                HStack {
                    Text(panelCollapsed ? "Show parameters" : "Alignment parameters").font(.subheadline.weight(.semibold))
                    Spacer()
                    Image(systemName: panelCollapsed ? "chevron.up" : "chevron.down").font(.caption.weight(.semibold))
                }
            }
            .padding(.horizontal, 16).padding(.top, 9).padding(.bottom, 10)
            .frame(maxWidth: .infinity).contentShape(Rectangle())
            .accessibilityIdentifier("overlayControlsHandle")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(panelCollapsed ? "Show alignment parameters" : "Collapse alignment parameters")
            .accessibilityHint("Drag down to reveal more of the map, or drag up to expand")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { setPanelCollapsed(!panelCollapsed) }
            .accessibilityAdjustableAction { direction in
                if direction == .increment { setPanelCollapsed(false) }
                else if direction == .decrement { setPanelCollapsed(true) }
            }
            .onTapGesture { setPanelCollapsed(!panelCollapsed) }
            .simultaneousGesture(DragGesture(minimumDistance: 5)
                .updating($panelDrag) { value, state, _ in state = value.translation.height }
                .onEnded { value in
                    let projectedHeight = restingHeight - value.predictedEndTranslation.height
                    setPanelCollapsed(projectedHeight < (minimumHeight + maximumHeight) / 2)
                })
            if height > minimumHeight + 10 {
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if store.draft != nil { editControls }
                        else {
                            HStack {
                                PhotosPicker(selection: $photo, matching: .images) { Label("Photos", systemImage: "photo") }
                                Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
                            }
                            if let saved = store.saved {
                                Text(saved.name).font(.headline)
                                destinationControls
                                HStack {
                                    Button("Edit alignment") { store.edit(); movePlan = true }
                                    Button(saved.visible ? "Hide" : "Show") { Task { await store.toggleVisibility() } }
                                    Button("Find") { store.focusID = UUID() }
                                }
                            }
                        }
                        Text(store.message).font(.footnote).accessibilityIdentifier("overlayStatus")
                        if store.busy { ProgressView() }
                    }.padding().disabled(store.busy)
                }
            }
        }
        .frame(height: height, alignment: .top)
        .clipped()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
    private var destinationControls: some View {
        HStack {
            Button { Task { await store.detectLabels() } } label: { Label("Detect labels", systemImage: "text.viewfinder") }
                .accessibilityIdentifier("detectFloorLabels")
            Button("Review pins (\(store.value?.destinations?.count ?? 0))") { store.review = store.value?.destinations ?? [] }
        }
    }
    private var editControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Floor / name", text: binding(\.name, fallback: ""))
                .textFieldStyle(.roundedBorder).onChange(of: store.draft?.name) { _, name in
                    if let name, name.count > 80 { store.draft?.name = String(name.prefix(80)) }
                }
            Picker("Floor", selection: Binding(get: { store.draft?.floorName ?? "2F" }, set: { store.draft?.floor = $0 })) {
                ForEach(["B1", "1F", "2F", "3F", "4F"], id: \.self) { Text($0).tag($0) }
            }
            destinationControls
            Picker("Gesture target", selection: $movePlan) {
                Text("Move plan").tag(true); Text("Move map").tag(false)
            }.pickerStyle(.segmented)
            Text(movePlan ? "Drag the background to pan the map. Drag the plan to move it. Drag a corner icon to resize; twist two fingers to rotate." : "Pan and zoom the base map. The plan stays fixed geographically.")
                .font(.caption)
            HStack {
                Text("Rotation")
                TextField("Degrees", value: binding(\.angle, fallback: 0), format: .number.precision(.fractionLength(0...1)))
                    .keyboardType(.numbersAndPunctuation).textFieldStyle(.roundedBorder)
                Stepper("Rotate", onIncrement: { store.draft?.rotate(to: (store.draft?.angle ?? 0) + 1) },
                    onDecrement: { store.draft?.rotate(to: (store.draft?.angle ?? 0) - 1) }).labelsHidden()
            }
            HStack {
                Text("Width (m)")
                TextField("Metres", value: Binding(get: { store.draft?.width ?? 60 }, set: { store.draft?.resize(to: $0) }), format: .number.precision(.fractionLength(0...1)))
                    .keyboardType(.decimalPad).textFieldStyle(.roundedBorder)
                Button("−") { store.draft?.resize(to: (store.draft?.width ?? 60) - 0.5) }.accessibilityLabel("Shrink half a metre")
                Button("+") { store.draft?.resize(to: (store.draft?.width ?? 60) + 0.5) }.accessibilityLabel("Grow half a metre")
            }
            HStack {
                Text("Nudge 0.5 m").font(.caption)
                Button("↑") { store.draft?.nudge(east: 0, north: 0.5) }.accessibilityLabel("Move north")
                Button("←") { store.draft?.nudge(east: -0.5, north: 0) }.accessibilityLabel("Move west")
                Button("↓") { store.draft?.nudge(east: 0, north: -0.5) }.accessibilityLabel("Move south")
                Button("→") { store.draft?.nudge(east: 0.5, north: 0) }.accessibilityLabel("Move east")
            }
            HStack { Text("Opacity"); Slider(value: binding(\.opacity, fallback: 0.65), in: 0.1...1) }
            HStack {
                Button("Save alignment") { Task { await store.save() } }.buttonStyle(.borderedProminent)
                Button("Cancel", role: .cancel) { store.cancel() }
            }
        }
    }
}

private extension Notification.Name { static let overlayMapStyle = Notification.Name("ContourOverlayMapStyle") }

/// A native, north-up MapKit map with a geographically sized image view.
/// Sibling map/image views let background map gestures remain active during editing.
struct GeographicOverlayMap: UIViewRepresentable {
    var value: GeographicOverlay?
    var editing: Bool
    var focusID: UUID
    @Binding var center: CLLocationCoordinate2D
    var changed: (GeographicOverlay) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        let map = MKMapView()
        map.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(map)
        NSLayoutConstraint.activate([
            map.leadingAnchor.constraint(equalTo: container.leadingAnchor), map.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            map.topAnchor.constraint(equalTo: container.topAnchor), map.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        map.isRotateEnabled = false; map.isPitchEnabled = false
        map.delegate = context.coordinator
        map.setRegion(MKCoordinateRegion(center: center, latitudinalMeters: 400, longitudinalMeters: 400), animated: false)
        let image = context.coordinator.image
        // Sibling views keep image gestures out of MapKit's ancestor gesture chain.
        container.addSubview(image)
        context.coordinator.container = container
        for index in 0..<4 {
            let handle = UIButton(type: .custom)
            handle.tag = index
            handle.setImage(UIImage(systemName: "arrow.up.left.and.arrow.down.right"), for: .normal)
            handle.tintColor = .white; handle.backgroundColor = .systemGreen
            handle.layer.cornerRadius = 22; handle.layer.borderWidth = 2; handle.layer.borderColor = UIColor.white.cgColor
            handle.layer.shadowOpacity = 0.2; handle.layer.shadowRadius = 3
            handle.accessibilityLabel = "Resize floor plan, " + ["top left", "top right", "bottom left", "bottom right"][index]
            handle.accessibilityIdentifier = "overlayResizeCorner\(index)"
            handle.addGestureRecognizer(UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.resizeCorner(_:))))
            container.addSubview(handle)
            context.coordinator.handles.append(handle)
        }
        for gesture in [UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pan(_:))),
                        UIPinchGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pinch(_:))),
                        UIRotationGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.rotate(_:)))] {
            gesture.delegate = context.coordinator; image.addGestureRecognizer(gesture)
        }
        context.coordinator.map = map
        return container
    }
    func updateUIView(_ container: UIView, context: Context) {
        let c = context.coordinator; c.parent = self
        guard let map = c.map else { return }
        map.isScrollEnabled = true; map.isZoomEnabled = true
        if c.lastImage != value?.image {
            c.lastImage = value?.image; c.image.image = value.flatMap { UIImage(data: $0.image) }
        }
        if c.focusID != focusID {
            c.focusID = focusID
            if let v = value {
                map.setRegion(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: v.latitude, longitude: v.longitude),
                    latitudinalMeters: max(100, hypot(v.width, v.height) * 2), longitudinalMeters: max(100, hypot(v.width, v.height) * 2)), animated: false)
            }
        }
        c.render()
    }
    static func dismantleUIView(_ container: UIView, coordinator: Coordinator) {
        coordinator.map?.delegate = nil; coordinator.image.removeFromSuperview()
        coordinator.handles.forEach { $0.removeFromSuperview() }
        coordinator.pinButtons.values.forEach { $0.removeFromSuperview() }
    }
    final class Coordinator: NSObject, MKMapViewDelegate, UIGestureRecognizerDelegate {
        var parent: GeographicOverlayMap
        weak var map: MKMapView?
        weak var container: UIView?
        var handles: [UIButton] = []
        var pinButtons: [UUID: UIButton] = [:]
        let corners = [CGPoint(x: -1, y: -1), CGPoint(x: 1, y: -1), CGPoint(x: -1, y: 1), CGPoint(x: 1, y: 1)]
        var resizeStart: (value: GeographicOverlay, center: CGPoint, width: Double)?
        let image = UIImageView()
        var lastImage: Data?
        var focusID: UUID?
        var panStart: CGPoint?
        var observer: NSObjectProtocol?
        init(_ parent: GeographicOverlayMap) {
            self.parent = parent
            super.init()
            image.contentMode = .scaleToFill
            image.accessibilityLabel = "Floor plan overlay"
            observer = NotificationCenter.default.addObserver(forName: .overlayMapStyle, object: nil, queue: .main) { [weak self] note in
                if let raw = note.object as? UInt, let type = MKMapType(rawValue: raw) { self?.map?.mapType = type }
            }
        }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
        func render() {
            guard let map, let v = parent.value, v.isValid else {
                image.isHidden = true; handles.forEach { $0.isHidden = true }; pinButtons.values.forEach { $0.isHidden = true }; return
            }
            image.isHidden = !v.visible && !parent.editing
            let coordinate = CLLocationCoordinate2D(latitude: v.latitude, longitude: v.longitude)
            let p = MKMapPoint(coordinate)
            let edge = MKMapPoint(x: p.x + v.width * MKMapPointsPerMeterAtLatitude(v.latitude), y: p.y).coordinate
            let a = map.convert(coordinate, toPointTo: map), b = map.convert(edge, toPointTo: map)
            let width = hypot(b.x - a.x, b.y - a.y)
            image.bounds = CGRect(x: 0, y: 0, width: width, height: width * v.aspect)
            image.center = a; image.transform = CGAffineTransform(rotationAngle: v.angle * .pi / 180)
            image.alpha = v.opacity; image.isUserInteractionEnabled = parent.editing
            image.layer.borderWidth = parent.editing ? 2 : 0; image.layer.borderColor = UIColor.systemGreen.cgColor
            let pins = v.destinations ?? []
            let ids = Set(pins.map(\.id))
            for id in Array(pinButtons.keys) where !ids.contains(id) { pinButtons.removeValue(forKey: id)?.removeFromSuperview() }
            for (index, pin) in pins.enumerated() {
                let button: UIButton
                if let existing = pinButtons[pin.id] { button = existing }
                else {
                    button = UIButton(type: .system)
                    button.backgroundColor = .systemBlue; button.tintColor = .white; button.layer.cornerRadius = 16
                    button.isUserInteractionEnabled = false
                    container?.addSubview(button); pinButtons[pin.id] = button
                }
                button.setTitle("\(index + 1)", for: .normal)
                button.accessibilityLabel = pin.name
                button.bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
                button.center = image.convert(CGPoint(x: pin.x * image.bounds.width, y: pin.y * image.bounds.height), to: container)
                button.isHidden = image.isHidden
            }
            for (index, handle) in handles.enumerated() {
                let corner = corners[index]
                handle.bounds = CGRect(x: 0, y: 0, width: 44, height: 44)
                handle.center = image.convert(CGPoint(x: corner.x < 0 ? 0 : image.bounds.width,
                    y: corner.y < 0 ? 0 : image.bounds.height), to: container)
                handle.transform = CGAffineTransform(rotationAngle: v.angle * .pi / 180 + ([1, 2].contains(index) ? .pi / 2 : 0))
                handle.isHidden = !parent.editing || image.isHidden
            }
        }
        func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) { render() }
        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            render()
            let coordinate = mapView.centerCoordinate
            DispatchQueue.main.async { [weak self] in self?.parent.center = coordinate }
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            // Incremental pinch/twist updates compose without resetting translation.
            gestureRecognizer is UIPinchGestureRecognizer && other is UIRotationGestureRecognizer ||
            gestureRecognizer is UIRotationGestureRecognizer && other is UIPinchGestureRecognizer
        }
        private func apply(_ value: GeographicOverlay) {
            parent.value = value
            parent.changed(value)
            render()
        }
        @objc func resizeCorner(_ gesture: UIPanGestureRecognizer) {
            guard parent.editing, let value = parent.value, let map, let container,
                  let index = gesture.view?.tag, corners.indices.contains(index) else { return }
            if gesture.state == .began {
                resizeStart = (value, image.center, Double(image.bounds.width))
            }
            if gesture.state == .changed, let start = resizeStart, start.width > 0 {
                let pixelsPerMetre = start.width / start.value.width
                let result = OverlayCornerGeometry.resize(center: start.center, width: start.width,
                    aspect: start.value.aspect, angle: start.value.angle, corner: corners[index],
                    translation: gesture.translation(in: container), minimumWidth: pixelsPerMetre,
                    maximumWidth: start.value.maximumWidth * pixelsPerMetre)
                var updated = start.value
                updated.resize(to: result.width / pixelsPerMetre)
                let coordinate = map.convert(result.center, toCoordinateFrom: container)
                updated.latitude = coordinate.latitude; updated.longitude = coordinate.longitude
                if updated.isValid { apply(updated) }
            }
            if gesture.state == .cancelled || gesture.state == .failed {
                if let start = resizeStart { apply(start.value) }
            }
            if [.ended, .cancelled, .failed].contains(gesture.state) { resizeStart = nil }
        }
        @objc func pan(_ gesture: UIPanGestureRecognizer) {
            guard parent.editing, var v = parent.value, let map else { return }
            if gesture.state == .began { panStart = map.convert(CLLocationCoordinate2D(latitude: v.latitude, longitude: v.longitude), toPointTo: map) }
            if let start = panStart, gesture.state == .changed {
                let d = gesture.translation(in: map)
                let ll = map.convert(CGPoint(x: start.x + d.x, y: start.y + d.y), toCoordinateFrom: map)
                v.latitude = min(84.9, max(-84.9, ll.latitude)); v.longitude = ll.longitude
                apply(v)
            }
            if [.ended, .cancelled, .failed].contains(gesture.state) { panStart = nil }
        }
        @objc func pinch(_ gesture: UIPinchGestureRecognizer) {
            guard parent.editing, var v = parent.value else { return }
            v.resize(to: v.width * gesture.scale); gesture.scale = 1; apply(v)
        }
        @objc func rotate(_ gesture: UIRotationGestureRecognizer) {
            guard parent.editing, var v = parent.value else { return }
            v.rotate(to: v.angle + gesture.rotation * 180 / .pi); gesture.rotation = 0; apply(v)
        }
    }
}

/// Transfers the saved local image/alignment to the trusted Contour page; no backend upload.
enum NativeFloorOverlayTransfer {
    static let savedNotification = Notification.Name("ContourNativeFloorOverlaySaved")
    static func json() async throws -> String { try await OverlayDisk.shared.json() }
}

/// Review OCR against the original image; never publish unreviewed suggestions as destinations.
@available(iOS 17.0, *)
private struct FloorDestinationReview: View {
    @Environment(\.dismiss) private var dismiss
    let image: UIImage
    @State private var pins: [FloorDestination]
    @State private var included: Set<UUID>
    @State private var selected: UUID?
    let save: ([FloorDestination]) -> Void
    init(image: UIImage, initial: [FloorDestination], save: @escaping ([FloorDestination]) -> Void) {
        self.image = image; self.save = save
        _pins = State(initialValue: initial)
        _included = State(initialValue: Set(initial.map(\.id)))
        _selected = State(initialValue: initial.first?.id)
    }
    private var accepted: [FloorDestination] { pins.filter { included.contains($0.id) } }
    var body: some View {
        NavigationStack {
            VStack(spacing: 8) {
                Text("Select a numbered pin, then tap its correct spot on the image. Rename labels or uncheck unwanted text below.")
                    .font(.footnote).padding(.horizontal)
                GeometryReader { geometry in
                    let scale = min(geometry.size.width / image.size.width, geometry.size.height / image.size.height)
                    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                    Image(uiImage: image).resizable().frame(width: size.width, height: size.height)
                        .contentShape(Rectangle())
                        .onTapGesture { point in
                            guard let index = pins.firstIndex(where: { $0.id == selected }), size.width > 0, size.height > 0 else { return }
                            pins[index].x = min(1, max(0, point.x / size.width))
                            pins[index].y = min(1, max(0, point.y / size.height))
                            pins[index].textBounds = nil
                        }
                        .overlay(alignment: .topLeading) {
                            ForEach(Array(pins.enumerated()), id: \.element.id) { index, pin in
                                if included.contains(pin.id) {
                                    Button { selected = pin.id } label: {
                                        Text("\(index + 1)").font(.caption.bold()).foregroundStyle(.white)
                                            .padding(6).background(selected == pin.id ? Color.orange : Color.blue, in: Circle())
                                    }
                                    .accessibilityLabel("Select pin \(index + 1), \(pin.name)")
                                    .position(x: pin.x * size.width, y: pin.y * size.height)
                                }
                            }
                        }
                        .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
                }.frame(height: 270).padding(.horizontal)
                HStack {
                    Button("Add pin") {
                        let pin = FloorDestination(name: "New destination", x: 0.5, y: 0.5)
                        pins.append(pin); included.insert(pin.id); selected = pin.id
                    }.disabled(pins.count >= 120)
                    Spacer()
                    Button("Select all") { included = Set(pins.map(\.id)) }
                    Button("Clear") { included.removeAll() }
                }.padding(.horizontal)
                List {
                    if pins.isEmpty { Text("No labels detected. Tap Add pin to place one manually.") }
                    ForEach($pins) { $pin in
                        HStack {
                            Toggle("Include \(pin.name)", isOn: Binding(get: { included.contains(pin.id) }, set: {
                                if $0 { included.insert(pin.id) } else { included.remove(pin.id) }
                            })).labelsHidden()
                            Button("\((pins.firstIndex(where: { $0.id == pin.id }) ?? 0) + 1)") { selected = pin.id }
                                .buttonStyle(.bordered).tint(selected == pin.id ? .orange : .blue)
                            VStack(alignment: .leading) {
                                TextField("Destination name", text: $pin.name)
                                    .onChange(of: pin.name) { _, name in if name.count > 80 { pin.name = String(name.prefix(80)) } }
                                if let sources = pin.sourceLabels, sources.contains(where: { $0 != pin.name }) {
                                    Text(sources.filter { $0 != pin.name }.joined(separator: " · "))
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                Text("OCR confidence \(Int(pin.confidence * 100))% · verify on the plan")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }.onDelete { offsets in
                        for index in offsets { included.remove(pins[index].id) }
                        pins.remove(atOffsets: offsets)
                    }
                }
                Text("Pins mark printed labels, not verified entrances. They do not create paths around walls.")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            }
            .navigationTitle("Review destination pins").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save pins (\(accepted.count))") { save(accepted) }
                        .disabled(!accepted.allSatisfy(\.isValid))
                }
            }
            .interactiveDismissDisabled()
        }
    }
}
