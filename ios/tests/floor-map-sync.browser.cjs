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
        planLandmarkRoute(request) {
          window.lastLandmarkRequest = request;
          window.landmarkRequests = [
            ...(window.landmarkRequests || []),
            request,
          ];
        },
        openWalkingConnections() {
          window.walkingEditorCalls = (window.walkingEditorCalls || 0) + 1;
        },
        readHealthStepLength(requestID) {
          window.healthRequestID = requestID;
        },
        cancelHealthStepLength() {
          window.healthCancelled = true;
        },
        startStepCalibration(request) {
          window.calibrationRequest = request;
        },
        finishStepCalibration(requestID) {
          window.calibrationFinishID = requestID;
        },
        cancelStepCalibration() {
          window.calibrationCancelled = true;
        },
        startIndoorTracking(request) {
          window.indoorRequest = request;
          window.contourIOSIndoorPose({
            ...request,
            steps: 0,
            distance: 0,
            status: window.deferIndoorPose ? "starting" : "tracking",
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
        routingRevision: "a".repeat(64),
        destinations: [
          { id: "a", name: "Room A <text>", x: 0.2, y: 0.7 },
          { id: "b", name: "Desk B", x: 0.8, y: 0.3 },
        ],
      };
    });
    await page.evaluate(() => document.documentElement.classList.add("native"));
    const toolClick = async (name) => {
      const options = page.locator(".contour-map-options");
      if (await options.isHidden())
        await page
          .getByRole("button", { name: "Map options", exact: true })
          .click();
      await page.getByRole("button", { name, exact: true }).click();
      if (await options.isVisible())
        await page
          .getByRole("button", { name: "Close map options", exact: true })
          .click();
    };
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
    await page.locator("#libraryMaps").waitFor({ state: "visible" });
    assert.equal(
      await page.evaluate(() => window.lastFloorARGoal),
      undefined,
      "Opening Floor Maps must not open AR or invent a start or exit",
    );
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
    await page.getByLabel("Starting point", { exact: true }).selectOption("b");
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
    await page.getByLabel("Starting point", { exact: true }).selectOption("b");
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
    await page.getByLabel("Starting point", { exact: true }).selectOption("a");
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
    await page
      .getByRole("button", {
        name: "Choose starting point Room A <text>",
        exact: true,
      })
      .click();
    assert.match(
      await page.locator(".contour-start-status").textContent(),
      /Starting step tracking/,
      "A start-pin tap immediately sets the indoor position",
    );
    await toolClick("Use uncorrected phone position");
    await page.evaluate(() => delete window.indoorRequest);
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
    const directions = page.getByRole("region", {
      name: "Landmark directions",
      exact: true,
    });
    const generate = page.locator(".contour-generate-directions");
    const requestRoute = async () => {
      await generate.evaluate((button) => {
        if (!button.disabled) button.click();
      });
      await page.waitForFunction(
        () =>
          document.querySelector(".contour-landmark-directions")?.dataset
            .state === "loading",
      );
    };
    const instructionList = page.locator(
      'ol[aria-label="Sequential landmark instructions"]',
    );
    await page.waitForFunction(
      () =>
        window.lastLandmarkRequest?.startID === "a" &&
        window.lastLandmarkRequest?.destinationID === "b",
    );
    assert.equal(
      await directions.getAttribute("data-state"),
      "loading",
      "Selecting the destination automatically starts planning without confirmation or motion",
    );
    assert.equal(await page.evaluate(() => window.indoorRequest == null), true);
    const reply = async (fields = {}) =>
      page.evaluate((fields) => {
        const request = window.lastLandmarkRequest;
        window.contourIOSLandmarkRoute({
          ...request,
          status: "ok",
          message:
            "Saved walking connections. Fixed list; no live progress tracking.",
          instructions: [
            "From Room A <text>, follow the marked passage toward Desk B.",
            "Pass the named landmarks along the blue line.",
            "Finish at Desk B.",
          ],
          landmarkIDs: [request.startID, request.destinationID],
          distance: 14,
          path: [
            { latitude: 35.155, longitude: 136.964 },
            { latitude: 35.15501, longitude: 136.96402 },
            { latitude: 35.1551, longitude: 136.9641 },
          ],
          ...fields,
        });
      }, fields);
    await requestRoute();
    await reply({
      status: "needs-walls",
      message: "Detect, review and save walls first.",
      instructions: [],
      landmarkIDs: [],
      path: [],
    });
    assert.equal(await directions.getAttribute("data-state"), "needs-walls");
    assert.equal(await instructionList.locator("li").count(), 0);
    await toolClick("Edit walking connections");
    assert.equal(await page.evaluate(() => window.walkingEditorCalls), 1);
    await requestRoute();
    await reply();
    assert.equal(await directions.getAttribute("data-state"), "ok");
    assert.equal(await instructionList.locator("li").count(), 3);
    assert.equal(
      await instructionList.locator("text").count(),
      0,
      "Landmark names are rendered as text, not HTML",
    );
    assert.equal(
      await page
        .locator(".contour-start-map")
        .getAttribute("data-has-landmark-route"),
      "true",
    );
    await page.evaluate(() => {
      window.savedInstructionNode = document.querySelector(
        '[aria-label="Sequential landmark instructions"] li',
      );
      window.emitStartFix(35.1552, 136.9642);
    });
    assert.equal(
      await page.evaluate(
        () =>
          window.savedInstructionNode ===
          document.querySelector(
            '[aria-label="Sequential landmark instructions"] li',
          ),
      ),
      true,
      "GPS must not regenerate or advance the static list",
    );
    assert.equal(
      await page.evaluate(() => window.indoorRequest),
      undefined,
      "Generating static instructions must not start step tracking",
    );
    assert.equal(
      await directions
        .getByRole("button", { name: /passed|confirm|next|arrived/i })
        .count(),
      0,
    );
    await directions.screenshot({
      path: "/tmp/contour-landmark-directions.png",
    });
    const screen = page.locator("#libraryMaps");
    const assertLayout = async () => {
      const boxes = await page.evaluate(() => {
        const box = (selector) => {
          const b = document.querySelector(selector).getBoundingClientRect();
          return {
            left: b.left,
            right: b.right,
            top: b.top,
            bottom: b.bottom,
            height: b.height,
          };
        };
        return {
          screen: box("#libraryMaps"),
          card: box(".contour-route-card"),
          map: box(".contour-start-map"),
          sheet: box(".contour-floor-controls"),
        };
      });
      assert.ok(
        boxes.card.left >= boxes.screen.left &&
          boxes.card.right <= boxes.screen.right + 1,
        "Endpoint fields fit without horizontal overflow",
      );
      assert.ok(
        boxes.map.bottom <= boxes.sheet.top + 2,
        "The sheet must not cover map attribution",
      );
      assert.ok(boxes.sheet.bottom <= boxes.screen.bottom + 2);
    };
    await assertLayout();
    assert.equal(await screen.getAttribute("data-sheet-expanded"), "false");
    await screen.screenshot({ path: "/tmp/contour-floor-map-collapsed.png" });
    await page
      .getByRole("button", { name: "Map options", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Start calibration", exact: true })
      .click();
    const calibration = await page.evaluate(() => window.calibrationRequest);
    assert.equal(calibration.distance, 20);
    await page.evaluate(
      (requestID) =>
        window.contourIOSStepCalibration({
          requestID,
          status: "walking",
          steps: 28,
          message: "Walk the measured distance.",
        }),
      calibration.requestID,
    );
    await page
      .getByRole("button", { name: "Finish calibration", exact: true })
      .click();
    assert.equal(
      await page.evaluate(() => window.calibrationFinishID),
      calibration.requestID,
    );
    await page.evaluate(
      (requestID) =>
        window.contourIOSStepCalibration({
          requestID,
          status: "complete",
          steps: 28,
          stepLength: 20 / 28,
          message: "Saved.",
        }),
      calibration.requestID,
    );
    assert.equal(
      await page.getByLabel("Step length in metres").inputValue(),
      String(20 / 28),
    );
    await page
      .getByRole("button", { name: "Start calibration", exact: true })
      .click();
    const cancelledCalibration = await page.evaluate(
      () => window.calibrationRequest.requestID,
    );
    await page
      .getByRole("button", { name: "Cancel calibration", exact: true })
      .click();
    await page.evaluate(
      (requestID) =>
        window.contourIOSStepCalibration({
          requestID,
          status: "complete",
          steps: 25,
          stepLength: 0.8,
          message: "Late result",
        }),
      cancelledCalibration,
    );
    assert.equal(
      await page.getByLabel("Step length in metres").inputValue(),
      String(20 / 28),
      "Cancelled calibration results must not replace the saved step length",
    );
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem("contour.indoorStepLength"),
      ),
      String(20 / 28),
    );
    const healthButton = page.getByRole("button", {
      name: "Use Apple Health step length",
      exact: true,
    });
    await healthButton.click();
    const healthID = await page.evaluate(() => window.healthRequestID);
    await page.evaluate(
      (requestID) =>
        window.contourIOSHealthStepLength({
          requestID,
          status: "empty",
          message: "No readable samples.",
        }),
      healthID,
    );
    assert.equal(
      await page.getByLabel("Step length in metres").inputValue(),
      String(20 / 28),
      "Missing Health samples preserve the prior value",
    );
    await healthButton.click();
    const nextHealthID = await page.evaluate(() => window.healthRequestID);
    await page.evaluate(
      (requestID) =>
        window.contourIOSHealthStepLength({
          requestID,
          status: "ok",
          stepLength: 0.9,
          sampleCount: 8,
          latest: Date.now(),
        }),
      healthID,
    );
    assert.equal(
      await page.getByLabel("Step length in metres").inputValue(),
      String(20 / 28),
      "Ignore stale Health responses",
    );
    await page.evaluate(
      (requestID) =>
        window.contourIOSHealthStepLength({
          requestID,
          status: "ok",
          stepLength: 0.74,
          sampleCount: 8,
          latest: Date.now(),
        }),
      nextHealthID,
    );
    assert.equal(
      await page.getByLabel("Step length in metres").inputValue(),
      "0.74",
    );
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem("contour.indoorStepLength"),
      ),
      "0.74",
    );
    await page
      .getByRole("button", { name: "Close map options", exact: true })
      .click();
    await page.getByRole("button", { name: "Directions", exact: true }).click();
    assert.equal(await page.locator(".contour-route-card").isHidden(), true);
    assert.equal(await instructionList.isVisible(), true);
    assert.equal(
      await instructionList.locator("li:visible").count(),
      3,
      "Directions show the complete route without manual progress confirmation",
    );
    assert.equal(await page.locator(".contour-step-arrived").count(), 0);
    const routeSession = await page.evaluate(() => window.indoorRequest);
    await page.evaluate(() => window.emitStartFix(35.1553, 136.9643));
    assert.deepEqual(
      await page.evaluate(() => window.indoorRequest),
      routeSession,
      "Reading directions never restarts tracking or relocates the user",
    );
    assert.equal(await screen.getAttribute("data-sheet-expanded"), "true");
    await assertLayout();
    await screen.screenshot({ path: "/tmp/contour-floor-map-expanded.png" });
    const grip = page.getByRole("button", {
      name: "Collapse route details",
      exact: true,
    });
    const gripBox = await grip.boundingBox();
    await page.mouse.move(
      gripBox.x + gripBox.width / 2,
      gripBox.y + gripBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      gripBox.x + gripBox.width / 2,
      gripBox.y + gripBox.height / 2 + 260,
      { steps: 12 },
    );
    await page.mouse.up();
    assert.equal(await page.locator(".contour-route-card").isVisible(), true);
    assert.equal(
      await screen.getAttribute("data-sheet-expanded"),
      "false",
      "Dragging down restores the larger map",
    );
    await page.setViewportSize({ width: 375, height: 740 });
    await page.waitForTimeout(100);
    await assertLayout();
    await page.setViewportSize({ width: 393, height: 852 });
    await page
      .getByRole("button", { name: "Swap start and destination", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Starting point", { exact: true }).inputValue(),
      "b",
    );
    assert.equal(
      await page.getByLabel("Saved floor destinations").inputValue(),
      "a",
    );
    await page.waitForFunction(
      () =>
        window.lastLandmarkRequest.startID === "b" &&
        window.lastLandmarkRequest.destinationID === "a",
    );
    await reply();
    await page
      .getByRole("button", { name: "Swap start and destination", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        window.lastLandmarkRequest.startID === "a" &&
        window.lastLandmarkRequest.destinationID === "b",
    );
    await reply();
    await page
      .getByRole("button", { name: "Choose destination on map", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Choose destination Room A <text>",
        exact: true,
      })
      .click();
    assert.equal(
      await page.getByLabel("Starting point", { exact: true }).inputValue(),
      "a",
      "Destination pin taps must not change the origin",
    );
    assert.equal(
      await page.getByLabel("Saved floor destinations").inputValue(),
      "a",
    );
    await page
      .getByRole("button", { name: "Choose destination Desk B", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        window.lastLandmarkRequest.startID === "a" &&
        window.lastLandmarkRequest.destinationID === "b",
    );
    await requestRoute();
    await reply();
    await page
      .getByRole("button", { name: "Choose start on map", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Fit floor and route", exact: true })
      .click();
    // Visual fixture only: use the bundled image and illustrative aisle points to
    // inspect long labels and dense floor-plan artwork, not to verify a real route.
    const libraryPlan = JSON.parse(
      readFileSync("ios/Contour/Resources/default-floor-overlay.json", "utf8"),
    );
    const visualPlan = {
      ...libraryPlan,
      floor: "2F",
      routingRevision: "c".repeat(64),
      destinations: [
        {
          id: "sky",
          name: "Multipurpose Learning Area ≥ Sky Learning Studio",
          x: 0.4,
          y: 0.24,
        },
        { id: "reference", name: "Reference Books", x: 0.12, y: 0.34 },
        { id: "group", name: "Group Learning Area", x: 0.28, y: 0.64 },
        { id: "entrance", name: "Entrance Hall", x: 0.8, y: 0.64 },
      ],
    };
    await apply(visualPlan);
    await page
      .getByLabel("Starting point", { exact: true })
      .selectOption("sky");
    await page.getByLabel("Saved floor destinations").selectOption("entrance");
    await requestRoute();
    const visualPath = [
      [0.4, 0.24],
      [0.12, 0.34],
      [0.12, 0.62],
      [0.28, 0.64],
      [0.8, 0.64],
    ].map(([x, y]) => {
      const dx = (x - 0.5) * visualPlan.width,
        dy = (y - 0.5) * visualPlan.width * visualPlan.aspect;
      const r = (visualPlan.angle * Math.PI) / 180,
        scale = Math.cos((visualPlan.latitude * Math.PI) / 180);
      const northing =
        6378137 *
          Math.log(
            Math.tan(Math.PI / 4 + (visualPlan.latitude * Math.PI) / 360),
          ) -
        (dx * Math.sin(r) + dy * Math.cos(r)) / scale;
      return {
        latitude: (Math.atan(Math.sinh(northing / 6378137)) * 180) / Math.PI,
        longitude:
          visualPlan.longitude +
          (((dx * Math.cos(r) - dy * Math.sin(r)) / (6378137 * scale)) * 180) /
            Math.PI,
      };
    });
    await reply({
      message: "Layout preview · illustrative route for UI checks.",
      instructions: [
        "Head toward Reference Books.",
        "Follow the aisle toward Group Learning Area.",
        "Continue toward Entrance Hall.",
      ],
      landmarkIDs: ["sky", "reference", "group", "entrance"],
      distance: 54,
      path: visualPath,
    });
    assert.equal(
      await previewImage.evaluate((image) => image.style.opacity),
      "1",
      "Floor Maps displays the plan clearly while the saved geographic opacity remains unchanged",
    );
    await assertLayout();
    await screen.screenshot({ path: "/tmp/contour-library-route-ui.png" });
    await apply(value);
    await page.getByLabel("Starting point", { exact: true }).selectOption("a");
    await page.getByLabel("Saved floor destinations").selectOption("b");
    await requestRoute();
    await reply();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        value: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", {
        value: false,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(
      await instructionList.locator("li").count(),
      3,
      "Background/foreground must preserve the static instructions and chosen start",
    );
    await page.getByLabel("Saved floor destinations").selectOption("a");
    assert.equal(
      await instructionList.locator("li").count(),
      0,
      "Changing destination clears old instructions",
    );
    await requestRoute();
    await reply({
      status: "same-place",
      instructions: [
        "Start and finish at Room A <text>. No walking sequence needed.",
      ],
      landmarkIDs: ["a"],
      path: [],
      distance: 0,
    });
    assert.equal(await directions.getAttribute("data-state"), "same-place");
    await page.getByLabel("Saved floor destinations").selectOption("b");
    await requestRoute();
    const staleStartRequest = await page.evaluate(
      () => window.lastLandmarkRequest.requestID,
    );
    await page.getByLabel("Starting point", { exact: true }).selectOption("b");
    await reply({ requestID: staleStartRequest });
    assert.equal(
      await instructionList.locator("li").count(),
      0,
      "Ignore a late reply for an earlier start selection",
    );
    await page.getByLabel("Starting point", { exact: true }).selectOption("a");
    await requestRoute();
    await reply({
      status: "no-path",
      message: "No connected walking sequence reaches this destination.",
      instructions: [],
      landmarkIDs: [],
      path: [],
    });
    assert.equal(await directions.getAttribute("data-state"), "no-path");
    assert.equal(
      await page
        .locator(".contour-start-map")
        .getAttribute("data-has-landmark-route"),
      "false",
    );
    await requestRoute();
    const staleMapRequest = await page.evaluate(
      () => window.lastLandmarkRequest.requestID,
    );
    await apply({ ...value, routingRevision: "b".repeat(64) });
    await reply({ requestID: staleMapRequest });
    assert.equal(
      await instructionList.locator("li").count(),
      0,
      "Ignore results from an earlier saved-map revision",
    );
    await apply(value);
    await page.evaluate(() =>
      window.contourIOSHeading({
        degrees: 97,
        accuracy: 8,
        timestamp: Date.now(),
      }),
    );
    await page.evaluate(() => {
      window.deferIndoorPose = true;
    });
    await page
      .getByRole("button", { name: "Start tracking", exact: true })
      .click();
    const startingButton = page.getByRole("button", {
      name: "Starting…",
      exact: true,
    });
    assert.equal(
      await startingButton.isVisible(),
      true,
      "Keep the tracking control visible during sensor startup",
    );
    assert.equal(await openAR.isDisabled(), true);
    assert.equal(await page.locator("#contour-ar-hint").isVisible(), true);
    assert.match(
      await page.locator("#contour-ar-hint").textContent(),
      /step counter/,
    );
    await page.evaluate(() => {
      window.deferIndoorPose = false;
      window.contourIOSIndoorPose({
        ...window.indoorRequest,
        steps: 0,
        distance: 0,
        status: "tracking",
        timestamp: Date.now(),
      });
    });
    assert.equal(
      await page
        .getByRole("button", { name: "Tracking ✓", exact: true })
        .isVisible(),
      true,
    );
    assert.equal(
      await page.evaluate(() => window.indoorRequest.stepLength),
      0.74,
      "The next start uses the imported Health estimate",
    );
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
    assert.deepEqual(arGoal.routeRequest, {
      startID: "a",
      destinationID: "b",
      revision: value.routingRevision,
    });
    await openAR.click();
    assert.equal(
      (await page.evaluate(() => window.lastFloorARGoal)).destination.name,
      "Desk B",
      "Floor Maps AR must use the selected saved destination",
    );
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
    await page.getByLabel("Starting point", { exact: true }).selectOption("b");
    assert.equal(
      await page
        .getByRole("button", { name: "Start tracking", exact: true })
        .isVisible(),
      true,
    );
    assert.equal(
      await openAR.isDisabled(),
      true,
      "A different planned origin must be anchored before AR",
    );
    await page.getByLabel("Starting point", { exact: true }).selectOption("a");
    assert.equal(await openAR.isEnabled(), true);
    await toolClick("Use uncorrected phone position");
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
    await toolClick("Edit floor overlay / Detect labels");
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
          detail: {
            provider: "google",
            map: { native: { pane: document.getElementById("map") } },
          },
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
    const startPin = page.locator('.contour-floor-pin[data-id="a"]');
    assert.equal(
      await startPin.evaluate((pin) => getComputedStyle(pin).width),
      "24px",
    );
    // The Google stub uses fixed projected pixels outside the viewport.
    await startPin.evaluate((pin) => pin.click());
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
      /rotate\(123deg\)/,
      "Viewing direction follows live compass readings after position confirmation",
    );
    assert.equal(
      await page.evaluate(() => window.indoorRequest.heading),
      87,
      "Viewing the compass must not reset the step-tracking heading",
    );
    await page.evaluate(() =>
      window.contourIOSHeading({
        degrees: 220,
        accuracy: 90,
        timestamp: Date.now(),
      }),
    );
    assert.match(
      await direction.getAttribute("style"),
      /rotate\(123deg\)/,
      "Unreliable compass readings do not change the viewing direction",
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
    assert.match(
      await page.locator(".contour-route-caption").textContent(),
      /Walking · 2 steps/,
    );
    await page.evaluate(() =>
      window.contourIOSIndoorPose({
        ...window.indoorRequest,
        latitude: window.indoorRequest.latitude + 0.00001,
        longitude: window.indoorRequest.longitude,
        heading: 123,
        steps: 2,
        distance: 1.44,
        status: "motion-interrupted",
        timestamp: Date.now(),
      }),
    );
    const pausedSession = await page.evaluate(
      () => window.indoorRequest.sessionID,
    );
    await page
      .getByRole("button", { name: "Resume tracking", exact: true })
      .click();
    const resumed = await page.evaluate(() => window.indoorRequest);
    assert.notEqual(resumed.sessionID, pausedSession);
    assert.equal(
      resumed.latitude,
      movedPoint.lat + 0.00001,
      "Resume must start from the last live position, not teleport back to the original pin",
    );
    assert.equal(resumed.longitude, movedPoint.lng);
    assert.match(
      await page.locator(".contour-route-caption").textContent(),
      /Walking · 0 steps/,
    );
    await toolClick("Use uncorrected phone position");
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
    const walls = {
      version: 1,
      reviewed: false,
      walls: [
        {
          id: "E76415DA-0EDB-401B-98ED-E914D3FCBD09",
          start: { x: 0.1, y: 0.5 },
          end: { x: 0.9, y: 0.5 },
        },
      ],
      openings: [
        {
          id: "6F616A8E-D2D6-4E20-BE87-6EB9493CB0E5",
          start: { x: 0.4, y: 0.5 },
          end: { x: 0.6, y: 0.5 },
        },
      ],
    };
    await apply({ ...updated, wallGeometry: walls });
    await page
      .getByRole("combobox", { name: "Starting point", exact: true })
      .selectOption(updated.destinations[0].id);
    await page.evaluate(() =>
      window.contourIOSHeading({
        degrees: 87,
        accuracy: 8,
        timestamp: Date.now(),
      }),
    );
    await toolClick("Set my position here");
    assert.equal(
      await page.evaluate(() => window.indoorRequest.wallMap),
      undefined,
      "Unreviewed detection must never constrain movement",
    );
    walls.reviewed = true;
    await apply({ ...updated, wallGeometry: walls });
    assert.equal(
      await page.evaluate(() => window.indoorRequest),
      null,
      "Changing wall geometry invalidates the existing pose/session",
    );
    await toolClick("Set my position here");
    assert.deepEqual(
      await page.evaluate(() => window.indoorRequest.wallMap.geometry),
      walls,
    );
    assert.equal(
      await page.evaluate(() => window.indoorRequest.wallMap.angle),
      updated.angle,
    );
    await page
      .getByRole("button", { name: "Map options", exact: true })
      .click();
    await page
      .getByRole("checkbox", {
        name: "Show saved walls (red) and openings (green)",
      })
      .check();
    await page
      .getByRole("button", { name: "Close map options", exact: true })
      .click();
    assert.equal(
      await page
        .locator(".contour-start-map")
        .getAttribute("data-wall-segments"),
      "2",
    );
    await page.evaluate(() =>
      window.contourIOSIndoorPose({
        ...window.indoorRequest,
        steps: 1,
        distance: 0.72,
        status: "tracking",
        wallBlocked: true,
        timestamp: Date.now(),
      }),
    );
    assert.match(
      await page.locator(".contour-start-status").innerText(),
      /Movement held at a mapped wall/,
    );
    assert.equal(
      await apply({
        ...updated,
        wallGeometry: {
          ...walls,
          walls: [{ ...walls.walls[0], start: { x: -1, y: 0.5 } }],
        },
      }),
      false,
    );
    await apply(updated);
    assert.equal(
      await page.evaluate(() => window.indoorRequest),
      null,
      "Removing walls clears the previous constraints",
    );
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
