// iOS-only adapter: display the locally saved native floor plan on the existing Leaflet map.
(() => {
  let map = null;
  let provider = "leaflet";
  let layer = null;
  let pending = null;
  let hasPending = false;
  let focusPending = false;
  let hooked = false;

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
    typeof v.visible === "boolean";

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
    const pane =
      map.getPane("nativeFloorPlan") || map.createPane("nativeFloorPlan");
    pane.style.zIndex = "350";
    pane.style.pointerEvents = "none";
    const NativeImage = L.Layer.extend({
      onAdd() {
        this.image = L.DomUtil.create("img", "contour-native-floor-plan", pane);
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
    layer = new NativeImage().addTo(map);
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

  function drawGoogle(v) {
    const gm = window.google.maps;
    class NativeImage extends gm.OverlayView {
      onAdd() {
        this.image = document.createElement("img");
        this.image.className = "contour-native-floor-plan";
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
    layer = new NativeImage();
    layer.setMap(map.native);
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
      pending = value;
      hasPending = true;
      focusPending = focus;
      draw();
      return true;
    },
  };
})();
