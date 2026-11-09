// Regression: live location, relayout and swipe handling must not interrupt Details reading.
const { chromium, webkit } = require("playwright");
const { readFileSync, existsSync } = require("node:fs");
const { createServer } = require("node:http");
const assert = require("node:assert/strict");
(async () => {
  const html = readFileSync("android/app/src/main/assets/contour.html", "utf8");
  const server = createServer((req, res) => {
    if (req.url.endsWith("maps-config")) {
      res.setHeader("Content-Type", "application/json");
      res.end('{"browserKey":null}');
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(html);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engines = [["Chrome", chromium, { channel: "chrome" }]];
  if (existsSync(webkit.executablePath())) engines.push(["WebKit", webkit, {}]);
  else
    console.log("WebKit browser runtime unavailable; Chrome regression only.");
  try {
    for (const [name, engine, options] of engines) {
      const browser = await engine.launch({ ...options, headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 393, height: 700 },
          hasTouch: true,
          isMobile: true,
        });
        await page.route("**/*", (route) =>
          route.request().url().startsWith(origin)
            ? route.continue()
            : route.abort(),
        );
        await page.addInitScript(() => {
          localStorage.setItem("contour.lang", "en");
          window.ContourBridge = {
            openFloorOverlay() {},
            startLibraryExitAR() {},
            translateText() {},
          };
          Object.defineProperty(navigator, "geolocation", {
            configurable: true,
            value: {
              getCurrentPosition() {},
              watchPosition(success) {
                window.emitDetailsFix = success;
                return 1;
              },
              clearWatch() {},
            },
          });
        });
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        const library = page
          .locator(".card")
          .filter({ hasText: "Central Library" })
          .first();
        await library.locator(".det").click();
        await page.locator("#floorOverlayBtn").waitFor({ state: "visible" });
        await page.waitForFunction(
          () => document.getElementById("closeBtn") === document.activeElement,
        );
        const maxScroll = await page
          .locator("#detail")
          .evaluate((el) => el.scrollHeight - el.clientHeight);
        assert.ok(
          maxScroll > 80,
          "Fixture must have genuinely scrollable details",
        );
        const start = await page.evaluate(() => {
          const detail = document.getElementById("detail");
          detail.scrollTop = 80;
          window.detailPhotoBefore = document.querySelector("#dPhoto img");
          return {
            scroll: detail.scrollTop,
            distance: document.getElementById("dDist").textContent,
          };
        });
        for (let index = 0; index < 6; index++) {
          await page.evaluate(
            (index) =>
              window.emitDetailsFix({
                coords: {
                  latitude: 35.15 + index * 0.0003,
                  longitude: 136.96,
                  accuracy: 8,
                },
                timestamp: Date.now(),
              }),
            index,
          );
          assert.ok(
            Math.abs(
              (await page.locator("#detail").evaluate((el) => el.scrollTop)) -
                start.scroll,
            ) < 1,
            "GPS reset the Details scroll position",
          );
        }
        assert.notEqual(
          await page.locator("#dDist").textContent(),
          start.distance,
          "Distance must continue updating",
        );
        assert.equal(
          await page.evaluate(
            () =>
              document.querySelector("#dPhoto img") ===
              window.detailPhotoBefore,
          ),
          true,
          "GPS must not recreate static photo/content",
        );
        await page.setViewportSize({ width: 393, height: 680 });
        assert.ok(
          Math.abs(
            (await page.locator("#detail").evaluate((el) => el.scrollTop)) -
              start.scroll,
          ) < 1,
          "Relayout reset the scroll position",
        );
        await page.evaluate(() => {
          const detail = document.getElementById("detail");
          detail.scrollTop = 0;
          detail.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              pointerId: 12,
              pointerType: "touch",
              clientX: 180,
              clientY: 400,
            }),
          );
          window.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              pointerId: 12,
              pointerType: "touch",
              clientX: 180,
              clientY: 340,
            }),
          );
        });
        assert.equal(
          await page.locator("#sheet").evaluate((el) => el.style.transform),
          "",
          "Upward reading swipe must not drag the sheet",
        );
        await page.evaluate(() =>
          window.dispatchEvent(
            new PointerEvent("pointerup", { pointerId: 12 }),
          ),
        );
        await page.locator("#closeBtn").click();
        await page.locator("#sheet").waitFor({ state: "hidden" });
        await library.locator(".det").click();
        await page.locator("#floorOverlayBtn").waitFor({ state: "visible" });
        assert.equal(
          await page.locator("#detail").evaluate((el) => el.scrollTop),
          0,
          "Explicitly reopening details starts at the top",
        );
        console.log(
          `PASS ${name}: GPS/relayout preserve scroll and photo, distance updates, upward swipes read content, reopening resets intentionally.`,
        );
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
