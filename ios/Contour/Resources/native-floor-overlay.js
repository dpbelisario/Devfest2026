// iOS adapter: the saved image/alignment feeds the basemap and Floor Maps; destination pins belong only to Floor Maps.
(() => {
  let map = null;
  let provider = "leaflet";
  let layer = null;
  let pending = null;
  let hasPending = false;
  let focusPending = false;
  let hooked = false;
  let selectedID = null;
  let revision = 0;
  let imageURL = null;
  let floorUI = null;
  let floorObserver = null;
  let openedForSaved = false;
  let renderedRevision = -1;
  let startWatch = null;
  let startTimer = null;
  let startFix = null;
  let confirmedStart = null;
  let phoneHeading = null;
  let indoorPose = null;
  let trackingRequested = false;
  let stepLength = 0.72;
  let showWalls = false;
  let mapPinTarget = "start";
  let landmarkSelection = null;
  let landmarkRoute = null;
  let directionStep = 0;
  let landmarkRequest = null;
  let landmarkTimer = null;
  let landmarkVersion = 0;
  let automaticLandmarkKey = null;
  let automaticLandmarkTimer = null;
  function landmarkStartID() {
    return chosenStartID || confirmedStart?.id || null;
  }
  function landmarkKey() {
    return JSON.stringify([
      pending?.routingRevision || revision,
      floorUI?.floor.value,
      landmarkStartID(),
      selectedID,
    ]);
  }
  function clearLandmarkDirections() {
    clearTimeout(automaticLandmarkTimer);
    automaticLandmarkTimer = null;
    clearTimeout(landmarkTimer);
    landmarkTimer = null;
    landmarkRoute = null;
    directionStep = 0;
    landmarkRequest = null;
    landmarkVersion++;
  }
  function updateLandmarkDirections() {
    if (!floorUI) return;
    const ui = floorUI,
      key = landmarkKey();
    if (key !== landmarkSelection) {
      clearLandmarkDirections();
      landmarkSelection = key;
      automaticLandmarkKey = null;
    }
    const start = pending?.destinations?.find(
      (p) => p.id === landmarkStartID(),
    );
    const destination = pending?.destinations?.find((p) => p.id === selectedID);
    const active =
      !ui.root.hidden && ui.floor.value === (pending?.floor || "2F");
    ui.generateDirections.disabled =
      !active ||
      !start ||
      !destination ||
      !!landmarkRequest ||
      typeof window.ContourBridge?.planLandmarkRoute !== "function";
    ui.generateDirections.textContent = landmarkRequest
      ? "Finding route…"
      : "Recalculate route";
    if (!ui.generateDirections.disabled && automaticLandmarkKey !== key) {
      automaticLandmarkKey = key;
      automaticLandmarkTimer = setTimeout(() => {
        if (key === landmarkKey() && !ui.root.hidden && !landmarkRequest)
          generateLandmarkDirections();
      }, 120);
    }
    ui.directionsHint.textContent = !start
      ? "Choose your starting point above or tap a pin on the map."
      : !destination
        ? "Choose where you want to go."
        : "";
    ui.directionsSection.dataset.state = landmarkRequest
      ? "loading"
      : landmarkRoute?.status || "idle";
    if (ui.directionsVersion === landmarkVersion) return;
    ui.directionsVersion = landmarkVersion;
    ui.directionList.replaceChildren();
    ui.directionMessage.textContent = landmarkRequest
      ? "Finding a path between pins without crossing mapped walls…"
      : landmarkRoute?.message || "";
    for (const instruction of landmarkRoute?.instructions || []) {
      const item = document.createElement("li");
      item.textContent = instruction;
      ui.directionList.appendChild(item);
    }
    ui.directionSummary.textContent =
      landmarkRoute?.status === "ok"
        ? `${Math.max(0, landmarkRoute.landmarkIDs.length - 2)} intermediate pins · approximately ${Math.round(landmarkRoute.distance)} m. Blue line: route preview.`
        : "";
    updateDirectionStep();
    updateFloorMapSummary();
  }
  function updateDirectionStep() {
    if (!floorUI) return;
    const ui = floorUI;
    const count = directionStepCount();
    const complete = count > 0 && directionStep >= count;
    [...ui.directionList.children].forEach((item, index) => {
      item.hidden = complete || index !== directionStep;
    });
    ui.directionList.start = directionStep + 1;
    ui.stepProgress.hidden = !count;
    ui.stepProgress.textContent = complete
      ? "Destination reached — you confirmed arrival."
      : `Step ${directionStep + 1} of ${count}`;
    ui.arrived.hidden = !count || complete;
    ui.arrived.textContent =
      directionStep === count - 1
        ? "I've arrived at my destination"
        : "I've arrived — next step";
    ui.previousStep.hidden = !count || directionStep === 0;
  }
  function directionStepCount() {
    if (landmarkRoute?.status !== "ok") return 0;
    const instructions = landmarkRoute.instructions;
    // The planner appends a finish reminder after the last actual walking leg.
    return (
      instructions.length -
      (instructions.length > 1 && /^Finish at /.test(instructions.at(-1))
        ? 1
        : 0)
    );
  }
  function updateFloorMapSummary() {
    if (!floorUI?.routeMetric) return;
    const ui = floorUI,
      state = landmarkRequest ? "loading" : landmarkRoute?.status;
    ui.routeMetric.textContent =
      state === "ok"
        ? `~${Math.round(landmarkRoute.distance)} m`
        : state === "same-place"
          ? "Same location"
          : state === "loading"
            ? "Finding route…"
            : state === "needs-walls"
              ? "Set up floor walls"
              : state === "no-path"
                ? "No route found"
                : "Plan your route";
    ui.routeCaption.textContent =
      state === "ok"
        ? `${Math.max(0, landmarkRoute.landmarkIDs.length - 2)} intermediate stops · Floor ${pending?.floor || "2F"}`
        : "Choose a start and destination above";
    ui.showDirections.disabled = !landmarkRoute?.instructions?.length;
    ui.swap.disabled = !landmarkStartID() || !selectedID;
  }
  function setMapPinTarget(target) {
    mapPinTarget = target;
    if (!floorUI?.startField) return;
    floorUI.startField.classList.toggle(
      "contour-field-active",
      target === "start",
    );
    floorUI.destinationField.classList.toggle(
      "contour-field-active",
      target === "destination",
    );
    floorUI.startMode.setAttribute("aria-pressed", String(target === "start"));
    floorUI.destinationMode.setAttribute(
      "aria-pressed",
      String(target === "destination"),
    );
    floorUI.pinHint.textContent =
      target === "start"
        ? "Tap your location to set your start"
        : "Tap a pin to choose your destination";
    startRenderKey = null;
    renderStartSuggestion();
  }
  function generateLandmarkDirections() {
    updateLandmarkDirections();
    if (!floorUI || floorUI.generateDirections.disabled) return;
    clearLandmarkDirections();
    automaticLandmarkKey = landmarkKey();
    const requestID =
      window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    landmarkRequest = { requestID, key: landmarkKey() };
    landmarkTimer = setTimeout(() => {
      if (landmarkRequest?.requestID !== requestID) return;
      landmarkRequest = null;
      landmarkRoute = {
        status: "error",
        message:
          "Instructions could not be prepared. Try again or reopen Floor Maps.",
      };
      landmarkVersion++;
      updateLandmarkDirections();
    }, 15000);
    updateLandmarkDirections();
    window.ContourBridge.planLandmarkRoute({
      requestID,
      startID: landmarkStartID(),
      destinationID: selectedID,
      floor: pending.floor || "2F",
      routingRevision: pending.routingRevision || "",
    });
  }
  window.contourIOSLandmarkRoute = (value) => {
    if (
      !landmarkRequest ||
      value?.requestID !== landmarkRequest.requestID ||
      landmarkRequest.key !== landmarkKey() ||
      floorUI?.root.hidden ||
      value.floor !== (pending?.floor || "2F")
    )
      return;
    const statuses = [
      "ok",
      "same-place",
      "needs-connections",
      "needs-walls",
      "no-path",
      "invalid",
      "outdated",
      "error",
    ];
    if (
      !statuses.includes(value.status) ||
      typeof value.message !== "string" ||
      value.message.length > 600
    )
      return;
    if (
      value.status !== "outdated" &&
      value.routingRevision !== pending.routingRevision
    )
      return;
    if (["ok", "same-place"].includes(value.status)) {
      if (
        !Array.isArray(value.instructions) ||
        !value.instructions.length ||
        value.instructions.length > 122 ||
        !value.instructions.every(
          (s) => typeof s === "string" && s.length <= 400,
        ) ||
        !Array.isArray(value.landmarkIDs) ||
        !value.landmarkIDs.length ||
        value.landmarkIDs.length > 120 ||
        value.landmarkIDs[0] !== landmarkStartID() ||
        value.landmarkIDs.at(-1) !== selectedID ||
        !value.landmarkIDs.every((id) =>
          pending.destinations.some((p) => p.id === id),
        ) ||
        !Number.isFinite(value.distance) ||
        value.distance < 0 ||
        !Array.isArray(value.path) ||
        value.path.length > 3200 ||
        !value.path.every(
          (p) =>
            Number.isFinite(p.latitude) &&
            Math.abs(p.latitude) < 85 &&
            Number.isFinite(p.longitude) &&
            Math.abs(p.longitude) <= 180,
        ) ||
        (value.status === "ok" && value.path.length < 2)
      )
        return;
    }
    clearTimeout(landmarkTimer);
    landmarkTimer = null;
    landmarkRequest = null;
    landmarkRoute = value;
    directionStep = 0;
    landmarkVersion++;
    updateLandmarkDirections();
    startRenderKey = null;
    renderStartSuggestion();
  };
  function clearIndoorTracking() {
    window.ContourBridge?.clearIndoorTracking?.();
    indoorPose = null;
    trackingRequested = false;
  }
  function beginIndoorTracking() {
    const heading = confirmedStart?.heading || phoneHeading;
    if (
      !confirmedStart ||
      trackingRequested ||
      !heading ||
      Date.now() - heading.timestamp > 10000 ||
      !window.ContourBridge?.startIndoorTracking
    )
      return;
    trackingRequested = true;
    window.ContourBridge.startIndoorTracking({
      sessionID: confirmedStart.sessionID,
      floor: pending.floor || "2F",
      latitude: confirmedStart.ll[0],
      longitude: confirmedStart.ll[1],
      heading: heading.degrees,
      stepLength,
      ...(pending.wallGeometry?.reviewed
        ? {
            wallMap: {
              latitude: pending.latitude,
              longitude: pending.longitude,
              width: pending.width,
              aspect: pending.aspect,
              angle: pending.angle,
              geometry: pending.wallGeometry,
            },
          }
        : {}),
    });
  }
  window.contourIOSIndoorPose = (value) => {
    if (
      !confirmedStart ||
      value?.sessionID !== confirmedStart.sessionID ||
      value.floor !== (pending?.floor || "2F") ||
      !Number.isFinite(value.latitude) ||
      Math.abs(value.latitude) >= 85 ||
      !Number.isFinite(value.longitude) ||
      Math.abs(value.longitude) > 180 ||
      !Number.isFinite(value.heading) ||
      value.heading < 0 ||
      value.heading >= 360 ||
      !Number.isFinite(value.timestamp) ||
      Math.abs(Date.now() - value.timestamp) > 10000 ||
      (indoorPose && value.timestamp < indoorPose.timestamp) ||
      !Number.isInteger(value.steps) ||
      value.steps < 0 ||
      !Number.isFinite(value.distance) ||
      value.distance < 0 ||
      (value.wallBlocked != null && typeof value.wallBlocked !== "boolean") ||
      ![
        "starting",
        "tracking",
        "paused",
        "motion-unavailable",
        "motion-interrupted",
      ].includes(value.status)
    )
      return;
    indoorPose = value;
    confirmedStart.last = [value.latitude, value.longitude];
    renderStartSuggestion();
  };
  function displayedHeading() {
    // Viewing direction follows the compass independently of step/gyro navigation.
    if (phoneHeading && Date.now() - phoneHeading.timestamp <= 10000)
      return phoneHeading;
    if (!confirmedStart) return null;
    if (!indoorPose || indoorPose.status !== "tracking") return null;
    return { degrees: indoorPose.heading, timestamp: indoorPose.timestamp };
  }
  function startSignature(value, pin) {
    return JSON.stringify([
      value.image,
      value.floor || "2F",
      value.latitude,
      value.longitude,
      value.width,
      value.aspect,
      value.angle,
      pin.id,
      pin.x,
      pin.y,
      value.wallGeometry,
    ]);
  }
  function displayedFix(fix) {
    if (!confirmedStart) return fix;
    return {
      ll: confirmedStart.last || confirmedStart.ll,
      accuracy: null,
      confirmed: true,
    };
  }
  function confirmStartingPoint(pinID = suggestedID) {
    const pin = pending?.destinations?.find((pin) => pin.id === pinID);
    if (!pin) return;
    chosenStartID = pin.id;
    positionAtPin(pin);
  }
  function positionAtPin(pin, heading = null) {
    clearIndoorTracking();
    confirmedStart = {
      sessionID:
        window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      id: pin.id,
      name: pin.name,
      ll: coordinate(pending, pin),
      signature: startSignature(pending, pin),
      heading,
    };
    startFitKey = null;
    beginIndoorTracking();
    renderStartSuggestion();
  }
  window.contourIOSHeading = (value) => {
    if (
      !Number.isFinite(value?.degrees) ||
      value.degrees < 0 ||
      value.degrees >= 360 ||
      !Number.isFinite(value.accuracy) ||
      value.accuracy < 0 ||
      value.accuracy > 60 ||
      !Number.isFinite(value.timestamp) ||
      Math.abs(Date.now() - value.timestamp) > 10000
    )
      return;
    phoneHeading = value;
    beginIndoorTracking();
    renderStartSuggestion();
  };
  let suggestedID = null;
  let chosenStartID = null;
  let startMap = null;
  let startMapProvider = null;
  let startLayers = [];
  let startFitKey = null;
  let startRenderKey = null;
  let startError = "Waiting for your phone’s location…";

  const validWallSegment = (s) =>
    s &&
    typeof s.id === "string" &&
    s.id.length <= 80 &&
    [s.start, s.end].every(
      (p) =>
        p &&
        Number.isFinite(p.x) &&
        p.x >= 0 &&
        p.x <= 1 &&
        Number.isFinite(p.y) &&
        p.y >= 0 &&
        p.y <= 1,
    ) &&
    Math.hypot(s.start.x - s.end.x, s.start.y - s.end.y) > 0.0001;
  const validWallGeometry = (g) =>
    g &&
    g.version === 1 &&
    typeof g.reviewed === "boolean" &&
    Array.isArray(g.walls) &&
    g.walls.length <= 1000 &&
    Array.isArray(g.openings) &&
    g.openings.length <= 200 &&
    [...g.walls, ...g.openings].every(validWallSegment) &&
    new Set([...g.walls, ...g.openings].map((s) => s.id)).size ===
      g.walls.length + g.openings.length;
  const validWalkingNetwork = (g, pins) => {
    if (
      !g ||
      g.version !== 1 ||
      typeof g.reviewed !== "boolean" ||
      !Array.isArray(g.points) ||
      g.points.length > 120 ||
      !Array.isArray(g.connections) ||
      g.connections.length > 600 ||
      !g.points.every((p) => p && typeof p.destinationID === "string") ||
      !g.connections.every(
        (e) => e && typeof e.from === "string" && typeof e.to === "string",
      )
    )
      return false;
    const ids = new Set(g.points.map((p) => p.destinationID));
    if (
      ids.size !== g.points.length ||
      !g.points.every(
        (p) =>
          pins.some((pin) => pin.id === p.destinationID) &&
          p.position &&
          Number.isFinite(p.position.x) &&
          p.position.x >= 0 &&
          p.position.x <= 1 &&
          Number.isFinite(p.position.y) &&
          p.position.y >= 0 &&
          p.position.y <= 1,
      )
    )
      return false;
    return (
      new Set(g.connections.map((e) => e.id)).size === g.connections.length &&
      new Set(g.connections.map((e) => [e.from, e.to].sort().join(":")))
        .size === g.connections.length &&
      g.connections.every(
        (e) =>
          typeof e.id === "string" &&
          e.id.length <= 80 &&
          ids.has(e.from) &&
          ids.has(e.to) &&
          e.from !== e.to &&
          Array.isArray(e.via) &&
          e.via.length <= 24 &&
          e.via.every(
            (p) =>
              p &&
              Number.isFinite(p.x) &&
              p.x >= 0 &&
              p.x <= 1 &&
              Number.isFinite(p.y) &&
              p.y >= 0 &&
              p.y <= 1,
          ),
      )
    );
  };
  const valid = (v) =>
    v &&
    v.version === 1 &&
    typeof v.image === "string" &&
    v.image.length <= 16000000 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(v.image) &&
    Number.isFinite(v.latitude) &&
    Math.abs(v.latitude) < 85 &&
    Number.isFinite(v.longitude) &&
    Math.abs(v.longitude) <= 180 &&
    Number.isFinite(v.width) &&
    v.width >= 1 &&
    v.width <= 2000 &&
    Number.isFinite(v.aspect) &&
    v.aspect >= 0.05 &&
    v.aspect <= 20 &&
    v.width * v.aspect <= 2000 &&
    Number.isFinite(v.angle) &&
    Number.isFinite(v.opacity) &&
    v.opacity >= 0.1 &&
    v.opacity <= 1 &&
    typeof v.visible === "boolean" &&
    (v.wallGeometry == null || validWallGeometry(v.wallGeometry)) &&
    (v.routingRevision == null ||
      (typeof v.routingRevision === "string" &&
        /^[a-f0-9]{64}$/.test(v.routingRevision))) &&
    (v.walkingNetwork == null ||
      validWalkingNetwork(v.walkingNetwork, v.destinations || [])) &&
    (v.floor == null || ["B1", "1F", "2F", "3F", "4F"].includes(v.floor)) &&
    (v.destinations == null ||
      (Array.isArray(v.destinations) &&
        v.destinations.length <= 120 &&
        new Set(v.destinations.map((p) => p.id)).size ===
          v.destinations.length &&
        v.destinations.every(
          (p) =>
            typeof p.id === "string" &&
            p.id.length <= 80 &&
            typeof p.name === "string" &&
            p.name.trim().length > 0 &&
            p.name.length <= 80 &&
            Number.isFinite(p.x) &&
            p.x >= 0 &&
            p.x <= 1 &&
            Number.isFinite(p.y) &&
            p.y >= 0 &&
            p.y <= 1,
        )));

  function draw() {
    if (!map || !hasPending) return;
    if (layer) {
      if (provider === "google") layer.setMap(null);
      else map.removeLayer(layer);
      layer = null;
    }
    const v = pending;
    if (!v || !v.visible) return;
    if (provider === "google") {
      drawGoogle(v);
      return;
    }
    const L = window.L;
    layer = createLeafletImage(v, map);
    if (focusPending) {
      focusPending = false;
      map.setMaxZoom(Math.max(map.getMaxZoom(), 22));
      map.eachLayer((tile) => {
        if (tile instanceof L.TileLayer) {
          tile.options.maxNativeZoom ??= tile.options.maxZoom ?? 18;
          tile.options.maxZoom = Math.max(tile.options.maxZoom ?? 18, 22);
          tile.redraw();
        }
      });
      map.setMaxBounds(null);
      const center = L.CRS.EPSG3857.project(L.latLng(v.latitude, v.longitude));
      const half =
        Math.hypot(v.width, v.width * v.aspect) /
        (2 * Math.cos((v.latitude * Math.PI) / 180));
      map.fitBounds(
        L.latLngBounds(
          L.CRS.EPSG3857.unproject(L.point(center.x - half, center.y - half)),
          L.CRS.EPSG3857.unproject(L.point(center.x + half, center.y + half)),
        ),
        { padding: [25, 25], maxZoom: 20, animate: false },
      );
    }
  }

  function createLeafletImage(
    v,
    map,
    paneName = "nativeFloorPlan",
    className = "contour-native-floor-plan",
  ) {
    const L = window.L;
    const pane = map.getPane(paneName) || map.createPane(paneName);
    pane.style.zIndex = "350";
    pane.style.pointerEvents = "none";
    const NativeImage = L.Layer.extend({
      onAdd() {
        this.image = L.DomUtil.create("img", className, pane);
        this.image.src = "data:image/png;base64," + v.image;
        this.image.alt = "Saved floor plan";
        Object.assign(this.image.style, {
          position: "absolute",
          maxWidth: "none",
          pointerEvents: "none",
          opacity: String(v.opacity),
          transformOrigin: "50% 50%",
        });
        map.on("zoom viewreset move", this.render, this);
        this.render();
      },
      render() {
        const center = L.latLng(v.latitude, v.longitude);
        const projected = L.CRS.EPSG3857.project(center);
        const edge = L.CRS.EPSG3857.unproject(
          L.point(
            projected.x + v.width / Math.cos((v.latitude * Math.PI) / 180),
            projected.y,
          ),
        );
        const a = map.latLngToLayerPoint(center),
          b = map.latLngToLayerPoint(edge);
        const width = Math.abs(b.x - a.x),
          height = width * v.aspect;
        Object.assign(this.image.style, {
          left: `${a.x - width / 2}px`,
          top: `${a.y - height / 2}px`,
          width: `${width}px`,
          height: `${height}px`,
          transform: `rotate(${v.angle}deg)`,
        });
      },
      onRemove() {
        map.off("zoom viewreset move", this.render, this);
        this.image.remove();
      },
    });
    return new NativeImage().addTo(map);
  }

  // Match the image's Mercator sizing and clockwise rotation, including after realignment.
  function coordinate(v, pin) {
    const radians = (v.angle * Math.PI) / 180,
      scale = Math.cos((v.latitude * Math.PI) / 180);
    const dx = (pin.x - 0.5) * v.width,
      dy = (pin.y - 0.5) * v.width * v.aspect;
    const east = dx * Math.cos(radians) - dy * Math.sin(radians);
    const south = dx * Math.sin(radians) + dy * Math.cos(radians);
    const y =
      6378137 * Math.log(Math.tan(Math.PI / 4 + (v.latitude * Math.PI) / 360)) -
      south / scale;
    return [
      (Math.atan(Math.sinh(y / 6378137)) * 180) / Math.PI,
      v.longitude + ((east / (6378137 * scale)) * 180) / Math.PI,
    ];
  }
  // A nearby printed label is a suggestion, never an automatically confirmed pose.
  function groundDistance(a, b) {
    const lat = ((a[0] + b[0]) * Math.PI) / 360;
    return Math.hypot(
      (a[0] - b[0]) * 111319.49,
      (a[1] - b[1]) * 111319.49 * Math.cos(lat),
    );
  }
  function clearStartLayers() {
    for (const item of startLayers) {
      if (startMapProvider === "google") item.setMap(null);
      else item.remove();
    }
    startLayers = [];
    if (floorUI) floorUI.startMap.dataset.hasLine = "false";
  }
  function stopStartLocation(preserveStart = false) {
    if (startWatch !== null) navigator.geolocation.clearWatch(startWatch);
    startWatch = null;
    clearInterval(startTimer);
    startTimer = null;
    startFix = null;
    suggestedID = null;
    if (!preserveStart) chosenStartID = null;
    startFitKey = null;
    startRenderKey = null;
    clearStartLayers();
    window.ContourBridge?.stopFloorHeading?.();
  }
  function startLocation() {
    if (startWatch !== null || document.hidden) return;
    startError = "Waiting for your phone’s location…";
    window.ContourBridge?.startFloorHeading?.();
    startWatch = navigator.geolocation.watchPosition(
      (position) => {
        const c = position.coords;
        if (
          !Number.isFinite(c?.latitude) ||
          Math.abs(c.latitude) >= 85 ||
          !Number.isFinite(c.longitude) ||
          Math.abs(c.longitude) > 180 ||
          !Number.isFinite(c.accuracy) ||
          c.accuracy < 0 ||
          !Number.isFinite(position.timestamp) ||
          position.timestamp > Date.now() + 5000 ||
          Date.now() - position.timestamp > 30000
        ) {
          startError =
            "Location is outdated or invalid. Waiting for a fresh fix…";
          startFix = null;
        } else {
          startFix = {
            ll: [c.latitude, c.longitude],
            accuracy: c.accuracy,
            timestamp: position.timestamp,
          };
        }
        renderStartSuggestion();
      },
      (error) => {
        startFix = null;
        startError =
          error.code === 1
            ? "Location access is off. Allow location in Settings to suggest a start."
            : "Location unavailable. Waiting for a fresh fix…";
        renderStartSuggestion();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
    startTimer = setInterval(renderStartSuggestion, 1000);
  }
  function createFloorPins(value, targetMap, kind, fix) {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "absolute",
      left: "0",
      top: "0",
      pointerEvents: "none",
    });
    const buttons = (value.destinations || []).map((pin, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "contour-floor-pin";
      button.dataset.id = pin.id;
      button.textContent = String(index + 1);
      button.title = pin.name;
      button.setAttribute(
        "aria-label",
        (mapPinTarget === "start"
          ? "Choose starting point "
          : "Choose destination ") + pin.name,
      );
      button.setAttribute("aria-pressed", String(pin.id === suggestedID));
      button.classList.toggle(
        "contour-floor-destination",
        pin.id === selectedID,
      );
      button.onclick = (event) => {
        event.stopPropagation();
        if (mapPinTarget === "destination") {
          selectFloorPin(pin.id);
          return;
        }
        confirmStartingPoint(pin.id);
      };
      container.appendChild(button);
      return { button, ll: coordinate(value, pin) };
    });
    let direction = null;
    const heading = displayedHeading();
    if (fix && heading && Date.now() - heading.timestamp <= 10000) {
      direction = document.createElement("div");
      direction.className = "contour-floor-heading";
      direction.setAttribute(
        "aria-label",
        `Facing ${Math.round(heading.degrees)} degrees`,
      );
      direction.innerHTML =
        '<svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true"><defs><linearGradient id="contour-view-cone" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#188038" stop-opacity=".45"/><stop offset="1" stop-color="#188038" stop-opacity=".05"/></linearGradient></defs><path d="M36 36 L8 5 Q36 -5 64 5 Z" fill="url(#contour-view-cone)"/><path d="M36 10 L44 25 L36 21 L28 25 Z" fill="#188038" stroke="white" stroke-width="1.5"/></svg>';
      Object.assign(direction.style, {
        position: "absolute",
        width: "72px",
        height: "72px",
        pointerEvents: "none",
        transform: `translate(-50%,-50%) rotate(${heading.degrees}deg)`,
      });
      container.appendChild(direction);
    }
    function position(project) {
      if (direction) {
        const mapHeading =
          kind === "google" ? targetMap.getHeading?.() || 0 : 0;
        direction.style.transform = `translate(-50%,-50%) rotate(${heading.degrees - mapHeading}deg)`;
        const point = project(fix.ll);
        if (point) {
          direction.style.left = `${point.x}px`;
          direction.style.top = `${point.y}px`;
        }
      }
      buttons.forEach(({ button, ll }) => {
        const point = project(ll);
        if (!point) return;
        button.style.left = `${point.x}px`;
        button.style.top = `${point.y}px`;
      });
    }
    if (kind === "google") {
      const gm = window.google.maps;
      class Pins extends gm.OverlayView {
        onAdd() {
          this.getPanes().overlayMouseTarget.appendChild(container);
          gm.OverlayView.preventMapHitsAndGesturesFrom?.(container);
        }
        draw() {
          const projection = this.getProjection();
          if (projection)
            position((ll) =>
              projection.fromLatLngToDivPixel(new gm.LatLng(ll[0], ll[1])),
            );
        }
        onRemove() {
          container.remove();
        }
      }
      const pins = new Pins();
      pins.setMap(targetMap);
      return pins;
    }
    const L = window.L;
    const pane =
      targetMap.getPane("floorPins") || targetMap.createPane("floorPins");
    pane.style.zIndex = "650";
    pane.style.pointerEvents = "none";
    const Pins = L.Layer.extend({
      onAdd() {
        pane.appendChild(container);
        L.DomEvent.disableClickPropagation(container);
        targetMap.on("zoom viewreset move", this.render, this);
        this.render();
      },
      render() {
        position((ll) => targetMap.latLngToLayerPoint(ll));
      },
      onRemove() {
        targetMap.off("zoom viewreset move", this.render, this);
        container.remove();
      },
    });
    return new Pins().addTo(targetMap);
  }
  function renderStartMap(target, fix) {
    if (!floorUI || !pending) return;
    const host = floorUI.startMap;
    const floorImage = { ...pending, opacity: 1 };
    if (!startMap) {
      if (provider === "google" && window.google?.maps?.Map) {
        startMapProvider = "google";
        startMap = new window.google.maps.Map(host, {
          center: { lat: pending.latitude, lng: pending.longitude },
          disableDefaultUI: true,
          zoomControl: false,
          keyboardShortcuts: false,
          clickableIcons: false,
          tilt: 0,
          heading: 0,
          zoom: 19,
          isFractionalZoomEnabled: true,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          gestureHandling: "greedy",
        });
      } else if (window.L?.map) {
        startMapProvider = "leaflet";
        startMap = window.L.map(host, {
          attributionControl: false,
          zoomControl: false,
          zoomSnap: 0.1,
          zoomDelta: 0.5,
          maxZoom: 22,
        });
      } else return;
    }
    clearStartLayers();
    const ll = fix?.ll;
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ].map((pin) => coordinate(pending, pin));
    const key = `${revision}:${suggestedID || "none"}:${ll ? "located" : "unlocated"}:${confirmedStart?.id || "raw"}:${landmarkRoute?.status === "ok" ? landmarkRoute.landmarkIDs.join(":") : "no-route"}`;
    const hasRoute = landmarkRoute?.status === "ok";
    const topPadding = Math.min(
      floorUI.root.dataset.sheetExpanded === "true" ? 105 : 210,
      Math.round(host.clientHeight * 0.4),
    );
    const shouldFit = startFitKey !== key;
    startFitKey = key;
    if (startMapProvider === "google") {
      const gm = window.google.maps;
      const current = ll ? { lat: ll[0], lng: ll[1] } : null;
      startLayers.push(
        createGoogleImage(floorImage, startMap, "contour-start-floor-plan"),
      );
      if (current) {
        startLayers.push(
          new gm.Marker({
            map: startMap,
            position: current,
            title: fix.confirmed
              ? "Position corrected to confirmed start (movement approximate)"
              : "Phone-reported position (approximate)",
            icon: {
              path: gm.SymbolPath.CIRCLE,
              scale: 7,
              fillColor: fix.confirmed ? "#188038" : "#2469ca",
              fillOpacity: 1,
              strokeColor: "white",
              strokeWeight: 2,
            },
          }),
        );
        if (Number.isFinite(fix.accuracy))
          startLayers.push(
            new gm.Circle({
              map: startMap,
              center: current,
              radius: fix.accuracy,
              fillColor: "#2469ca",
              fillOpacity: 0.12,
              strokeColor: "#2469ca",
              strokeOpacity: 0.4,
              strokeWeight: 1,
            }),
          );
      }
      const bounds = new gm.LatLngBounds();
      if (current && !hasRoute) bounds.extend(current);
      (hasRoute
        ? landmarkRoute.path.map((p) => [p.latitude, p.longitude])
        : corners
      ).forEach((point) => bounds.extend({ lat: point[0], lng: point[1] }));
      if (target && current && !hasRoute) {
        const end = { lat: target.ll[0], lng: target.ll[1] };
        bounds.extend(end);
        startLayers.push(
          new gm.Polyline({
            map: startMap,
            path: [current, end],
            strokeOpacity: 0,
            icons: [
              {
                icon: {
                  path: "M 0,-1 0,1",
                  strokeColor: "#b84a10",
                  strokeOpacity: 1,
                  scale: 3,
                },
                offset: "0",
                repeat: "12px",
              },
            ],
          }),
        );
      }
      if (shouldFit) {
        startMap.fitBounds(bounds, {
          top: topPadding,
          bottom: 24,
          left: 24,
          right: 24,
        });
        startMap.setOptions({ maxZoom: 20 });
      }
    } else {
      const L = window.L;
      startMap.invalidateSize();
      startLayers.push(
        createLeafletImage(
          floorImage,
          startMap,
          "startFloorPlan",
          "contour-start-floor-plan",
        ),
      );
      if (ll) {
        if (Number.isFinite(fix.accuracy))
          startLayers.push(
            L.circle(ll, {
              radius: Math.min(fix.accuracy, 2000),
              color: "#2469ca",
              weight: 1,
            }).addTo(startMap),
          );
        startLayers.push(
          L.circleMarker(ll, {
            radius: 7,
            color: "white",
            fillColor: fix.confirmed ? "#188038" : "#2469ca",
            fillOpacity: 1,
          }).addTo(startMap),
        );
      }
      if (target && ll && !hasRoute) {
        startLayers.push(
          L.polyline([ll, target.ll], {
            color: "#b84a10",
            dashArray: "6 6",
          }).addTo(startMap),
        );
      }
      if (shouldFit)
        startMap.fitBounds(
          L.latLngBounds([
            ...(hasRoute
              ? landmarkRoute.path.map((p) => [p.latitude, p.longitude])
              : corners),
            ...(ll && !hasRoute ? [ll] : []),
            ...(target ? [target.ll] : []),
          ]),
          {
            paddingTopLeft: [24, topPadding],
            paddingBottomRight: [24, 24],
            maxZoom: 20,
          },
        );
    }
    if (showWalls && pending.wallGeometry) {
      const geometry = pending.wallGeometry;
      for (const [segments, color] of [
        [geometry.walls, "#d62626"],
        [geometry.openings, "#12833a"],
      ]) {
        for (const segment of segments) {
          const points = [
            coordinate(pending, segment.start),
            coordinate(pending, segment.end),
          ];
          startLayers.push(
            startMapProvider === "google"
              ? new window.google.maps.Polyline({
                  map: startMap,
                  path: points.map((p) => ({ lat: p[0], lng: p[1] })),
                  strokeColor: color,
                  strokeWeight: 3,
                  strokeOpacity: 0.75,
                  clickable: false,
                })
              : window.L.polyline(points, {
                  color,
                  weight: 3,
                  opacity: 0.75,
                  interactive: false,
                }).addTo(startMap),
          );
        }
      }
    }
    host.dataset.wallSegments = String(
      showWalls
        ? (pending.wallGeometry?.walls.length || 0) +
            (pending.wallGeometry?.openings.length || 0)
        : 0,
    );
    if (landmarkRoute?.status === "ok") {
      const points = landmarkRoute.path.map((p) => [p.latitude, p.longitude]);
      startLayers.push(
        startMapProvider === "google"
          ? new window.google.maps.Polyline({
              map: startMap,
              path: points.map((p) => ({ lat: p[0], lng: p[1] })),
              strokeColor: "#185abc",
              strokeWeight: 5,
              strokeOpacity: 0.8,
              clickable: false,
            })
          : window.L.polyline(points, {
              color: "#185abc",
              weight: 5,
              opacity: 0.8,
              interactive: false,
              smoothFactor: 0, // Preserve detour bends instead of visually cutting across a wall.
            }).addTo(startMap),
      );
    }
    host.dataset.hasLandmarkRoute = String(landmarkRoute?.status === "ok");
    startLayers.push(createFloorPins(pending, startMap, startMapProvider, fix));
    host.dataset.provider = startMapProvider;
    host.dataset.hasLine = String(!!target && !!ll && !hasRoute);
  }
  function renderStartSuggestion() {
    const ui = floorUI;
    if (!ui || ui.root.hidden || ui.startSection.hidden) return;
    updateLandmarkDirections();
    const fresh = startFix && Date.now() - startFix.timestamp <= 30000;
    const renderKey = JSON.stringify([
      !confirmedStart && fresh ? startFix : null,
      revision,
      showWalls,
      mapPinTarget,
      landmarkVersion,
      chosenStartID,
      confirmedStart
        ? [confirmedStart.id, confirmedStart.ll, confirmedStart.last]
        : null,
      displayedHeading() && Date.now() - displayedHeading().timestamp <= 10000
        ? Math.round(displayedHeading().degrees)
        : null,
      indoorPose
        ? [
            indoorPose.latitude,
            indoorPose.longitude,
            Math.round(indoorPose.heading),
            indoorPose.steps,
            indoorPose.status,
            indoorPose.wallBlocked,
          ]
        : null,
      startError,
    ]);
    if (renderKey === startRenderKey) return;
    startRenderKey = renderKey;
    const ranked = (pending?.destinations || [])
      .map((pin) => {
        const ll = coordinate(pending, pin);
        return {
          pin,
          ll,
          distance: fresh ? groundDistance(startFix.ll, ll) : null,
        };
      })
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    const radius = fresh
      ? Math.max(50, Math.min(150, startFix.accuracy * 2))
      : 0;
    const automatic =
      fresh && startFix.accuracy <= 100
        ? ranked.find(
            (item) =>
              item.distance <= radius &&
              !/^(?:B[0-9]+|[0-9]+\s*F|F\s*[0-9]+|[0-9]+階)$/i.test(
                item.pin.name.trim(),
              ),
          )
        : null;
    const target =
      ranked.find(
        (item) => item.pin.id === (chosenStartID || confirmedStart?.id),
      ) || automatic;
    suggestedID = target?.pin.id || null;
    if (ui.startOptionRevision !== revision) {
      ui.startOptionRevision = revision;
      ui.startSelect.replaceChildren();
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "Choose starting point";
      ui.startSelect.appendChild(auto);
      (pending.destinations || []).forEach((pin, index) => {
        const option = document.createElement("option");
        option.value = pin.id;
        option.textContent = `${index + 1}. ${pin.name}`;
        ui.startSelect.appendChild(option);
      });
    }
    ui.startSelect.value = chosenStartID || confirmedStart?.id || "";
    ui.startMap.hidden = false;
    let locationStatus = fresh
      ? `Phone-reported position · accuracy approximately ±${Math.round(startFix.accuracy)} m. `
      : startFix
        ? "Location is outdated. Waiting for a fresh fix… "
        : startError + " ";
    const number = target
      ? (pending.destinations || []).findIndex(
          (pin) => pin.id === target.pin.id,
        ) + 1
      : null;
    ui.confirmStart.disabled = !target;
    ui.confirmStart.textContent =
      confirmedStart && confirmedStart.id === target?.pin.id
        ? "Update my position here"
        : "Set my position here";
    ui.confirmHint.textContent = target
      ? `Sets your position to ${target.pin.name}.`
      : "Choose a numbered pin, then set your position here.";
    ui.resetPosition.hidden = !confirmedStart;
    ui.wallToggleLabel.hidden = !pending.wallGeometry;
    ui.startStatus.textContent =
      (confirmedStart
        ? indoorPose?.status === "tracking"
          ? `${indoorPose.steps} steps · ${indoorPose.distance.toFixed(1)} m. ${indoorPose.wallBlocked ? "Stopped at a wall. Check your position. " : ""}`
          : indoorPose?.status === "motion-unavailable"
            ? "Allow Motion & Fitness in Settings, then set your position again. "
            : indoorPose && indoorPose.status !== "starting"
              ? "Motion tracking paused. Set your position again before continuing. "
              : "Starting tracking… "
        : locationStatus) +
      (target
        ? `${chosenStartID ? "Chosen" : "Suggested"} start: ${number}. ${target.pin.name}${fresh && !confirmedStart ? ` · ${Math.round(target.distance)} m from reported position` : ""}. Check floor ${pending.floor || "2F"}.`
        : fresh && startFix.accuracy > 100
          ? "Location is too uncertain to suggest a start. Tap any location to choose manually."
          : ranked.length
            ? "Tap any location pin or choose its name below."
            : "Detect and save floor labels to add locations.");
    // Retain all locations and the floor image without a fix; only the reported dot/line require fresh data.
    renderStartMap(target, displayedFix(fresh ? startFix : null));
    updateFloorAR();
    updateFloorMapSummary();
  }
  function updateFloorAR() {
    if (!floorUI) return;
    const destination = pending?.destinations?.find(
      (pin) => pin.id === selectedID,
    );
    const ready =
      !!confirmedStart &&
      !!destination &&
      indoorPose?.status === "tracking" &&
      !indoorPose.wallBlocked &&
      confirmedStart.id !== destination.id &&
      typeof window.ContourBridge?.startFloorAR === "function";
    floorUI.openAR.disabled = !ready;
    floorUI.arHint.textContent = !confirmedStart
      ? "Set your starting position on the map first."
      : indoorPose?.status !== "tracking"
        ? "Allow motion access and set your position to start indoor tracking."
        : indoorPose.wallBlocked
          ? "Position held at a mapped wall. Check your position, heading or saved door openings before opening AR."
          : !destination
            ? "Choose a saved destination to open camera navigation."
            : confirmedStart.id === destination.id
              ? "Choose a destination different from your starting point."
              : `Open AR toward ${destination.name}. Position comes from steps and turns, not GPS. Camera-only obstacle cues; no wall-aware route yet.`;
    floorUI.openAR.title = floorUI.arHint.textContent;
  }
  function openFloorAR() {
    const destination = pending?.destinations?.find(
      (pin) => pin.id === selectedID,
    );
    if (
      !confirmedStart ||
      !destination ||
      indoorPose?.status !== "tracking" ||
      confirmedStart.id === destination.id
    )
      return;
    const ll = coordinate(pending, destination);
    window.ContourBridge?.startFloorAR?.({
      version: 1,
      trackingID: confirmedStart.sessionID,
      heading: {
        degrees: indoorPose.heading,
        accuracy: 0,
        timestamp: indoorPose.timestamp,
      },
      floor: pending.floor || "2F",
      start: {
        name: confirmedStart.name,
        latitude: indoorPose.latitude,
        longitude: indoorPose.longitude,
      },
      destination: {
        name: destination.name,
        latitude: ll[0],
        longitude: ll[1],
      },
    });
  }
  function bindFloorMap() {
    if (floorUI) return;
    const root = document.getElementById("libraryMaps"),
      image = document.getElementById("libraryMapImage"),
      floor = document.getElementById("libraryFloor"),
      canvas = image?.parentElement;
    if (!root || !image || !floor || !canvas) return;
    floorObserver?.disconnect();
    floorObserver = null;
    // Keep legacy nodes for the hosted page's handlers, but remove their obsolete UI
    // from the iPhone floor-map flow. The floor selector and reference images remain.
    root
      .querySelectorAll(
        ".library-map-body > .library-controls, .library-map-body > details, #libraryGuide",
      )
      .forEach((element) => {
        element.hidden = true;
        element.inert = true;
      });
    const style = document.createElement("style");
    style.textContent = `
      #libraryMaps .library-map-body > .library-controls,#libraryMaps .library-map-body > details,#libraryMaps #libraryGuide{display:none!important}
      .contour-floor-pins{position:absolute;inset:0;pointer-events:none;z-index:3}
      .contour-floor-pin{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;border:1.5px solid white;border-radius:50%;background:rgba(36,105,202,.38);color:#102c52;font:bold 10px system-ui;width:24px;height:24px;min-width:24px;min-height:24px;padding:0;box-shadow:0 1px 3px #0004;cursor:pointer}
      .contour-floor-pin.contour-floor-destination{box-shadow:0 0 0 4px #16714a}
      .contour-floor-pin[aria-pressed="true"]{background:rgba(184,74,16,.48);outline:3px solid #f5b34b;color:#381800}
      .contour-saved-pins #libraryOverlay [data-checkpoint]{display:none}
      .contour-custom-plan #libraryOverlay,.contour-custom-plan #libraryGuide,.contour-custom-plan #libraryPlan3d{display:none}
      .contour-custom-controls{display:none!important}
      .contour-floor-controls{padding:12px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .contour-floor-controls[hidden],.contour-start[hidden],.contour-start-map[hidden]{display:none}
      .contour-start{padding:12px;border:1px solid #a9bfdc;border-radius:12px;margin:12px 0}
      .contour-start h3{margin:0 0 8px}.contour-start p{margin:8px 0}
      .contour-start-map{height:440px;max-height:65vh;width:100%;border-radius:8px;background:#e9eef4}
      .contour-start-choices{display:flex;flex-wrap:wrap;gap:8px}
      .contour-start-choices [aria-pressed="true"]{outline:2px solid #b84a10}
      .contour-start-choices>label{display:block;width:100%;min-width:0}
      .contour-start-choices select{display:block;width:100%;min-width:0;box-sizing:border-box}
      .contour-start-choices .contour-confirm-position{display:block;width:100%;min-height:50px;padding:14px 18px;margin:4px 0 0;border:0;border-radius:12px;background:#185abc;color:white;font:700 17px system-ui;text-align:center;box-shadow:0 3px 8px #185abc33;cursor:pointer}
      .contour-start-choices .contour-confirm-position:disabled{background:#dce3ed;color:#566579;box-shadow:none;cursor:default}
      .contour-start-choices .contour-confirm-position:active:not(:disabled){background:#10418c}
      .contour-start-choices .contour-confirm-position:focus-visible{outline:3px solid #f5b34b;outline-offset:3px}
      .contour-start-choices .contour-position-hint{width:100%;font-size:14px;line-height:1.4;margin:0 0 8px;color:#344054}
      .contour-floor-controls label{width:100%}.contour-floor-controls select{max-width:100%}
      .contour-floor-controls .contour-open-ar{width:100%;min-height:50px;border:0;border-radius:12px;background:#185abc;color:white;padding:14px 18px;font:700 17px system-ui;cursor:pointer}
      .contour-floor-controls .contour-open-ar:disabled{background:#dce3ed;color:#566579;cursor:default}
      .contour-floor-controls .contour-ar-hint{width:100%;margin:0 0 8px;font-size:14px;line-height:1.4}
      .contour-floor-status{width:100%;margin:0}
      .contour-landmark-directions{width:100%;padding:12px;border:1px solid #b7cce7;border-radius:12px;box-sizing:border-box;overflow-wrap:anywhere}
      .contour-landmark-directions h3{font-size:18px;margin:0 0 8px}.contour-landmark-directions p{margin:8px 0;font-size:14px;line-height:1.4}
      .contour-landmark-directions ol{padding-left:24px;margin:12px 0}.contour-landmark-directions li{margin:12px 0;line-height:1.5}
      .contour-landmark-directions .contour-generate-directions{width:100%;min-height:48px;padding:12px;border:0;border-radius:10px;background:#185abc;color:white;font:700 16px system-ui;cursor:pointer}
      .contour-landmark-directions .contour-generate-directions:disabled{background:#dce3ed;color:#566579;cursor:default}
      .contour-step-progress{font-weight:700!important;color:#087f8c}.contour-step-arrived,.contour-step-previous{width:100%;min-height:44px;padding:12px;margin:5px 0;border:0;border-radius:12px;font:650 15px system-ui;cursor:pointer}.contour-step-arrived{background:#087f8c;color:white}.contour-step-previous{background:#edf3f6;color:#334155}.contour-step-arrived[hidden],.contour-step-previous[hidden],.contour-step-progress[hidden],.contour-landmark-directions li[hidden]{display:none!important}
    `;
    document.head.appendChild(style);
    const controls = document.createElement("div");
    controls.className = "contour-floor-controls";
    controls.hidden = true;
    const label = document.createElement("label");
    label.textContent = "Saved destinations ";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Saved floor destinations");
    label.appendChild(select);
    select.addEventListener("change", () => selectFloorPin(select.value));
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear destination";
    clear.onclick = () => selectFloorPin(null);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit floor overlay / Detect labels";
    edit.onclick = () => window.ContourBridge?.openFloorOverlay?.();
    const status = document.createElement("p");
    status.className = "contour-floor-status";
    status.setAttribute("role", "status");
    const openAR = document.createElement("button");
    openAR.type = "button";
    openAR.className = "contour-open-ar";
    openAR.textContent = "Open AR navigation";
    openAR.disabled = true;
    openAR.onclick = openFloorAR;
    const arHint = document.createElement("p");
    arHint.id = "contour-ar-hint";
    arHint.className = "contour-ar-hint";
    openAR.setAttribute("aria-describedby", arHint.id);
    const directionsSection = document.createElement("section");
    directionsSection.className = "contour-landmark-directions";
    directionsSection.setAttribute("aria-label", "Landmark directions");
    const directionsTitle = document.createElement("h3");
    directionsTitle.textContent = "Landmark directions";
    const directionsHint = document.createElement("p");
    const generateDirections = document.createElement("button");
    generateDirections.type = "button";
    generateDirections.className = "contour-generate-directions";
    generateDirections.onclick = generateLandmarkDirections;
    const directionMessage = document.createElement("p");
    directionMessage.setAttribute("role", "status");
    const directionSummary = document.createElement("p");
    const directionList = document.createElement("ol");
    directionList.setAttribute(
      "aria-label",
      "Sequential landmark instructions",
    );
    const stepProgress = document.createElement("p");
    stepProgress.setAttribute("role", "status");
    stepProgress.className = "contour-step-progress";
    const arrived = document.createElement("button");
    arrived.type = "button";
    arrived.className = "contour-step-arrived";
    arrived.onclick = () => {
      if (directionStep >= directionStepCount()) return;
      const pinID =
        landmarkRoute.landmarkIDs[
          Math.min(directionStep + 1, landmarkRoute.landmarkIDs.length - 1)
        ];
      const pin = pending.destinations.find((pin) => pin.id === pinID);
      if (!pin) return;
      const heading =
        indoorPose?.status === "tracking"
          ? { degrees: indoorPose.heading, timestamp: indoorPose.timestamp }
          : phoneHeading;
      // Retain the planned origin while reanchoring the live indoor pose.
      chosenStartID = landmarkStartID();
      directionStep++;
      positionAtPin(pin, heading);
      updateDirectionStep();
    };
    const previousStep = document.createElement("button");
    previousStep.type = "button";
    previousStep.textContent = "Previous step";
    previousStep.className = "contour-step-previous";
    previousStep.onclick = () => {
      directionStep = Math.max(0, directionStep - 1);
      updateDirectionStep();
    };
    const editConnections = document.createElement("button");
    editConnections.type = "button";
    editConnections.textContent = "Edit walking connections";
    editConnections.onclick = () =>
      (
        window.ContourBridge?.openWalkingConnections ||
        window.ContourBridge?.openFloorOverlay
      )?.();
    directionsSection.append(
      directionsTitle,
      directionsHint,
      generateDirections,
      directionMessage,
      directionSummary,
      directionList,
      stepProgress,
      arrived,
      previousStep,
      editConnections,
    );
    controls.append(
      label,
      directionsSection,
      openAR,
      arHint,
      clear,
      edit,
      status,
    );
    canvas.parentElement.before(controls);
    const startSection = document.createElement("section");
    startSection.className = "contour-start";
    startSection.hidden = true;
    const heading = document.createElement("h3");
    heading.textContent = "Floor map · choose your starting point";
    const startStatus = document.createElement("p");
    startStatus.className = "contour-start-status";
    startStatus.setAttribute("role", "status");
    const startChoices = document.createElement("div");
    startChoices.className = "contour-start-choices";
    const startLabel = document.createElement("label");
    startLabel.textContent = "Starting point ";
    const startSelect = document.createElement("select");
    startSelect.setAttribute("aria-label", "Starting point");
    startSelect.style.maxWidth = "100%";
    startSelect.onchange = () => {
      chosenStartID = startSelect.value || null;
      renderStartSuggestion();
    };
    startLabel.appendChild(startSelect);
    startChoices.appendChild(startLabel);
    const confirmStart = document.createElement("button");
    confirmStart.type = "button";
    confirmStart.className = "contour-confirm-position";
    confirmStart.setAttribute("aria-describedby", "contour-position-hint");
    const confirmHint = document.createElement("p");
    confirmHint.id = "contour-position-hint";
    confirmHint.className = "contour-position-hint";
    confirmStart.textContent = "Set my position here";
    confirmStart.onclick = () => confirmStartingPoint();
    const resetPosition = document.createElement("button");
    resetPosition.type = "button";
    resetPosition.textContent = "Use uncorrected phone position";
    resetPosition.hidden = true;
    resetPosition.onclick = () => {
      clearIndoorTracking();
      confirmedStart = null;
      startFitKey = null;
      renderStartSuggestion();
    };
    const strideLabel = document.createElement("label");
    strideLabel.textContent = "Step length for next confirmation (m) ";
    const stride = document.createElement("input");
    stride.type = "number";
    stride.min = "0.4";
    stride.max = "1.1";
    stride.step = "0.05";
    stride.value = String(stepLength);
    stride.setAttribute("aria-label", "Step length in metres");
    stride.onchange = () => {
      const number = Number(stride.value);
      if (Number.isFinite(number) && number >= 0.4 && number <= 1.1)
        stepLength = number;
      else stride.value = String(stepLength);
    };
    strideLabel.appendChild(stride);
    startChoices.append(confirmStart, confirmHint, strideLabel, resetPosition);
    const wallToggleLabel = document.createElement("label");
    wallToggleLabel.hidden = true;
    const wallToggle = document.createElement("input");
    wallToggle.type = "checkbox";
    wallToggle.onchange = () => {
      showWalls = wallToggle.checked;
      renderStartSuggestion();
    };
    wallToggleLabel.append(
      wallToggle,
      " Show saved walls (red) and openings (green)",
    );
    startChoices.appendChild(wallToggleLabel);
    const startMap = document.createElement("div");
    startMap.className = "contour-start-map";
    startMap.setAttribute(
      "aria-label",
      "Reported phone position and suggested indoor start",
    );
    const note = document.createElement("p");
    note.textContent =
      "Tap the pin where you are to move your indoor position there. Destination mode selects your goal instead. Green dot: indoor position after setting a start. Blue dot: phone-reported position. Arrow: phone heading. Dashed line is not a walking route.";
    startSection.append(heading, startStatus, startChoices, startMap, note);
    controls.before(startSection);
    floorUI = {
      root,
      image,
      floor,
      canvas,
      pins: startMap,
      controls,
      directionsSection,
      directionsHint,
      generateDirections,
      directionMessage,
      directionSummary,
      directionList,
      openAR,
      stepProgress,
      arrived,
      previousStep,
      arHint,
      select,
      status,
      startSection,
      startStatus,
      startChoices,
      startSelect,
      confirmStart,
      confirmHint,
      resetPosition,
      wallToggleLabel,
      startMap,
      originals: new Map(),
      disabled: new Map(),
      ownedURL: null,
    };
    installFloorMapChrome();
    new MutationObserver(syncFloorMap).observe(root, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
    new MutationObserver(syncFloorMap).observe(image, {
      attributes: true,
      attributeFilter: ["src"],
    });
    const svg = document.getElementById("libraryOverlay");
    if (svg)
      new MutationObserver(syncFloorMap).observe(svg, { childList: true });
    floor.addEventListener("change", syncFloorMap);
    syncFloorMap();
  }
  // iPhone route-planning chrome. Existing native bridge/state remain the single source of truth.
  function installFloorMapChrome() {
    const ui = floorUI,
      root = ui.root;
    root.classList.add("contour-map-layout");
    const make = (tag, className, text) => {
      const el = document.createElement(tag);
      el.className = className;
      if (text) el.textContent = text;
      return el;
    };
    const icons = {
      back: "M15 5l-7 7 7 7M8 12h13",
      swap: "M8 3v17m-4-4 4 4 4-4M16 21V4m-4 4 4-4 4 4",
      more: "M5 12h.01M12 12h.01M19 12h.01",
      close: "m6 6 12 12M18 6 6 18",
      fit: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-4-4v8",
      walk: "m13 7-3 5 3 3-2 6m-1-9-4 4m7-9 3 5 4 1M10 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
    };
    function button(label, icon, className = "contour-map-icon") {
      const el = make("button", className);
      el.type = "button";
      el.setAttribute("aria-label", label);
      el.title = label;
      el.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[icon]}"/></svg>`;
      return el;
    }
    const style = make("style", "");
    style.textContent = `
      #libraryMaps.contour-map-layout:not([hidden]){display:block!important;position:absolute;inset:0;overflow:hidden;background:#edf1f5;color:#202124;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--floor-sheet-height:222px;--floor-tools-top:196px}
      .contour-map-layout[hidden]{display:none!important}
      .contour-map-layout>.ind-bar{position:absolute;inset:0 0 auto;height:54px;z-index:1200;background:transparent;border:0;padding:8px 14px;gap:12px;display:flex;align-items:center;box-sizing:border-box;pointer-events:none}
      .contour-map-layout>.ind-bar>*{pointer-events:auto}.contour-map-layout .ind-x{display:grid;place-items:center;width:36px;height:36px;min-width:36px;border:0;border-radius:50%;background:white;color:#243347;box-shadow:0 2px 9px #23364818;font-size:26px}
      .contour-map-layout .ind-bar h2{font:500 11px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;margin:0;color:#536171;text-shadow:0 0 8px white;background:#ffffffd9;border-radius:8px;padding:3px 8px}
      .contour-map-layout .ind-bar h2::before{content:"Floor Maps";display:block;font-size:18px;font-weight:700;line-height:1.3;color:#202124}
      .contour-map-layout .library-map-body{position:static;padding:0;overflow:hidden;width:100%;height:100%;background:transparent}
      .contour-map-layout .library-map-body>p{display:none}.contour-map-layout .library-map-scroll{position:absolute;inset:112px 0 0;overflow:auto}.contour-map-layout .library-map-canvas{width:100%;min-width:360px}
      .contour-map-layout .contour-start{position:absolute;inset:0 0 var(--floor-sheet-height);padding:0;margin:0;border:0;border-radius:0;overflow:hidden;background:#e9eef4}
      .contour-map-layout .contour-start-map{position:absolute;inset:0;width:100%;height:100%;max-height:none;border-radius:0}
      .contour-map-layout .contour-route-card{position:absolute;z-index:1200;top:62px;left:14px;right:14px;padding:8px 46px 8px 8px;background:white;border:1px solid #e4e8ed;border-radius:18px;box-shadow:0 3px 14px #23364824;box-sizing:border-box}
      .contour-map-layout .contour-route-card[hidden]{display:none!important}.contour-route-field{display:flex;align-items:center;gap:7px;min-width:0;border-radius:10px;padding:4px 3px;height:48px;box-sizing:border-box}
      .contour-map-layout[data-sheet-expanded="true"] .contour-route-card{display:none!important}
      #libraryMaps.contour-map-layout[data-sheet-expanded="true"]{--floor-tools-top:62px}
      .contour-route-field.contour-field-active{background:#f1f5ff}.contour-route-field>label{display:flex;flex-direction:column;min-width:0;flex:1;margin:0;gap:2px}
      .contour-route-field .contour-field-caption{font:600 10px/1.1 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.07em;color:#64748b;text-transform:uppercase}
      .contour-map-layout .contour-route-field select{appearance:none;-webkit-appearance:none;width:100%;max-width:100%;min-width:0;box-sizing:border-box;border:0;outline-offset:2px;background:transparent;color:#202124;padding:0 18px 0 0;font:500 15px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;text-overflow:ellipsis;white-space:nowrap;border-radius:0}
      .contour-route-field label{position:relative}.contour-route-field label::after{content:"⌄";position:absolute;right:0;bottom:1px;font-size:14px;color:#7b8794;pointer-events:none}
      .contour-field-divider{height:1px;background:#e9edf2;margin:4px 8px 4px 36px}
      .contour-endpoint-mode{display:grid;place-items:center;flex:0 0 26px;width:26px;height:38px;padding:0;border:0;background:transparent;cursor:pointer}
      .contour-origin-dot{width:12px;height:12px;background:#4285f4;border:3px solid #e7efff;border-radius:50%;box-sizing:content-box}
      .contour-destination-dot{width:15px;height:19px;border:3px solid #db4437;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-sizing:border-box;position:relative}
      .contour-destination-dot::after{content:"";position:absolute;width:4px;height:4px;background:#db4437;border-radius:50%;top:4px;left:3px}
      .contour-map-icon{display:grid;place-items:center;width:42px;height:42px;min-width:42px;padding:0;border:0;border-radius:50%;background:white;color:#344054;box-shadow:0 2px 10px #23364826;cursor:pointer}
      .contour-map-icon:focus-visible,.contour-endpoint-mode:focus-visible,.contour-sheet-grip:focus-visible{outline:3px solid #4285f4;outline-offset:2px}
      .contour-map-layout .contour-route-swap{position:absolute;right:7px;top:38px;box-shadow:none;width:34px;min-width:34px;height:40px;background:#f4f6f8;border-radius:12px}
      .contour-route-swap:disabled{opacity:.35;cursor:default}
      .contour-map-tools{position:absolute;top:var(--floor-tools-top);left:14px;right:14px;z-index:1200;display:flex;align-items:center;gap:8px;pointer-events:none}
      .contour-map-tools>*{pointer-events:auto}.contour-floor-picker{display:flex;align-items:center;gap:7px;padding:4px 10px;background:white;border-radius:22px;box-shadow:0 2px 10px #23364820;font-size:12px;color:#536171;margin:0}
      .contour-map-layout .contour-floor-picker select{font:650 14px -apple-system,BlinkMacSystemFont,sans-serif;border:0;background:white;color:#243347;padding:5px 2px;min-height:32px}
      .contour-pin-hint{font-size:11px;line-height:1.3;background:#ffffffed;border-radius:18px;padding:9px 10px;box-shadow:0 2px 9px #23364812;max-width:150px}
      .contour-map-tools .contour-map-menu-button{margin-left:auto}.contour-floor-fit{position:absolute;right:15px;bottom:calc(var(--floor-sheet-height) + 38px);z-index:1100;width:46px;height:46px;border-radius:15px}
      .contour-map-layout:not(.contour-floor-active){--floor-tools-top:62px}.contour-map-layout:not(.contour-floor-active) .contour-pin-hint,.contour-map-layout:not(.contour-floor-active) .contour-floor-fit{display:none}
      .contour-map-layout .contour-floor-controls{position:absolute;z-index:1300;left:0;right:0;bottom:0;height:var(--floor-sheet-height);max-height:68%;padding:0;margin:0;display:flex;flex-direction:column;gap:0;background:white;border-radius:24px 24px 0 0;box-shadow:0 -3px 20px #23364820;overflow:hidden;box-sizing:border-box}
      .contour-map-layout .contour-floor-controls[hidden]{display:none!important}
      .contour-sheet-grip{display:grid;place-items:center;width:100%;height:25px;min-height:25px;padding:0;border:0;background:white;touch-action:none;cursor:ns-resize}
      .contour-sheet-grip::before{content:"";width:36px;height:4px;border-radius:4px;background:#c6cbd2}
      .contour-map-layout .contour-landmark-directions{display:flex;flex-direction:column;flex:1;min-height:0;border:0;border-radius:0;padding:0 18px 12px;gap:4px;overflow:hidden}
      .contour-route-overview{display:flex;align-items:center;justify-content:space-between;gap:8px}.contour-route-mode{display:flex;align-items:center;gap:8px;color:#087f8c;min-width:0}
      .contour-map-layout .contour-route-mode h3{font:700 19px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;color:#202124}
      .contour-route-metric{font:700 22px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#087f8c;letter-spacing:-.03em;white-space:nowrap}
      .contour-map-layout .contour-route-caption{font:500 12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:#64748b;margin:0}
      .contour-map-layout .contour-route-message{font:400 12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:#526174;margin:3px 0 5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;flex-shrink:0}
      .contour-route-actions{display:flex;gap:8px;margin-top:auto;padding-top:4px;flex-shrink:0}
      .contour-map-layout .contour-route-actions button{min-height:44px;box-sizing:border-box;border:0;border-radius:24px;padding:10px 13px;font:650 14px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer}
      .contour-map-layout .contour-route-actions .contour-view-directions{flex:1;background:#087f8c;color:white}.contour-map-layout .contour-route-actions .contour-generate-directions{width:auto;background:#e8f4f5;color:#07636c;white-space:nowrap;font-size:12px}
      .contour-map-layout .contour-route-actions .contour-open-ar{width:46px;min-width:46px;padding:8px;background:#f0f3f6;color:#435468;font-size:12px}
      .contour-map-layout .contour-route-actions button:disabled{background:#edf0f3;color:#8b96a5;cursor:default}
      .contour-directions-scroll{display:none;min-height:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding-bottom:8px}
      .contour-map-layout[data-sheet-expanded="true"] .contour-directions-scroll{display:block;flex:1}.contour-map-layout[data-sheet-expanded="true"] .contour-route-actions{margin-top:4px}
      .contour-map-layout .contour-directions-scroll ol{margin:10px 0;padding-left:24px}.contour-map-layout .contour-directions-scroll li{font:400 15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:16px 0;padding-left:4px}
      .contour-map-layout .contour-old-summary{display:none}.contour-map-layout .contour-directions-scroll p{font-size:12px;line-height:1.5;color:#64748b}
      .contour-map-options{position:absolute;z-index:1500;top:calc(var(--floor-tools-top) + 50px);right:12px;left:12px;max-height:calc(100% - var(--floor-tools-top) - 64px);overflow:auto;padding:15px;background:white;box-shadow:0 6px 30px #23364838;border:1px solid #e4e8ed;border-radius:18px;box-sizing:border-box;-webkit-overflow-scrolling:touch}
      .contour-map-options[hidden]{display:none!important}.contour-options-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.contour-options-heading h3{font-size:17px;margin:0}
      .contour-map-options .contour-map-icon{box-shadow:none;background:#f1f4f7;width:32px;height:32px;min-width:32px}
      .contour-map-options button:not(.contour-map-icon){padding:10px 12px;border:1px solid #d9e2ee;border-radius:10px;background:#f6f8fb;color:#234363;font:550 14px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;min-height:42px;margin:3px 4px 3px 0}
      .contour-map-options label{font-size:13px;display:block;margin:10px 0}.contour-map-options p{font-size:12px;line-height:1.5;color:#64748b;margin:8px 0}
      .contour-map-options .contour-confirm-position{display:block;width:100%;background:#185abc!important;color:white!important}.contour-map-options .contour-start-status{padding-top:10px;border-top:1px solid #e6ebf2}
      .contour-map-options input[type="number"]{padding:7px;border:1px solid #d9e2ee;border-radius:8px;width:70px;font:inherit}.contour-map-options a{font-size:12px;color:#185abc}
      .contour-map-layout .contour-floor-pin.contour-floor-destination{box-shadow:0 0 0 3px #db4437}.contour-map-layout .contour-floor-pin[aria-pressed="true"]{outline-color:#4285f4;background:rgba(66,133,244,.48);color:#12336b}
      @media(max-height:600px){.contour-map-layout .contour-pin-hint{display:none}.contour-map-layout .contour-route-metric{font-size:18px}.contour-map-layout .contour-route-message{font-size:11px;-webkit-line-clamp:1}}
    `;
    document.head.appendChild(style);
    const back = document.getElementById("libraryMapClose");
    if (back) {
      back.setAttribute("aria-label", "Back to building details");
      back.innerHTML = button("", "back").innerHTML;
    }
    const card = make("div", "contour-route-card");
    function field(label, select, target) {
      const row = make("div", "contour-route-field");
      const mode = make("button", "contour-endpoint-mode");
      mode.type = "button";
      mode.setAttribute(
        "aria-label",
        target === "start"
          ? "Choose start on map"
          : "Choose destination on map",
      );
      mode.appendChild(
        make(
          "span",
          target === "start" ? "contour-origin-dot" : "contour-destination-dot",
        ),
      );
      mode.onclick = () => setMapPinTarget(target);
      const wrapper = make("label", "");
      wrapper.append(make("span", "contour-field-caption", label), select);
      row.append(mode, wrapper);
      select.addEventListener("focus", () => setMapPinTarget(target));
      return { row, mode };
    }
    const origin = field("From", ui.startSelect, "start"),
      destination = field("To", ui.select, "destination");
    const swap = button(
      "Swap start and destination",
      "swap",
      "contour-map-icon contour-route-swap",
    );
    swap.onclick = () => {
      const start = landmarkStartID(),
        end = selectedID;
      if (!start || !end) return;
      chosenStartID = end;
      startFitKey = null;
      selectFloorPin(start);
    };
    card.append(
      origin.row,
      make("div", "contour-field-divider"),
      destination.row,
      swap,
    );
    root.appendChild(card);
    const tools = make("div", "contour-map-tools");
    const floorLabel = ui.floor.closest("label");
    if (floorLabel) {
      floorLabel.classList.add("contour-floor-picker");
      tools.appendChild(floorLabel);
    }
    const pinHint = make("span", "contour-pin-hint");
    const menu = button(
      "Map options",
      "more",
      "contour-map-icon contour-map-menu-button",
    );
    menu.setAttribute("aria-expanded", "false");
    tools.append(pinHint, menu);
    root.appendChild(tools);
    const options = make("div", "contour-map-options");
    options.hidden = true;
    options.setAttribute("role", "dialog");
    options.setAttribute("aria-label", "Map options");
    const close = button("Close map options", "close");
    const optionsHeader = make("div", "contour-options-heading");
    optionsHeader.append(make("h3", "", "Map options"), close);
    options.appendChild(optionsHeader);
    const oldButtons = [...ui.controls.children].filter(
      (el) =>
        el !== ui.directionsSection &&
        el !== ui.openAR &&
        el.tagName !== "LABEL",
    );
    // Move the original controls, retaining their listeners, bridge actions and saved state.
    options.append(
      ...oldButtons,
      ...[...ui.startChoices.children].filter(
        (el) => el.tagName !== "LABEL" || el.querySelector("input"),
      ),
      ui.startStatus,
      ui.arHint,
    );
    const source = document.getElementById("libraryMapSource");
    if (source) options.appendChild(source);
    const mapNote = ui.startSection.lastElementChild;
    if (mapNote?.tagName === "P") options.appendChild(mapNote);
    const editConnections =
      ui.directionsSection.querySelector("button:last-child");
    if (editConnections) options.appendChild(editConnections);
    root.appendChild(options);
    function closeOptions(focus = true) {
      options.hidden = true;
      menu.setAttribute("aria-expanded", "false");
      if (focus) menu.focus();
    }
    menu.onclick = () => {
      options.hidden = !options.hidden;
      menu.setAttribute("aria-expanded", String(!options.hidden));
      if (!options.hidden) close.focus();
    };
    close.onclick = () => closeOptions();
    root.addEventListener(
      "pointerdown",
      (event) => {
        if (
          !options.hidden &&
          !options.contains(event.target) &&
          !menu.contains(event.target)
        )
          closeOptions(false);
      },
      true,
    );
    options.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeOptions();
      }
    });
    for (const el of options.querySelectorAll("button")) {
      if (/Edit floor overlay|Edit walking connections/.test(el.textContent))
        el.addEventListener("click", () => closeOptions(false));
    }
    const fit = button(
      "Fit floor and route",
      "fit",
      "contour-map-icon contour-floor-fit",
    );
    fit.onclick = () => {
      startFitKey = null;
      startRenderKey = null;
      renderStartSuggestion();
    };
    root.appendChild(fit);
    ui.startSection.replaceChildren(ui.startMap);
    const grip = make("button", "contour-sheet-grip");
    grip.type = "button";
    grip.setAttribute("aria-label", "Expand route details");
    grip.setAttribute("aria-expanded", "false");
    grip.setAttribute("aria-controls", "contour-floor-instructions-scroll");
    const overview = make("div", "contour-route-overview"),
      mode = make("div", "contour-route-mode");
    const walk = button("", "walk");
    walk.tabIndex = -1;
    walk.disabled = true;
    walk.setAttribute("aria-hidden", "true");
    walk.style.cssText =
      "box-shadow:none;background:transparent;color:inherit;width:22px;min-width:22px;height:26px";
    const title = ui.directionsSection.querySelector("h3");
    title.textContent = "Walk";
    mode.append(walk, title);
    const metric = make("span", "contour-route-metric", "Plan your route");
    overview.append(mode, metric);
    const caption = make("p", "contour-route-caption");
    const actions = make("div", "contour-route-actions"),
      showDirections = make("button", "contour-view-directions", "Directions");
    showDirections.type = "button";
    ui.openAR.textContent = "AR";
    ui.openAR.setAttribute("aria-label", "Open AR navigation");
    actions.append(showDirections, ui.generateDirections, ui.openAR);
    const scroll = make("div", "contour-directions-scroll");
    scroll.id = "contour-floor-instructions-scroll";
    scroll.append(
      ui.directionsHint,
      ui.stepProgress,
      ui.directionList,
      ui.arrived,
      ui.previousStep,
    );
    ui.directionMessage.classList.add("contour-route-message");
    ui.directionSummary.classList.add("contour-old-summary");
    ui.directionsSection.replaceChildren(
      overview,
      caption,
      ui.directionMessage,
      actions,
      scroll,
      ui.directionSummary,
    );
    ui.controls.replaceChildren(grip, ui.directionsSection);
    let expanded = false,
      drag = null,
      moved = false;
    const collapsedHeight = () =>
      Math.min(204, Math.max(166, root.clientHeight * 0.25));
    const expandedHeight = () =>
      Math.max(collapsedHeight(), Math.min(520, root.clientHeight * 0.57));
    function setSheet(value) {
      expanded = value;
      root.dataset.sheetExpanded = String(value);
      root.style.setProperty(
        "--floor-sheet-height",
        `${value ? expandedHeight() : collapsedHeight()}px`,
      );
      grip.setAttribute("aria-expanded", String(value));
      grip.setAttribute(
        "aria-label",
        value ? "Collapse route details" : "Expand route details",
      );
      showDirections.setAttribute("aria-expanded", String(value));
    }
    grip.onclick = () => {
      if (!moved) setSheet(!expanded);
      moved = false;
    };
    showDirections.onclick = () => {
      setSheet(!expanded);
      startFitKey = null;
      startRenderKey = null;
      renderStartSuggestion();
    };
    grip.onpointerdown = (event) => {
      if (event.button !== 0) return;
      drag = {
        y: event.clientY,
        height: ui.controls.offsetHeight,
        scale:
          ui.controls.getBoundingClientRect().width /
          Math.max(1, ui.controls.offsetWidth),
      };
      moved = false;
      grip.setPointerCapture(event.pointerId);
    };
    grip.onpointermove = (event) => {
      if (!drag) return;
      const delta = (drag.y - event.clientY) / (drag.scale || 1);
      if (Math.abs(delta) > 5) moved = true;
      const height = Math.min(
        expandedHeight(),
        Math.max(collapsedHeight(), drag.height + delta),
      );
      root.style.setProperty("--floor-sheet-height", `${height}px`);
      root.dataset.sheetExpanded = String(height > collapsedHeight() + 40);
    };
    function endDrag() {
      if (!drag) return;
      if (moved)
        setSheet(
          ui.controls.offsetHeight > (collapsedHeight() + expandedHeight()) / 2,
        );
      drag = null;
    }
    grip.onpointerup = endDrag;
    grip.onpointercancel = endDrag;
    Object.assign(ui, {
      routeCard: card,
      startField: origin.row,
      destinationField: destination.row,
      startMode: origin.mode,
      destinationMode: destination.mode,
      pinHint,
      swap,
      routeMetric: metric,
      routeCaption: caption,
      showDirections,
      closeOptions,
      refreshLayout: () => {
        setSheet(expanded);
        if (root.hidden) closeOptions(false);
      },
    });
    const resize = new ResizeObserver(() => {
      if (root.hidden) return;
      if (startMapProvider === "leaflet")
        startMap?.invalidateSize({ pan: false });
      else if (startMap)
        window.google?.maps?.event?.trigger(startMap, "resize");
    });
    resize.observe(ui.startMap);
    const viewportResize = new ResizeObserver(() => ui.refreshLayout());
    viewportResize.observe(root);
    setSheet(false);
    setMapPinTarget("start");
    updateFloorMapSummary();
  }
  function selectFloorPin(id) {
    selectedID = id || null;
    const pin = pending?.destinations?.find((p) => p.id === selectedID);
    if (floorUI) {
      floorUI.select.value = pin?.id || "";
      floorUI.pins
        .querySelectorAll(".contour-floor-pin")
        .forEach((button) =>
          button.classList.toggle(
            "contour-floor-destination",
            button.dataset.id === selectedID,
          ),
        );
      floorUI.status.textContent = pin
        ? `Destination: ${pin.name}. Printed label position; entrances and walking paths are not inferred.`
        : `Saved overlay: ${pending?.name || "Floor plan"} · ${pending?.floor || "2F"}. Choose a destination by name above; tap map pins to choose your starting point.`;
    }
    updateFloorAR();
    updateLandmarkDirections();
    startRenderKey = null;
    renderStartSuggestion();
    if (pin && pending) {
      const ll = coordinate(pending, pin);
      window.dispatchEvent(
        new CustomEvent("contour-floor-destination-selected", {
          detail: {
            id: pin.id,
            name: pin.name,
            floor: pending.floor || "2F",
            latitude: ll[0],
            longitude: ll[1],
          },
        }),
      );
    }
  }
  function syncFloorMap() {
    if (!floorUI) {
      bindFloorMap();
      return;
    }
    const ui = floorUI;
    if (ui.root.hidden) {
      ui.closeOptions?.(false);
      setMapPinTarget("start");
      clearLandmarkDirections();
      if (confirmedStart) window.ContourBridge?.pauseIndoorTracking?.();
      stopStartLocation();
      ui.startSection.hidden = true;
      openedForSaved = false;
      selectedID = null;
      renderedRevision = -1;
      ui.controls.hidden = true;
      return;
    }
    if (pending && !openedForSaved) {
      openedForSaved = true;
      const floor = pending.floor || "2F";
      if (
        ui.floor.value !== floor &&
        [...ui.floor.options].some((option) => option.value === floor)
      ) {
        ui.floor.value = floor;
        ui.floor.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    const floor = ui.floor.value;
    const src = ui.image.getAttribute("src");
    if (src && src !== imageURL && src !== ui.ownedURL) {
      ui.originals.set(floor, { src, alt: ui.image.alt });
    }
    const active = pending && floor === (pending.floor || "2F");
    ui.root.classList.toggle("contour-floor-active", !!active);
    if (ui.routeCard) ui.routeCard.hidden = !active;
    ui.refreshLayout?.();
    ui.startSection.hidden = !active;
    ui.canvas.parentElement.hidden = !!active;
    if (active) {
      startLocation();
    } else {
      if (confirmedStart) window.ContourBridge?.pauseIndoorTracking?.();
      stopStartLocation();
    }
    ui.root.classList.toggle(
      "contour-saved-pins",
      !!active && !!pending.destinations?.length,
    );
    ui.root.classList.toggle(
      "contour-custom-plan",
      !!active && pending.libraryReferenceImage !== true,
    );
    for (const id of ["libraryStart", "libraryPhoto"]) {
      document
        .getElementById(id)
        ?.closest(".library-controls")
        ?.classList.toggle(
          "contour-custom-controls",
          !!active && pending.libraryReferenceImage !== true,
        );
    }
    const guarded = [
      "libraryStart",
      "libraryDestination",
      "libraryConfirm",
      "libraryAlign",
      "libraryNext",
      "libraryScan",
      "libraryBlock",
      "libraryPhoto",
      "libraryPlan3dButton",
    ];
    for (const id of guarded) {
      const element = document.getElementById(id);
      if (!element) continue;
      if (active && pending.libraryReferenceImage !== true) {
        if (!ui.disabled.has(id)) ui.disabled.set(id, element.disabled);
        element.disabled = true;
      } else if (ui.disabled.has(id)) {
        element.disabled = ui.disabled.get(id);
        ui.disabled.delete(id);
      }
    }
    if (!active) {
      clearLandmarkDirections();
      const original = ui.originals.get(floor);
      if (ui.image.getAttribute("src") === ui.ownedURL && original) {
        ui.image.src = original.src;
        ui.image.alt = original.alt;
      }
      ui.ownedURL = null;
      const source = document.getElementById("libraryMapSource");
      if (source?.dataset.originalText) {
        source.textContent = source.dataset.originalText;
        source.setAttribute("href", source.dataset.originalHref);
      }
      ui.controls.hidden = true;
      selectedID = null;
      renderedRevision = -1;
      return;
    }
    if (ui.image.getAttribute("src") !== imageURL) ui.image.src = imageURL;
    ui.ownedURL = imageURL;
    ui.image.alt = `${pending.name} · ${floor} · saved floor overlay`;
    ui.controls.hidden = false;
    if (renderedRevision !== revision) {
      renderedRevision = revision;
      ui.select.replaceChildren();
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Choose a saved destination";
      ui.select.appendChild(empty);
      (pending.destinations || []).forEach((pin, index) => {
        const option = document.createElement("option");
        option.value = pin.id;
        option.textContent = `${index + 1}. ${pin.name}`;
        ui.select.appendChild(option);
      });
      if (!(pending.destinations || []).some((pin) => pin.id === selectedID))
        selectedID = null;
      selectFloorPin(selectedID);
    }
    const source = document.getElementById("libraryMapSource");
    if (source) {
      if (!source.dataset.originalText) {
        source.dataset.originalText = source.textContent;
        source.dataset.originalHref = source.getAttribute("href") || "";
      }
      source.textContent =
        pending.libraryReferenceImage === true
          ? "Saved floor overlay · library source"
          : "Saved floor overlay on this iPhone";
      if (pending.libraryReferenceImage !== true)
        source.removeAttribute("href");
      else source.setAttribute("href", source.dataset.originalHref);
    }
    renderStartSuggestion();
  }
  function observeFloorMap() {
    bindFloorMap();
    if (!floorUI && !floorObserver) {
      floorObserver = new MutationObserver(bindFloorMap);
      floorObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopStartLocation(true);
    else syncFloorMap();
  });
  window.addEventListener("pagehide", () => stopStartLocation(true));
  document.addEventListener("DOMContentLoaded", observeFloorMap);
  if (document.readyState !== "loading") observeFloorMap();

  function createGoogleImage(
    v,
    targetMap,
    className = "contour-native-floor-plan",
  ) {
    const gm = window.google.maps;
    class NativeImage extends gm.OverlayView {
      onAdd() {
        this.image = document.createElement("img");
        this.image.className = className;
        this.image.src = "data:image/png;base64," + v.image;
        this.image.alt = "Saved floor plan";
        Object.assign(this.image.style, {
          position: "absolute",
          maxWidth: "none",
          pointerEvents: "none",
          opacity: String(v.opacity),
          transformOrigin: "50% 50%",
        });
        this.getPanes().overlayLayer.appendChild(this.image);
      }
      draw() {
        const projection = this.getProjection();
        if (!projection || !this.image) return;
        const delta =
          v.width /
          (111319.49079327358 * Math.cos((v.latitude * Math.PI) / 180));
        const a = projection.fromLatLngToDivPixel(
          new gm.LatLng(v.latitude, v.longitude),
        );
        const b = projection.fromLatLngToDivPixel(
          new gm.LatLng(v.latitude, v.longitude + delta),
        );
        const width = Math.abs(b.x - a.x),
          height = width * v.aspect;
        Object.assign(this.image.style, {
          left: `${a.x - width / 2}px`,
          top: `${a.y - height / 2}px`,
          width: `${width}px`,
          height: `${height}px`,
          transform: `rotate(${v.angle}deg)`,
        });
      }
      onRemove() {
        this.image?.remove();
      }
    }
    const image = new NativeImage();
    image.setMap(targetMap);
    return image;
  }

  function drawGoogle(v) {
    layer = createGoogleImage(v, map.native);
    if (focusPending) {
      focusPending = false;
      const half = Math.hypot(v.width, v.width * v.aspect) / 2;
      const lat = half / 111319.49079327358;
      const lng = lat / Math.cos((v.latitude * Math.PI) / 180);
      map.native.setOptions({ restriction: null, maxZoom: 22 });
      map.native.fitBounds(
        {
          south: v.latitude - lat,
          north: v.latitude + lat,
          west: v.longitude - lng,
          east: v.longitude + lng,
        },
        25,
      );
    }
  }

  window.addEventListener("contour-map-ready", (event) => {
    if (layer) {
      if (provider === "google") layer.setMap(null);
      else map.removeLayer(layer);
      layer = null;
    }
    map = event.detail.map;
    provider = event.detail.provider;
    if (startMap && startMapProvider !== provider) {
      clearStartLayers();
      if (startMapProvider === "leaflet") startMap.remove();
      else window.google?.maps?.event?.clearInstanceListeners(startMap);
      startMap = null;
      startRenderKey = null;
      startFitKey = null;
      floorUI?.startMap.replaceChildren();
    }
    renderStartSuggestion();
    draw();
  });

  function attach() {
    const L = window.L;
    if (hooked || !L?.Map?.addInitHook) return;
    hooked = true;
    L.Map.addInitHook(function () {
      if (this.getContainer().id !== "map") return;
      map = this;
      this.whenReady(draw);
    });
  }
  // The existing hosted and bundled pages load Leaflet as an external script.
  // Capture its load event before the following inline map initializer runs.
  document.addEventListener("load", attach, true);
  attach();
  window.ContourNativeFloorOverlay = {
    apply(value, focus = false) {
      if (value !== null && !valid(value)) return false;
      if (confirmedStart) {
        const pin = value?.destinations?.find(
          (pin) => pin.id === confirmedStart.id,
        );
        if (!pin || startSignature(value, pin) !== confirmedStart.signature) {
          clearIndoorTracking();
          confirmedStart = null;
        }
      }
      pending = value;
      imageURL = value ? "data:image/png;base64," + value.image : null;
      revision++;
      openedForSaved = false;
      hasPending = true;
      focusPending = focus;
      syncFloorMap();
      draw();
      return true;
    },
  };
})();
