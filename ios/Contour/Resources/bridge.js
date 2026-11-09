(() => {
  const send = (action, fields = {}) =>
    window.webkit.messageHandlers.contour.postMessage({ action, ...fields });
  let notifications = false;
  let sequence = 0;
  const positions = new Map();
  const remove = (id) => {
    const entry = positions.get(id);
    if (entry) clearTimeout(entry.timer);
    positions.delete(id);
    if (!positions.size) send("locationStop");
  };
  const request = (success, error, options = {}, watch = false) => {
    if (typeof success !== "function")
      throw new TypeError("A location callback is required.");
    const id = ++sequence;
    const timeout = Number.isFinite(options.timeout)
      ? Math.max(0, options.timeout)
      : 30000;
    const timer = setTimeout(() => {
      if (!watch) remove(id);
      else {
        const entry = positions.get(id);
        if (entry) entry.timer = null;
      }
      if (typeof error === "function")
        error({ code: 3, message: "Location request timed out." });
    }, timeout);
    positions.set(id, { success, error, watch, timer });
    send("locationStart");
    return id;
  };
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (success, error, options) => {
        request(success, error, options);
      },
      watchPosition: (success, error, options) =>
        request(success, error, options, true),
      clearWatch: remove,
    },
  });
  window.contourIOSLocation = (position) => {
    // Older hosted pages may rebuild Details on a GPS fix. Preserve the reader's
    // position until the hosted HTML receives its metrics-only rendering update.
    const detail = document.getElementById?.("detail");
    const sheet = document.getElementById?.("sheet");
    const name = document.getElementById?.("dName")?.textContent;
    const readingOffset = detail?.scrollTop ?? 0;
    try {
      for (const [id, entry] of [...positions]) {
        clearTimeout(entry.timer);
        if (!entry.watch) positions.delete(id);
        entry.success(position);
      }
    } finally {
      if (
        readingOffset > 0 &&
        sheet &&
        !sheet.hidden &&
        document.getElementById?.("detail") === detail &&
        document.getElementById?.("dName")?.textContent === name
      ) {
        detail.scrollTop = readingOffset;
      }
      if (!positions.size) send("locationStop");
    }
  };
  window.contourIOSLocationError = (code, message) => {
    for (const [id, entry] of [...positions]) {
      // A temporary error must not silently dispose the ongoing location watch.
      if (!entry.watch || code === 1) remove(id);
      else {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (typeof entry.error === "function") entry.error({ code, message });
    }
  };
  window.contourIOSNotificationStatus = (allowed) => {
    notifications = allowed === true;
    if (window.onAlertSetupChanged) window.onAlertSetupChanged();
  };
  window.ContourBridge = {
    openFloorOverlay: () => send("openFloorOverlay"),
    startFloorAR: (goal) => send("startFloorAR", { goal }),
    startIndoorTracking: (request) => send("startIndoorTracking", { request }),
    pauseIndoorTracking: () => send("pauseIndoorTracking"),
    clearIndoorTracking: () => send("clearIndoorTracking"),
    startFloorHeading: () => send("floorHeadingStart"),
    stopFloorHeading: () => send("floorHeadingStop"),
    startLibraryExitAR: () => send("startLibraryExitAR"),
    startObstacleScan: () => send("startObstacleScan"),
    stopObstacleScan: () => send("stopObstacleScan"),
    alertSetupStatus: () => JSON.stringify({ notifications }),
    openAlertSetting: (which) =>
      send(
        which === "notifications" && !notifications
          ? "notifications"
          : "settings",
      ),
    testAlert: (kind, delayMs) => {
      if (kind === "eew") send("testAlert", { delayMs });
    },
    startListening: (language) => send("startListening", { language }),
    stopListening: () => send("stopListening"),
    // iOS uses the existing untranslated-name fallback; Android ML Kit remains on Android.
    translateText: (text, source, target, callback) => {
      if (
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callback) &&
        typeof window[callback] === "function"
      ) {
        window[callback](
          "On-device translation is not available in this iOS build.",
          null,
        );
      }
    },
  };
  document.addEventListener("DOMContentLoaded", () => {
    // Keep the installed iPhone label current while older hosted HTML is deployed.
    const floorMapsLabel = document
      .getElementById("indoorBtn")
      ?.querySelector("span");
    if (floorMapsLabel) {
      const rename = () => {
        if (floorMapsLabel.textContent === "Library floor maps")
          floorMapsLabel.textContent = "Floor Maps";
      };
      new MutationObserver(rename).observe(floorMapsLabel, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      rename();
    }
    for (const id of ["alClose", "alMap", "alAr"]) {
      document
        .getElementById(id)
        ?.addEventListener("click", () => send("stopHaptics"));
    }
    send("notificationStatus");
  });
})();
