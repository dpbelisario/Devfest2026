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
  function clearIndoorTracking() {
    window.ContourBridge?.clearIndoorTracking?.();
    indoorPose = null;
    trackingRequested = false;
  }
  function beginIndoorTracking() {
    if (
      !confirmedStart ||
      trackingRequested ||
      !phoneHeading ||
      Date.now() - phoneHeading.timestamp > 10000 ||
      !window.ContourBridge?.startIndoorTracking
    )
      return;
    trackingRequested = true;
    window.ContourBridge.startIndoorTracking({
      sessionID: confirmedStart.sessionID,
      floor: pending.floor || "2F",
      latitude: confirmedStart.ll[0],
      longitude: confirmedStart.ll[1],
      heading: phoneHeading.degrees,
      stepLength,
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
    if (!confirmedStart) return phoneHeading;
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
  function confirmStartingPoint() {
    const pin = pending?.destinations?.find((pin) => pin.id === suggestedID);
    if (!pin) return;
    clearIndoorTracking();
    chosenStartID = pin.id;
    confirmedStart = {
      sessionID:
        window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      id: pin.id,
      name: pin.name,
      ll: coordinate(pending, pin),
      signature: startSignature(pending, pin),
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
  function stopStartLocation() {
    if (startWatch !== null) navigator.geolocation.clearWatch(startWatch);
    startWatch = null;
    clearInterval(startTimer);
    startTimer = null;
    startFix = null;
    suggestedID = null;
    chosenStartID = null;
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
      button.setAttribute("aria-label", "Choose starting point " + pin.name);
      button.setAttribute("aria-pressed", String(pin.id === suggestedID));
      button.classList.toggle(
        "contour-floor-destination",
        pin.id === selectedID,
      );
      button.onclick = (event) => {
        event.stopPropagation();
        chosenStartID = pin.id;
        renderStartSuggestion();
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
        '<svg width="56" height="56" viewBox="0 0 56 56"><path d="M28 2 L39 24 L28 18 L17 24 Z" fill="#2469ca" fill-opacity=".7" stroke="white" stroke-width="1.5"/></svg>';
      Object.assign(direction.style, {
        position: "absolute",
        width: "56px",
        height: "56px",
        pointerEvents: "none",
        transform: `translate(-50%,-50%) rotate(${heading.degrees}deg)`,
      });
      container.appendChild(direction);
    }
    function position(project) {
      if (direction) {
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
    if (!startMap) {
      if (provider === "google" && window.google?.maps?.Map) {
        startMapProvider = "google";
        startMap = new window.google.maps.Map(host, {
          center: { lat: pending.latitude, lng: pending.longitude },
          disableDefaultUI: true,
          zoomControl: true,
          keyboardShortcuts: false,
          clickableIcons: false,
          tilt: 0,
          heading: 0,
          zoom: 19,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          gestureHandling: "cooperative",
        });
      } else if (window.L?.map) {
        startMapProvider = "leaflet";
        startMap = window.L.map(host, {
          attributionControl: false,
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
    const key = `${revision}:${suggestedID || "none"}:${ll ? "located" : "unlocated"}:${confirmedStart?.id || "raw"}`;
    const shouldFit = startFitKey !== key;
    startFitKey = key;
    if (startMapProvider === "google") {
      const gm = window.google.maps;
      const current = ll ? { lat: ll[0], lng: ll[1] } : null;
      startLayers.push(
        createGoogleImage(pending, startMap, "contour-start-floor-plan"),
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
              fillColor: "#2469ca",
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
      if (current) bounds.extend(current);
      corners.forEach((point) =>
        bounds.extend({ lat: point[0], lng: point[1] }),
      );
      if (target && current) {
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
        startMap.fitBounds(bounds, 35);
        startMap.setOptions({ maxZoom: 20 });
      }
    } else {
      const L = window.L;
      startMap.invalidateSize();
      startLayers.push(
        createLeafletImage(
          pending,
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
            fillColor: "#2469ca",
            fillOpacity: 1,
          }).addTo(startMap),
        );
      }
      if (target && ll) {
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
            ...corners,
            ...(ll ? [ll] : []),
            ...(target ? [target.ll] : []),
          ]),
          { padding: [35, 35], maxZoom: 20 },
        );
    }
    startLayers.push(createFloorPins(pending, startMap, startMapProvider, fix));
    host.dataset.provider = startMapProvider;
    host.dataset.hasLine = String(!!target && !!ll);
  }
  function renderStartSuggestion() {
    const ui = floorUI;
    if (!ui || ui.root.hidden || ui.startSection.hidden) return;
    const fresh = startFix && Date.now() - startFix.timestamp <= 30000;
    const renderKey = JSON.stringify([
      !confirmedStart && fresh ? startFix : null,
      revision,
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
    ui.startSelect.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Suggest nearest landmark automatically";
    ui.startSelect.appendChild(auto);
    (pending.destinations || []).forEach((pin, index) => {
      const option = document.createElement("option");
      option.value = pin.id;
      option.textContent = `${index + 1}. ${pin.name}`;
      ui.startSelect.appendChild(option);
    });
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
      ? `Moves your blue position dot to ${target.pin.name}. Keeps your compass direction.`
      : "Choose a numbered pin, then set your position here.";
    ui.resetPosition.hidden = !confirmedStart;
    ui.startStatus.textContent =
      (confirmedStart
        ? indoorPose?.status === "tracking"
          ? `Indoor position · ${indoorPose.steps} steps · approximately ${indoorPose.distance.toFixed(1)} m. Phone held in front; GPS does not move this dot. `
          : indoorPose?.status === "motion-unavailable"
            ? "Motion tracking unavailable. Allow Motion & Fitness in Settings, then set your position again. "
            : indoorPose && indoorPose.status !== "starting"
              ? "Motion tracking paused. Set your position again before continuing. "
              : "Starting step tracking. Allow Motion & Fitness access if requested; waiting for heading/motion. "
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
      confirmedStart.id !== destination.id &&
      typeof window.ContourBridge?.startFloorAR === "function";
    floorUI.openAR.disabled = !ready;
    floorUI.arHint.textContent = !confirmedStart
      ? "Set your starting position on the map first."
      : indoorPose?.status !== "tracking"
        ? "Allow motion access and set your position to start indoor tracking."
        : !destination
          ? "Choose a saved destination to open camera navigation."
          : confirmedStart.id === destination.id
            ? "Choose a destination different from your starting point."
            : `Open AR toward ${destination.name}. Position comes from steps and turns, not GPS. Camera-only obstacle cues; no wall-aware route yet.`;
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
      .contour-floor-pin{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;border:2px solid white;border-radius:50%;background:rgba(36,105,202,.48);color:#102c52;font:bold 13px system-ui;min-width:36px;min-height:36px;box-shadow:0 1px 5px #0006;cursor:pointer}
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
    controls.append(label, openAR, arHint, clear, edit, status);
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
    confirmStart.onclick = confirmStartingPoint;
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
    const startMap = document.createElement("div");
    startMap.className = "contour-start-map";
    startMap.setAttribute(
      "aria-label",
      "Reported phone position and suggested indoor start",
    );
    const note = document.createElement("p");
    note.textContent =
      "Tap a pin, then confirm only when you are there. Orange: chosen start. Green ring: destination. Blue dot: phone position, corrected after confirmation. Arrow: phone compass heading. Dashed line is not a walking route.";
    startSection.append(heading, startStatus, startChoices, startMap, note);
    controls.before(startSection);
    floorUI = {
      root,
      image,
      floor,
      canvas,
      pins: startMap,
      controls,
      openAR,
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
      startMap,
      originals: new Map(),
      disabled: new Map(),
      ownedURL: null,
    };
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
    if (document.hidden) stopStartLocation();
    else syncFloorMap();
  });
  window.addEventListener("pagehide", stopStartLocation);
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
