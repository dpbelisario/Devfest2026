// Optional integration test: Playwright + Chrome; LEAFLET_TEST_FILE points to Leaflet 1.9.4.
const { chromium } = require("playwright");
const { readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const html = readFileSync(
    path.join(__dirname, "../../android/app/src/main/assets/contour.html"),
    "utf8",
  );
  const bridge = readFileSync(
    path.join(__dirname, "../Contour/Resources/native-floor-overlay.js"),
    "utf8",
  );
  const leaflet = readFileSync(
    process.env.LEAFLET_TEST_FILE || "/tmp/contour-leaflet.js",
    "utf8",
  );
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    });
    const page = await browser.newPage({
      viewport: { width: 393, height: 852 },
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", (route) =>
      route.request().url().startsWith(url) ? route.continue() : route.abort(),
    );
    await page.route("**/leaflet.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: leaflet }),
    );
    await page.addInitScript(bridge);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.L?.Map && window.ContourNativeFloorOverlay,
    );
    const value = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 200;
      const c = canvas.getContext("2d");
      c.fillStyle = "#fff";
      c.fillRect(0, 0, 400, 200);
      c.strokeStyle = "#222";
      c.lineWidth = 8;
      c.strokeRect(10, 10, 380, 180);
      c.strokeRect(10, 10, 150, 100);
      c.font = "24px sans-serif";
      c.fillStyle = "#222";
      c.fillText("Synthetic floor", 180, 80);
      return {
        version: 1,
        name: "Test floor",
        image: canvas.toDataURL().split(",")[1],
        latitude: 35.1545,
        longitude: 136.9645,
        width: 80,
        aspect: 0.5,
        angle: 35,
        opacity: 0.4,
        visible: true,
      };
    });
    const apply = (v, focus = false) =>
      page.evaluate(
        ({ v, focus }) => window.ContourNativeFloorOverlay.apply(v, focus),
        { v, focus },
      );
    assert.equal(await apply(value, true), true);
    const image = page.locator(".contour-native-floor-plan");
    await image.waitFor({ state: "visible" });
    const first = await image.evaluate((el) => ({
      width: parseFloat(el.style.width),
      height: parseFloat(el.style.height),
      angle: el.style.transform,
      opacity: el.style.opacity,
      complete: el.complete,
    }));
    assert.ok(first.width > 0);
    assert.equal(first.height / first.width, 0.5);
    assert.equal(first.angle, "rotate(35deg)");
    assert.equal(first.opacity, "0.4");
    assert.equal(first.complete, true);
    assert.equal(
      await apply({ ...value, width: 160, angle: 0, opacity: 0.8 }),
      true,
    );
    const second = await image.evaluate((el) => ({
      width: parseFloat(el.style.width),
      angle: el.style.transform,
      opacity: el.style.opacity,
    }));
    assert.ok(Math.abs(second.width / first.width - 2) < 0.05);
    assert.equal(second.angle, "rotate(0deg)");
    assert.equal(second.opacity, "0.8");
    assert.equal(await apply({ ...value, latitude: NaN }), false);
    assert.equal(await image.count(), 1);
    assert.equal(await apply({ ...value, visible: false }), true);
    assert.equal(await image.count(), 0);
    assert.equal(await apply(value), true);
    assert.equal(await image.count(), 1);
    await page.screenshot({ path: "/tmp/contour-native-overlay-leaflet.png" });
    assert.equal(await apply(null), true);
    assert.equal(await image.count(), 0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.L?.Map && window.ContourNativeFloorOverlay,
    );
    assert.equal(await apply(value, true), true);
    await image.waitFor({ state: "visible" });
    assert.equal(await image.count(), 1);
    const pinned = {
      ...value,
      destinations: [
        { id: "room-a", name: "Room A", x: 0.2, y: 0.7 },
        { id: "exit-b", name: "Exit B", x: 0.8, y: 0.3 },
      ],
    };
    assert.equal(await apply(pinned), true);
    assert.equal(await page.locator("#map .contour-floor-pin").count(), 0);
    assert.equal(
      await page.locator(".contour-floor-pin").count(),
      0,
      "Pins stay absent until Floor Maps opens",
    );
    // Exercise Google's OverlayView contract without credentials or network tiles.
    await page.evaluate(() => {
      const pane = document.createElement("div");
      pane.id = "google-test-pane";
      document.body.appendChild(pane);
      window.google = {
        maps: {
          Polyline: class {
            constructor(options) {
              window.testGoogleLine = options;
            }
            setMap(map) {
              this.map = map;
            }
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
              return { overlayLayer: pane, overlayMouseTarget: pane };
            }
            getProjection() {
              return {
                fromLatLngToDivPixel: (p) => ({
                  x: p.lng * 1000,
                  y: -p.lat * 1000,
                }),
              };
            }
          },
        },
      };
      window.googleTestMap = {
        panTo() {},
        setZoom() {},
        setOptions(value) {
          this.options = value;
        },
        fitBounds(bounds) {
          this.bounds = bounds;
        },
      };
      window.dispatchEvent(
        new CustomEvent("contour-map-ready", {
          detail: {
            provider: "google",
            map: {
              native: window.googleTestMap,
              root: document.getElementById("map"),
            },
          },
        }),
      );
    });
    assert.equal(await apply(pinned, true), true);
    assert.equal(
      await page.locator("#google-test-pane .contour-floor-pin").count(),
      0,
    );
    const googleImage = page.locator(
      "#google-test-pane .contour-native-floor-plan",
    );
    const googleFirst = await googleImage.evaluate((el) => ({
      width: parseFloat(el.style.width),
      height: parseFloat(el.style.height),
      angle: el.style.transform,
    }));
    assert.ok(googleFirst.width > 0);
    assert.ok(
      Math.abs(googleFirst.height / googleFirst.width - value.aspect) < 0.00001,
    );
    assert.equal(googleFirst.angle, "rotate(35deg)");
    assert.equal(
      await page.evaluate(() => window.googleTestMap.options.restriction),
      null,
    );
    assert.equal(await apply({ ...value, width: 160 }), true);
    const googleWidth = await googleImage.evaluate((el) =>
      parseFloat(el.style.width),
    );
    assert.ok(Math.abs(googleWidth / googleFirst.width - 2) < 0.001);
    assert.equal(await apply({ ...value, visible: false }), true);
    assert.equal(await googleImage.count(), 0);
    assert.equal(
      await page.locator("#google-test-pane .contour-floor-pin").count(),
      0,
    );
    assert.equal(await apply(value), true);
    assert.equal(await apply(null), true);
    assert.equal(await googleImage.count(), 0);
    console.log(
      "PASS: Google OverlayView contract preserves geometry, replaces/hides/clears the image, and focuses the saved bounds (SDK mocked).",
    );
    console.log(
      "PASS: actual Contour Leaflet page receives native image/alignment, updates scale/rotation/opacity, hides, clears, rejects invalid data, and restores after reload.",
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
