// Optional browser regression test for the shared page; requires Playwright + Chrome.
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
  const leaflet = readFileSync(
    process.env.LEAFLET_TEST_FILE || "/tmp/contour-leaflet.js",
    "utf8",
  );
  const server = createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          sites: [],
          dataset: {},
          alerts: [],
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
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    });
    const page = await browser.newPage({
      viewport: { width: 393, height: 852 },
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.abort(),
    );
    await page.route("**/leaflet.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: leaflet }),
    );
    await page.addInitScript(() => {
      let hooked = false;
      document.addEventListener(
        "load",
        () => {
          if (!hooked && window.L?.Map) {
            hooked = true;
            window.L.Map.addInitHook(function () {
              if (this.getContainer().id === "map") window.testMap = this;
            });
          }
        },
        true,
      );
      window.gpsRequests = 0;
      window.watchRequests = 0;
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition(success, error) {
            window.gpsRequests++;
            window.gpsSuccess = success;
            window.gpsError = error;
          },
          watchPosition(success, error) {
            window.watchRequests++;
            window.watchSuccess = success;
            window.watchError = error;
            return 1;
          },
          clearWatch() {},
        },
      });
      window.locationSnapshot = () => {
        let me = null;
        const lines = [];
        window.testMap.eachLayer((layer) => {
          if (
            layer instanceof L.Marker &&
            layer.options.icon?.options.html?.includes('class="me"')
          )
            me = layer.getLatLng();
          if (
            layer instanceof L.Polyline &&
            layer.options.dashArray === "1 9" &&
            layer.getLatLngs().length === 2
          )
            lines.push(layer.getLatLngs());
        });
        return { me, lines };
      };
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        window.testMap &&
        window.gpsRequests === 1 &&
        window.watchRequests === 1,
    );
    assert.deepEqual(await page.evaluate(() => window.locationSnapshot()), {
      me: null,
      lines: [],
    });
    const fix = (latitude, longitude, age = 0) =>
      page.evaluate(
        ({ latitude, longitude, age }) => {
          const pos = {
            timestamp: Date.now() - age,
            coords: { latitude, longitude, accuracy: 8 },
          };
          window.watchSuccess(pos);
          if (window.gpsSuccess) {
            const success = window.gpsSuccess;
            window.gpsSuccess = null;
            success(pos);
          }
        },
        { latitude, longitude, age },
      );
    await fix(35.17, 136.955);
    let state = await page.evaluate(() => window.locationSnapshot());
    assert.equal(state.me.lat, 35.17);
    assert.equal(state.me.lng, 136.955);
    assert.equal(state.lines.length, 2);
    for (const line of state.lines) {
      assert.equal(line[0].lat, 35.17);
      assert.equal(line[0].lng, 136.955);
    }
    const target = state.lines[0][1];
    await fix(35.1705, 136.9555);
    state = await page.evaluate(() => window.locationSnapshot());
    assert.equal(state.me.lat, 35.1705);
    for (const line of state.lines) {
      assert.equal(line[0].lat, 35.1705);
      assert.equal(line[0].lng, 136.9555);
      assert.deepEqual(line[1], target);
    }
    await fix(35.68, 139.76);
    state = await page.evaluate(() => window.locationSnapshot());
    assert.equal(state.me.lng, 139.76);
    for (const line of state.lines) assert.equal(line[0].lng, 139.76);
    await fix(NaN, 136);
    await fix(35, 136, 60000);
    assert.equal(
      (await page.evaluate(() => window.locationSnapshot())).me.lng,
      139.76,
    );
    await page.locator("#locateBtn").click();
    await page.waitForFunction(() => window.testMap.getCenter().lng > 139);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.gpsError && window.watchError);
    await page.evaluate(() => {
      window.watchError({ code: 1 });
      window.gpsError({ code: 1 });
    });
    assert.deepEqual(await page.evaluate(() => window.locationSnapshot()), {
      me: null,
      lines: [],
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: startup requests GPS, demo dot/line hidden until fix, dot and both dashed lines follow movement, target retained, outside-Nagoya fixes accepted, stale/invalid fixes rejected, Locate centers live position, denial never draws demo guidance.",
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
