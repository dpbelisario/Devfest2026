// Regression for shared card layout and the separate native floor-overlay entry.
const { chromium } = require("playwright");
const { readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");
(async () => {
  const html = readFileSync("android/app/src/main/assets/contour.html", "utf8");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 393, height: 852 },
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.abort(),
    );
    await page.addInitScript(() => {
      window.openedOverlay = 0;
      window.openedExit = 0;
      window.ContourBridge = {
        openFloorOverlay() {
          window.openedOverlay++;
        },
        startLibraryExitAR() {
          window.openedExit++;
        },
        translateText() {},
      };
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const library = page
      .locator(".card")
      .filter({ hasText: "Central Library" })
      .first();
    await library.waitFor();
    assert.equal(await library.locator(".cta").innerText(), "3D AR directions");
    await library
      .locator(".name")
      .evaluate(
        (el) =>
          (el.textContent =
            "Central Library with a much longer name that wraps onto several lines"),
      );
    const bottoms = await page
      .locator(".card .cta")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getBoundingClientRect().bottom),
      );
    assert.ok(bottoms.length > 1);
    assert.ok(
      Math.max(...bottoms) - Math.min(...bottoms) < 1,
      "AR buttons must share the bottom baseline despite wrapped names",
    );
    assert.equal(await page.locator(".contour-native-floor-plan").count(), 0);
    await library.locator(".det").dblclick({ force: true });
    assert.equal(await page.evaluate(() => window.openedOverlay), 1);
    await library.locator(".det").click({ force: true });
    await page.locator("#floorOverlayBtn").waitFor({ state: "visible" });
    await page.locator("#floorOverlayBtn").click({ force: true });
    assert.equal(await page.evaluate(() => window.openedOverlay), 2);
    await page.locator("#arBtn").click({ force: true });
    await page.waitForFunction(() => window.openedExit === 1);
    console.log(
      "PASS: bottom-aligned AR buttons with wrapped text; separate overlay in Details/double-tap; library AR still opens directly.",
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
