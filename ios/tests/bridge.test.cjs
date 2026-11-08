const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const source = readFileSync(
  require("node:path").join(__dirname, "../Contour/Resources/bridge.js"),
  "utf8",
);
function page() {
  const sent = [],
    timers = new Map();
  let timer = 0;
  const context = {
    navigator: {},
    document: { addEventListener() {} },
    setTimeout(fn) {
      timers.set(++timer, fn);
      return timer;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    webkit: {
      messageHandlers: {
        contour: {
          postMessage(message) {
            sent.push(message);
          },
        },
      },
    },
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { context, sent, timers };
}
test("one-shot location completes once; a watch continues until cleared", () => {
  const { context: p, sent, timers } = page();
  let once = 0,
    watched = 0;
  p.navigator.geolocation.getCurrentPosition(() => once++);
  const id = p.navigator.geolocation.watchPosition(() => watched++);
  p.contourIOSLocation({ coords: { latitude: 35, longitude: 136 } });
  p.contourIOSLocation({ coords: { latitude: 35, longitude: 137 } });
  assert.equal(once, 1);
  assert.equal(watched, 2);
  assert.equal(timers.size, 0);
  p.navigator.geolocation.clearWatch(id);
  assert.equal(sent.at(-1).action, "locationStop");
});
test("floor overlay opens separately through the trusted native bridge", () => {
  const { context: p, sent } = page();
  p.ContourBridge.openFloorOverlay();
  assert.equal(sent.at(-1).action, "openFloorOverlay");
});
test("denial and timeout release native location and report an error", () => {
  for (const fail of ["denied", "timeout"]) {
    const { context: p, sent, timers } = page();
    let code;
    p.navigator.geolocation.getCurrentPosition(
      () => assert.fail("Unexpected fix"),
      (e) => (code = e.code),
    );
    if (fail === "denied") p.contourIOSLocationError(1, "Denied");
    else [...timers.values()][0]();
    assert.equal(code, fail === "denied" ? 1 : 3);
    assert.equal(sent.at(-1).action, "locationStop");
  }
});
test("notification status and earthquake test use the native bridge", () => {
  const { context: p, sent } = page();
  p.ContourBridge.openAlertSetting("notifications");
  assert.equal(sent.at(-1).action, "notifications");
  p.contourIOSNotificationStatus(true);
  assert.equal(
    JSON.parse(p.ContourBridge.alertSetupStatus()).notifications,
    true,
  );
  p.ContourBridge.testAlert("eew", 5000);
  assert.equal(sent.at(-1).action, "testAlert");
  assert.equal(sent.at(-1).delayMs, 5000);
});

test("obstacle scanning uses the native camera bridge without location requests", () => {
  const { context: p, sent } = page();
  p.ContourBridge.startLibraryExitAR();
  assert.equal(sent.at(-1).action, "startLibraryExitAR");
  p.ContourBridge.startObstacleScan();
  assert.equal(sent.at(-1).action, "startObstacleScan");
  p.ContourBridge.stopObstacleScan();
  assert.equal(sent.at(-1).action, "stopObstacleScan");
  assert.ok(!sent.some((message) => message.action === "locationStart"));
});

test("location watches survive temporary errors and initial timeout", () => {
  for (const temporary of ["unavailable", "timeout"]) {
    const { context: p, sent, timers } = page();
    let fixes = 0,
      errors = 0;
    const id = p.navigator.geolocation.watchPosition(
      () => fixes++,
      () => errors++,
    );
    if (temporary === "unavailable")
      p.contourIOSLocationError(2, "Temporary error");
    else [...timers.values()][0]();
    assert.equal(errors, 1);
    assert.ok(!sent.some((message) => message.action === "locationStop"));
    p.contourIOSLocation({ coords: { latitude: 35, longitude: 137 } });
    assert.equal(fixes, 1);
    p.navigator.geolocation.clearWatch(id);
    assert.equal(sent.at(-1).action, "locationStop");
  }
});
test("location watch permission denial stops native updates", () => {
  const { context: p, sent } = page();
  let fixes = 0;
  p.navigator.geolocation.watchPosition(
    () => fixes++,
    () => {},
  );
  p.contourIOSLocationError(1, "Denied");
  p.contourIOSLocation({ coords: { latitude: 35, longitude: 137 } });
  assert.equal(fixes, 0);
  assert.equal(sent.at(-1).action, "locationStop");
});
