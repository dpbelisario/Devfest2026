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

test("native fixes preserve reading position on older hosted Details pages", () => {
  const { context: p } = page();
  const detail = { scrollTop: 180 };
  const sheet = { hidden: false };
  const title = { textContent: "Central Library" };
  p.document.getElementById = (id) => ({ detail, sheet, dName: title })[id];
  p.navigator.geolocation.watchPosition(() => {
    detail.scrollTop = 0;
  });
  p.contourIOSLocation({ coords: { latitude: 35, longitude: 137 } });
  assert.equal(detail.scrollTop, 180);
  p.navigator.geolocation.watchPosition(() => {
    title.textContent = "Different destination";
    detail.scrollTop = 0;
  });
  p.contourIOSLocation({ coords: { latitude: 35, longitude: 137 } });
  assert.equal(
    detail.scrollTop,
    0,
    "Do not restore another destination's scroll position",
  );
});

test("floor compass subscriptions use separate native actions", () => {
  const { context: p, sent } = page();
  p.ContourBridge.startFloorHeading();
  p.ContourBridge.stopFloorHeading();
  assert.deepEqual(
    sent.map((value) => value.action),
    ["floorHeadingStart", "floorHeadingStop"],
  );
});

test("saved floor AR passes a structured confirmed goal to native", () => {
  const { context: p, sent } = page();
  const goal = {
    version: 1,
    floor: "2F",
    start: { name: "Desk", latitude: 35, longitude: 136 },
    destination: { name: "Room", latitude: 35.0001, longitude: 136 },
  };
  p.ContourBridge.startFloorAR(goal);
  assert.equal(sent.at(-1).action, "startFloorAR");
  assert.deepEqual(sent.at(-1).goal, goal);
});

test("indoor step tracking passes its origin and has explicit pause/clear actions", () => {
  const { context: p, sent } = page();
  const request = {
    sessionID: "confirmed",
    floor: "2F",
    latitude: 35,
    longitude: 136,
    heading: 90,
    stepLength: 0.72,
  };
  p.ContourBridge.startIndoorTracking(request);
  assert.deepEqual(sent.at(-1).request, request);
  p.ContourBridge.pauseIndoorTracking();
  p.ContourBridge.clearIndoorTracking();
  assert.deepEqual(
    sent.map((value) => value.action),
    ["startIndoorTracking", "pauseIndoorTracking", "clearIndoorTracking"],
  );
});
