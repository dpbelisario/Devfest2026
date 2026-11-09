// Real shared Floor Maps UI + native saved-overlay adapter, without hosted deployment.
const { chromium } = require("playwright");
const { readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");
(async () => {
  const html = readFileSync("android/app/src/main/assets/contour.html", "utf8");
  const adapter = readFileSync(
    "ios/Contour/Resources/native-floor-overlay.js",
    "utf8",
  );
  const server = createServer((req, res) => {
    if (req.url.endsWith("maps-config")) {
      res.setHeader("Content-Type", "application/json");
      res.end('{"browserKey":null}');
    } else if (req.url === "/api/alerts") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          weather: null,
          bulletins: [],
          checkedAt: new Date().toISOString(),
        }),
      );
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(html);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 393, height: 852 },
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.abort(),
    );
    await page.addInitScript(adapter);
    await page.addInitScript(() => {
      localStorage.setItem("contour.lang", "en");
      window.startWatches = new Map();
      window.startWatchSequence = 0;
      window.startCleared = [];
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition(success, error) {
            error?.({ code: 2, message: "No test fix yet" });
          },
          watchPosition(success, error, options) {
            if (options.maximumAge !== 0) return -1;
            const id = ++window.startWatchSequence;
            window.startWatches.set(id, { success, error });
            return id;
          },
          clearWatch(id) {
            window.startCleared.push(id);
            window.startWatches.delete(id);
          },
        },
      });
      window.emitStartFix = (latitude, longitude, accuracy = 12, age = 0) => {
        for (const watch of window.startWatches.values())
          watch.success({
            coords: { latitude, longitude, accuracy },
            timestamp: Date.now() - age,
          });
      };
      window.ContourBridge = {
        startIndoorTracking(request) {
          window.indoorRequest = request;
          window.contourIOSIndoorPose({
            ...request,
            steps: 0,
            distance: 0,
            status: "tracking",
            timestamp: Date.now(),
          });
        },
        pauseIndoorTracking() {
          if (window.indoorRequest)
            window.contourIOSIndoorPose({
              ...window.indoorRequest,
              steps: 0,
              distance: 0,
              status: "paused",
              timestamp: Date.now(),
            });
        },
        clearIndoorTracking() {
          window.indoorRequest = null;
        },
        startFloorAR(goal) {
          window.lastFloorARGoal = goal;
        },
        openFloorOverlay() {
          window.editFloorCalls = (window.editFloorCalls || 0) + 1;
        },
        translateText() {},
      };
      window.addEventListener("contour-map-ready", (event) => {
        window.generalMap = event.detail.map;
      });
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("#libraryFloor").waitFor({ state: "attached" });
    const value = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 200;
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 400, 200);
      context.fillStyle = "black";
      context.font = "24px sans-serif";
      context.fillText("Room A", 30, 40);
      return {
        version: 1,
        name: "My saved 2F plan",
        image: canvas.toDataURL().split(",")[1],
        latitude: 35.155,
        longitude: 136.964,
        width: 70,
        aspect: 0.5,
        angle: 26,
        opacity: 0.5,
        visible: true,
        floor: "2F",
        libraryReferenceImage: false,
        destinations: [
          { id: "a", name: "Room A <text>", x: 0.2, y: 0.7 },
          { id: "b", name: "Desk B", x: 0.8, y: 0.3 },
        ],
      };
    });
    const apply = (v) =>
      page.evaluate((v) => window.ContourNativeFloorOverlay.apply(v, false), v);
    await apply(value);
    assert.equal(
      await page.locator("#map .contour-native-floor-plan").count(),
      1,
    );
    assert.equal(await page.locator(".contour-floor-pin").count(), 0);
    const library = page
      .locator(".card")
      .filter({ hasText: "Central Library" })
      .first();
    const open = async () => {
      await page.locator("#sheet").waitFor({ state: "hidden" });
      await library.locator(".det").click({ force: true });
      await page.waitForFunction(
        () => document.activeElement === document.getElementById("closeBtn"),
      );
      await page.locator("#indoorBtn").waitFor({ state: "visible" });
      await page.locator("#indoorBtn").click();
      await page.locator("#libraryMaps").waitFor({ state: "visible" });
    };
    assert.equal(await page.evaluate(() => window.startWatches.size), 0);
    await open();
    assert.equal(await page.evaluate(() => window.startWatches.size), 1);
    for (const selector of [
      "#libraryRelativeDemo",
      "#libraryPlan3dButton",
      "#libraryPhoto",
      "#libraryStart",
      "#libraryDestination",
      "#libraryConfirm",
      "#libraryGuide",
    ]) {
      assert.equal(
        await page.locator(selector).isVisible(),
        false,
        `${selector} is removed from the iPhone floor-map UI`,
      );
    }
    assert.equal(
      await page
        .getByText("About this route preview", { exact: true })
        .isVisible(),
      false,
    );
    assert.equal(
      await page
        .getByText("Photo assistance details", { exact: true })
        .isVisible(),
      false,
    );
    assert.equal(await page.locator("#libraryFloor").isVisible(), true);

    assert.match(
      await page.locator(".contour-start-status").textContent(),
      /Waiting/,
    );
    assert.equal(await page.locator(".library-map-scroll").isHidden(), true);
    assert.equal(
      await page.locator(".contour-start-map .contour-floor-pin").count(),
      2,
    );
    await page.evaluate(() => window.emitStartFix(35.155, 136.964));
    await page.locator('.contour-start-map[data-has-line="true"]').waitFor();
    assert.equal(
      await page
        .getByLabel("Starting point", { exact: true })
        .locator("option")
        .count(),
      3,
    );
    const previewImage = page.locator(
      ".contour-start-map .contour-start-floor-plan",
    );
    assert.equal(await previewImage.count(), 1);
    assert.equal(
      await previewImage.getAttribute("src"),
      "data:image/png;base64," + value.image,
    );
    assert.equal(
      await previewImage.evaluate((image) => image.style.transform),
      "rotate(26deg)",
    );
    assert.ok(
      await previewImage.evaluate((image) => parseFloat(image.style.width) > 0),
    );
    await page
      .locator(".contour-start")
      .screenshot({ path: "/tmp/contour-start-with-floor-overlay.png" });
    assert.match(
      await page.locator(".contour-start-status").textContent(),
      /accuracy approximately ±12 m/,
    );
    assert.equal(
      await page.locator("#map .contour-suggested-start").count(),
      0,
    );
    await page
      .getByRole("button", {
        name: "Choose starting point Desk B",
        exact: true,
      })
      .click();
    assert.match(
      await page.locator(".contour-start-status").textContent(),
      /Chosen start: 2. Desk B/,
    );
    const previewLine = () =>
      page.locator(
        ".contour-start-map .leaflet-overlay-pane path.leaflet-interactive[stroke-dasharray]",
      );
    const oldLine = await previewLine().getAttribute("d");
    await page.evaluate(() => window.emitStartFix(35.1551, 136.9641));
    assert.notEqual(
      await previewLine().getAttribute("d"),
      oldLine,
      "GPS updates the dashed line origin",
    );
    await page.getByLabel("Starting point", { exact: true }).selectOption("");
    await page.evaluate(() => window.emitStartFix(35.155, 136.964, 250));
    assert.match(
      await page.locator(".contour-start-status").textContent(),
      /too uncertain/,
    );
    assert.equal(await previewLine().count(), 0);
    await page.evaluate(() => window.emitStartFix(36, 137, 10));
    assert.match(
      await page.locator(".contour-start-status").textContent(),
      /Tap any location pin/,
    );
    assert.equal(await previewLine().count(), 0);
    await page
      .getByRole("button", {
        name: "Choose starting point Desk B",
        exact: true,
      })
      .click();
    assert.equal(await previewLine().count(), 1);
    await page.evaluate(() => window.emitStartFix(35.155, 136.964, 12, 60000));
    assert.equal(await page.locator(".contour-start-map").isHidden(), false);
    await page.evaluate(() => {
      for (const watch of window.startWatches.values())
        watch.error({ code: 1 });
    });
    assert.match(
      await page.locator(".contour-start-status").textContent(),
      /Location access is off/,
    );
    await page.evaluate(() => window.emitStartFix(35.155, 136.964));
    const pins = page.locator("#libraryMaps .contour-floor-pin");
    await pins.first().waitFor();
    const expected = "data:image/png;base64," + value.image;
    assert.equal(
      await page.locator("#libraryMapImage").getAttribute("src"),
      expected,
    );
    assert.equal(await pins.count(), 2);
    assert.equal(await page.locator("#map .contour-floor-pin").count(), 0);
    assert.equal(
      await page.locator("#libraryConfirm").isDisabled(),
      true,
      "Unrelated legacy routes must not run over an imported custom image",
    );
    assert.equal(
      await page.locator("#libraryMapSource").getAttribute("href"),
      null,
    );
    const center = await page.evaluate(() => {
      window.generalMap.stop();
      return window.generalMap.getCenter();
    });
    await page
      .getByRole("button", {
        name: "Choose starting point Room A <text>",
        exact: true,
      })
      .click();
    assert.match(
      await page.locator(".contour-start-status").textContent(),
      /Room A <text>/,
    );
    assert.deepEqual(
      await page.evaluate(() => window.generalMap.getCenter()),
      center,
      "Selecting a floor pin must not move the general map",
    );
    assert.equal(await page.locator(".contour-floor-status text").count(), 0);
    const openAR = page.getByRole("button", {
      name: "Open AR navigation",
      exact: true,
    });
    assert.equal(await openAR.isDisabled(), true);
    await page.getByLabel("Saved floor destinations").selectOption("b");
    assert.equal(
      await openAR.isDisabled(),
      true,
      "An unconfirmed suggestion cannot start AR",
    );
    await page.evaluate(() =>
      window.contourIOSHeading({
        degrees: 97,
        accuracy: 8,
        timestamp: Date.now(),
      }),
    );
    await page
      .getByRole("button", { name: "Set my position here", exact: true })
      .click();
    assert.equal(await openAR.isEnabled(), true);
    await page.evaluate(() =>
      window.contourIOSHeading({
        degrees: 97,
        accuracy: 8,
        timestamp: Date.now(),
      }),
    );
    await openAR.click();
    const arGoal = await page.evaluate(() => window.lastFloorARGoal);
    assert.equal(arGoal.heading.degrees, 97);
    assert.equal(arGoal.floor, "2F");
    assert.equal(arGoal.start.name, "Room A <text>");
    assert.equal(arGoal.destination.name, "Desk B");
    assert.ok(
      Number.isFinite(arGoal.start.latitude) &&
        Number.isFinite(arGoal.destination.longitude),
    );
    await page.getByLabel("Saved floor destinations").selectOption("a");
    assert.equal(
      await openAR.isDisabled(),
      true,
      "Start and destination must differ",
    );
    await page.getByLabel("Saved floor destinations").selectOption("b");
    await page
      .getByRole("button", {
        name: "Use uncorrected phone position",
        exact: true,
      })
      .click();
    assert.equal(await openAR.isDisabled(), true);
    assert.equal(
      await page
        .locator('.contour-floor-pin.contour-floor-destination[data-id="b"]')
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator('.contour-floor-pin[aria-pressed="true"][data-id="a"]')
        .count(),
      1,
    );
    assert.match(
      await page.locator(".contour-floor-status").textContent(),
      /Desk B/,
    );
    await page.locator("#libraryFloor").selectOption("1F");
    assert.equal(await page.evaluate(() => window.startWatches.size), 0);
    assert.equal(await page.locator(".contour-start").isHidden(), true);
    assert.equal(await page.locator("#libraryFloor").isVisible(), true);
    assert.equal(await page.locator("#libraryPhoto").isVisible(), false);

    assert.equal(await pins.count(), 0);
    assert.notEqual(
      await page.locator("#libraryMapImage").getAttribute("src"),
      expected,
    );
    assert.ok(await page.locator("#libraryMapSource").getAttribute("href"));
    await page.locator("#libraryFloor").selectOption("2F");
    assert.equal(await page.evaluate(() => window.startWatches.size), 1);
    await page.evaluate(() => window.emitStartFix(35.155, 136.964));
    assert.equal(
      await page.locator("#libraryMapImage").getAttribute("src"),
      expected,
    );
    assert.equal(await pins.count(), 2);
    const replacementImage = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 200;
      canvas.getContext("2d").fillRect(0, 0, 400, 200);
      return canvas.toDataURL().split(",")[1];
    });
    const updated = {
      ...value,
      image: replacementImage,
      name: "Updated saved plan",
      destinations: [
        { ...value.destinations[0], name: "Study desk", x: 0.35, y: 0.25 },
      ],
    };
    await apply(updated);
    assert.equal(
      await page.locator("#libraryMapImage").getAttribute("src"),
      "data:image/png;base64," + replacementImage,
    );
    assert.equal(await pins.count(), 1);
    assert.ok(
      await pins
        .first()
        .evaluate(
          (button) =>
            Number.isFinite(parseFloat(button.style.left)) &&
            Number.isFinite(parseFloat(button.style.top)),
        ),
    );
    await page
      .getByRole("button", {
        name: "Edit floor overlay / Detect labels",
        exact: true,
      })
      .click();
    assert.equal(await page.evaluate(() => window.editFloorCalls), 1);
    await apply({ ...updated, visible: false });
    assert.equal(
      await page.locator("#map .contour-native-floor-plan").count(),
      0,
    );
    assert.equal(
      await pins.count(),
      1,
      "Hiding the geographic overlay does not remove the saved plan from Floor Maps",
    );
    assert.equal(await apply({ ...updated, floor: "99F" }), false);
    await page.locator("#libraryMapClose").click();
    assert.equal(await page.evaluate(() => window.startWatches.size), 0);
    assert.equal(await page.locator(".contour-floor-pin").count(), 0);
    await open();
    await pins.first().waitFor();
    assert.equal(await pins.count(), 1);
    await page.evaluate(() => window.emitStartFix(35.155, 136.964));
    // Simulate a delayed Google SDK becoming available after the offline preview.
    await page.evaluate(() => {
      window.googleStartObjects = [];
      class Item {
        constructor(options) {
          this.options = options;
          this.map = options.map;
          window.googleStartObjects.push(this);
        }
        setMap(map) {
          this.map = map;
        }
      }
      window.google = {
        maps: {
          Map: class {
            constructor(host) {
              window.googleStartHost = host;
              this.pane = document.createElement("div");
              host.appendChild(this.pane);
            }
            fitBounds(bounds) {
              window.googleStartBounds = bounds.points;
            }
            setOptions() {}
          },
          LatLng: class {
            constructor(lat, lng) {
              this.lat = lat;
              this.lng = lng;
            }
          },
          OverlayView: class {
            setMap(map) {
              if (this.map) this.onRemove();
              this.map = map;
              if (map) {
                this.onAdd();
                this.draw();
              }
            }
            getPanes() {
              return {
                overlayLayer: this.map.pane,
                overlayMouseTarget: this.map.pane,
              };
            }
            getProjection() {
              return {
                fromLatLngToDivPixel: (point) => ({
                  x: point.lng * 1000,
                  y: -point.lat * 1000,
                }),
              };
            }
          },
          Marker: Item,
          Circle: Item,
          Polyline: Item,
          SymbolPath: { CIRCLE: "circle" },
          LatLngBounds: class {
            constructor() {
              this.points = [];
            }
            extend(point) {
              this.points.push(point);
            }
          },
        },
      };
      window.dispatchEvent(
        new CustomEvent("contour-map-ready", {
          detail: { provider: "google", map: { native: {} } },
        }),
      );
    });
    assert.equal(
      await page
        .locator(
          '.contour-start-map[data-provider="google"][data-has-line="true"]',
        )
        .count(),
      1,
    );
    assert.equal(await previewImage.count(), 1);
    assert.equal(
      await previewImage.getAttribute("src"),
      "data:image/png;base64," + replacementImage,
    );
    assert.equal(
      await previewImage.evaluate((image) => image.style.transform),
      "rotate(26deg)",
    );
    const googleLine = await page.evaluate(
      () =>
        window.googleStartObjects.find((item) => item.map && item.options.path)
          ?.options,
    );
    assert.deepEqual(googleLine.path[0], { lat: 35.155, lng: 136.964 });
    assert.equal(googleLine.icons[0].repeat, "12px");
    assert.equal(
      await page.evaluate(
        () =>
          window.googleStartObjects.filter(
            (item) => item.map && item.options.title,
          ).length,
      ),
      1,
    );
    await page.evaluate(() => window.emitStartFix(35.1551, 136.9641));
    assert.deepEqual(
      await page.evaluate(
        () =>
          window.googleStartObjects.find(
            (item) => item.map && item.options.path,
          ).options.path[0],
      ),
      { lat: 35.1551, lng: 136.9641 },
    );
    await page.evaluate(() =>
      window.contourIOSHeading({
        degrees: 87,
        accuracy: 8,
        timestamp: Date.now(),
      }),
    );
    const direction = page.locator(".contour-floor-heading");
    assert.match(await direction.getAttribute("style"), /rotate\(87deg\)/);
    const beforeConfirm = await page.evaluate(
      () =>
        window.googleStartObjects.find((item) => item.map && item.options.path)
          .options.path,
    );
    await page
      .getByRole("button", { name: "Set my position here", exact: true })
      .click();
    const confirmedPoint = await page.evaluate(
      () =>
        window.googleStartObjects.find((item) => item.map && item.options.title)
          .options.position,
    );
    assert.ok(Math.abs(confirmedPoint.lat - beforeConfirm[1].lat) < 1e-8);
    assert.ok(Math.abs(confirmedPoint.lng - beforeConfirm[1].lng) < 1e-8);
    assert.match(
      await direction.getAttribute("style"),
      /rotate\(87deg\)/,
      "Position confirmation preserves the facing heading",
    );
    await page.evaluate(() => window.emitStartFix(35.1552, 136.9642));
    const movedPoint = await page.evaluate(
      () =>
        window.googleStartObjects.find((item) => item.map && item.options.title)
          .options.position,
    );
    assert.deepEqual(
      movedPoint,
      confirmedPoint,
      "GPS fixes must not move a confirmed indoor position",
    );
    await page.evaluate(() =>
      window.contourIOSHeading({
        degrees: 123,
        accuracy: 8,
        timestamp: Date.now(),
      }),
    );
    assert.match(
      await direction.getAttribute("style"),
      /rotate\(87deg\)/,
      "Later compass readings must not replace the initial heading",
    );
    await page.evaluate(() =>
      window.contourIOSIndoorPose({
        ...window.indoorRequest,
        latitude: window.indoorRequest.latitude + 0.00001,
        longitude: window.indoorRequest.longitude,
        heading: 123,
        steps: 2,
        distance: 1.44,
        status: "tracking",
        timestamp: Date.now(),
      }),
    );
    assert.match(await direction.getAttribute("style"), /rotate\(123deg\)/);
    assert.deepEqual(
      await page.evaluate(
        () =>
          window.googleStartObjects.find(
            (item) => item.map && item.options.title,
          ).options.position,
      ),
      { lat: movedPoint.lat + 0.00001, lng: movedPoint.lng },
      "Only step tracking updates the confirmed indoor position",
    );
    await page
      .getByRole("button", {
        name: "Use uncorrected phone position",
        exact: true,
      })
      .click();
    assert.deepEqual(
      await page.evaluate(
        () =>
          window.googleStartObjects.find(
            (item) => item.map && item.options.title,
          ).options.position,
      ),
      { lat: 35.1552, lng: 136.9642 },
    );
    const alpha = await pins
      .first()
      .evaluate((button) => getComputedStyle(button).backgroundColor);
    assert.match(alpha, /^rgba\(/, "Pins have a translucent fill");
    await apply(null);
    assert.equal(await previewImage.count(), 0);
    assert.equal(
      await page.evaluate(
        () => window.googleStartObjects.filter((item) => item.map).length,
      ),
      0,
    );
    assert.equal(await page.evaluate(() => window.startWatches.size), 0);
    assert.equal(await pins.count(), 0);
    assert.notEqual(
      await page.locator("#libraryMapImage").getAttribute("src"),
      expected,
    );
    assert.ok(await page.locator("#libraryMapSource").getAttribute("href"));
    assert.deepEqual(pageErrors, []);
    console.log(
      "PASS: one map shows all selectable locations without GPS, pin clicks select the start, destination stays separate; Floor Maps syncs saved image/pins; start suggestions rank nearby labels, draw moving Google/offline position lines, reject stale/distant/inaccurate fixes, and clean up watches/markers on close or floor change (Google SDK mocked).",
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
