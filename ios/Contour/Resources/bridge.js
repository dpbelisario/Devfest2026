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
      remove(id);
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
    for (const [id, entry] of [...positions]) {
      clearTimeout(entry.timer);
      if (!entry.watch) positions.delete(id);
      entry.success(position);
    }
    if (!positions.size) send("locationStop");
  };
  window.contourIOSLocationError = (code, message) => {
    for (const [id, entry] of [...positions]) {
      remove(id);
      if (typeof entry.error === "function") entry.error({ code, message });
    }
  };
  window.contourIOSNotificationStatus = (allowed) => {
    notifications = allowed === true;
    if (window.onAlertSetupChanged) window.onAlertSetupChanged();
  };
  window.ContourBridge = {
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
    for (const id of ["alClose", "alMap", "alAr"]) {
      document
        .getElementById(id)
        ?.addEventListener("click", () => send("stopHaptics"));
    }
    send("notificationStatus");
  });
})();
