import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const workflow = JSON.parse(
  readFileSync(new URL("../workflow-2.json", import.meta.url), "utf8"),
);
const sourceUrl =
  "https://www.data.jma.go.jp/developer/xml/data/20261105010000_0_VPWW53_230000.xml";
const candidate = {
  sourceUrl,
  publishedAt: "2026-11-05T01:00:00Z",
  processedUrls: [],
};

/** Execute exported Code nodes against synthetic inputs, without network or writes. */
function execute(name, input, upstream = {}) {
  const code = workflow.nodes.find((node) => node.name === name).parameters
    .jsCode;
  const items = input.map((json) => ({ json }));
  const result = runInNewContext(`(() => { ${code} })()`, {
    $input: { first: () => items[0], all: () => items },
    $: (nodeName) => ({
      first: () => ({ json: upstream[nodeName] }),
      item: { json: upstream[nodeName] },
    }),
    $now: { toISO: () => "2026-11-05T11:00:00+09:00" },
  });
  return JSON.parse(JSON.stringify(result));
}

/** Synthetic report, never persisted as an official warning. */
function fixture() {
  return {
    Report: {
      Control: { Status: "通常", PublishingOffice: "名古屋地方気象台" },
      Head: {
        Title: "愛知県気象警報・注意報",
        ReportDateTime: "2026-11-05T10:00:00+09:00",
        InfoType: "発表",
        Headline: { Text: "SYNTHETIC TEST ONLY" },
      },
      Body: {
        Warning: {
          $: { type: "気象警報・注意報（市町村等）" },
          Item: [
            {
              Area: { Code: "2310000", Name: "名古屋市" },
              Kind: { Status: "発表警報・注意報はなし" },
            },
            {
              Area: { Code: "2320100", Name: "豊橋市" },
              Kind: { Code: "16", Name: "波浪注意報", Status: "継続" },
            },
          ],
        },
      },
    },
  };
}

function normalize(report) {
  return execute("Validate municipality statuses", [report], {
    "Skip seen or older bulletin": candidate,
  });
}

test("feed selection allows only official Aichi VPWW53 links and sorts newest first", () => {
  const entry = (url, updated) => ({
    link: { $: { href: url } },
    author: { name: "名古屋地方気象台" },
    title: "気象特別警報・警報・注意報",
    updated,
  });
  const result = execute("Select Aichi bulletins", [
    {
      feed: {
        updated: "2026-11-05T02:00:00Z",
        entry: [
          entry(sourceUrl, "2026-11-05T01:00:00Z"),
          entry(sourceUrl.replace("010000", "020000"), "2026-11-05T02:00:00Z"),
          entry(
            sourceUrl.replace("www.data.jma.go.jp", "example.com"),
            "2026-11-05T03:00:00Z",
          ),
          entry(sourceUrl.replace("VPWW53", "VPWW54"), "2026-11-05T03:00:00Z"),
          entry(sourceUrl.replace("230000", "130000"), "2026-11-05T03:00:00Z"),
        ],
      },
    },
  ]);
  assert.equal(result[0].json.candidates.length, 2);
  assert.equal(
    result[0].json.candidates[0].publishedAt,
    "2026-11-05T02:00:00Z",
  );
});

test("empty, duplicate and older feeds preserve the current state", () => {
  const state = {
    recordKey: "current:230000",
    sourceUrl,
    publishedAt: candidate.publishedAt,
    payloadJson: JSON.stringify({ processedUrls: [sourceUrl] }),
  };
  for (const candidates of [
    [],
    [candidate],
    [
      {
        ...candidate,
        sourceUrl: sourceUrl.replace("010000", "000000"),
        publishedAt: "2026-11-05T00:00:00Z",
      },
    ],
  ]) {
    assert.deepEqual(
      execute("Skip seen or older bulletin", [state], {
        "Select Aichi bulletins": { candidates },
      }),
      [],
    );
  }
});

test("a distinct correction URL with equal timestamp is accepted", () => {
  const correction = {
    ...candidate,
    sourceUrl: sourceUrl.replace("_0_", "_1_"),
  };
  const result = execute(
    "Skip seen or older bulletin",
    [
      {
        recordKey: "current:230000",
        sourceUrl,
        publishedAt: candidate.publishedAt,
        payloadJson: "{}",
      },
    ],
    { "Select Aichi bulletins": { candidates: [correction] } },
  );
  assert.equal(result[0].json.sourceUrl, correction.sourceUrl);
});

test("an advisory elsewhere does not turn Nagoya's no-warning status into a warning", () => {
  const payload = JSON.parse(normalize(fixture())[0].json.payloadJson);
  assert.equal(payload.nagoya.kinds[0].status, "発表警報・注意報はなし");
  assert.equal(payload.municipalities[1].kinds[0].status, "継続");
  assert.equal(payload.notificationsSent, false);
  assert.equal(payload.backendConnected, false);
});

test("corrections and lifted statuses remain explicit", () => {
  const report = fixture();
  report.Report.Head.InfoType = "訂正";
  report.Report.Body.Warning.Item[0].Kind = [
    { Code: "03", Name: "大雨警報", Status: "解除" },
    { Code: "14", Name: "雷注意報", Status: "発表" },
  ];
  const payload = JSON.parse(normalize(report)[0].json.payloadJson);
  assert.equal(payload.infoType, "訂正");
  assert.deepEqual(
    payload.nagoya.kinds.map((kind) => kind.status),
    ["解除", "発表"],
  );
});

test("bulletin cancellation means unknown, rather than no warnings", () => {
  const report = fixture();
  report.Report.Head.InfoType = "取消";
  delete report.Report.Body;
  const payload = JSON.parse(normalize(report)[0].json.payloadJson);
  assert.equal(payload.invalidated, true);
  assert.equal(payload.interpretation, "bulletin_cancelled_status_unknown");
  assert.equal(payload.nagoya, null);
});

test("training bulletins are excluded", () => {
  const report = fixture();
  report.Report.Control.Status = "訓練";
  assert.deepEqual(normalize(report), []);
});

test("malformed reports and missing Nagoya fail before persistence", () => {
  assert.throws(() => normalize({}), /Missing JMA report headers/);
  const missing = fixture();
  missing.Report.Body.Warning.Item.shift();
  assert.throws(() => normalize(missing), /Nagoya status missing/);
  const malformed = fixture();
  malformed.Report.Body.Warning.Item[0].Kind = { Status: "発表" };
  assert.throws(() => normalize(malformed), /Missing warning kind/);
});

const disasterFixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/workflow-2-eqvol.json", import.meta.url),
    "utf8",
  ),
);

/** Parse archived/sample inputs locally; no fixture is sent to n8n storage. */
function normalizeDisaster(type, input = disasterFixtures[type]) {
  const result = execute("Normalize earthquake tsunami volcano", [input], {
    "Process each disaster bulletin": {
      sourceUrl: `https://www.data.jma.go.jp/developer/xml/data/20261105010000_0_${type}_010000.xml`,
      publishedAt: "2026-11-05T01:00:00Z",
      bulletinType: type,
    },
  });
  return JSON.parse(result[0].json.payloadJson);
}

test("second feed accepts only supported official bulletin URLs and bounds each type", () => {
  const entries = ["VTSE41", "VFVO50", "VXSE53", "VXSE43", "VFVO53"].flatMap(
    (type) =>
      [0, 1, 2, 3].map((index) => ({
        link: {
          $: {
            href: `https://www.data.jma.go.jp/developer/xml/data/2026110501000${index}_0_${type}_010000.xml`,
          },
        },
        updated: `2026-11-05T01:00:0${index}Z`,
      })),
  );
  entries.push({
    link: {
      $: { href: "https://example.com/20261105010000_0_VTSE41_010000.xml" },
    },
    updated: "2026-11-05T01:01:00Z",
  });
  const result = execute(
    "Select unseen earthquake tsunami volcano",
    [{ sourceUrl: "" }],
    {
      "Parse earthquake volcano Atom": {
        feed: { updated: "2026-11-05T02:00:00Z", entry: entries },
      },
    },
  );
  assert.equal(result.length, 9);
  assert.deepEqual(
    [...new Set(result.map((r) => r.json.bulletinType))],
    ["VTSE41", "VFVO50", "VXSE53"],
  );
  assert.equal(result[0].json.publishedAt, "2026-11-05T01:00:03Z");
});

test("stored second-feed URLs and empty feeds produce no duplicate work", () => {
  const url =
    "https://www.data.jma.go.jp/developer/xml/data/20261105010000_0_VXSE53_010000.xml";
  for (const entry of [
    undefined,
    { link: { $: { href: url } }, updated: "2026-11-05T01:00:00Z" },
  ]) {
    assert.deepEqual(
      execute(
        "Select unseen earthquake tsunami volcano",
        [{ sourceUrl: url }],
        {
          "Parse earthquake volcano Atom": {
            feed: { updated: "2026-11-05T02:00:00Z", entry },
          },
        },
      ),
      [],
    );
  }
});

test("earthquake reports retain event identity, origin, magnitude and actual observation areas", () => {
  const payload = normalizeDisaster("VXSE53");
  assert.equal(payload.details.kind, "earthquake_information");
  assert.equal(payload.eventId, "20261105113536");
  assert.equal(payload.details.earthquake["jmx_eb:Magnitude"]._, "3.4");
  assert.equal(payload.details.observedPrefectures[0].Name, "東京都");
  assert.equal(payload.aichiMentioned, false);
  assert.equal(payload.notificationsSent, false);
});

test("tsunami sample retains forecast categories and unknown heights without inventing numbers", () => {
  const payload = normalizeDisaster("VTSE41");
  assert.equal(payload.details.kind, "tsunami_warning_advisory_forecast");
  const aichi = payload.details.areas.find((area) => area.areaCode === "390");
  assert.equal(aichi.areaName, "愛知県外海");
  assert.equal(aichi.category.Kind.Name, "津波注意報");
  assert.equal(aichi.maxHeight["jmx_eb:TsunamiHeight"]._, "NaN");
  assert.equal(payload.aichiMentioned, true);
});

test("volcanic warning release remains a release and is not treated as a Nagoya warning", () => {
  const payload = normalizeDisaster("VFVO50");
  assert.equal(payload.details.kind, "volcano_warning_forecast");
  const municipal = payload.details.sections.find(
    (section) => section.sectionType === "噴火警報・予報（対象市町村等）",
  );
  assert.equal(municipal.items[0].kind.Condition, "解除");
  assert.equal(municipal.items[0].areas[0].name, "北海道釧路市");
  assert.equal(payload.aichiMentioned, false);
});

test("disaster cancellation does not imply an all-clear and preserves the cancelled event ID", () => {
  for (const type of ["VXSE53", "VTSE41", "VFVO50"]) {
    const report = structuredClone(disasterFixtures[type]);
    report.Report.Head.InfoType = "取消";
    delete report.Report.Body;
    const payload = normalizeDisaster(type, report);
    assert.equal(payload.invalidated, true);
    assert.equal(payload.interpretation, "bulletin_cancelled_status_unknown");
    assert.equal(payload.details, null);
    assert.equal(payload.aichiMentioned, null);
    assert.equal(payload.eventId, disasterFixtures[type].Report.Head.EventID);
  }
});

test("training reports are marked excluded and malformed disaster reports fail", () => {
  const report = structuredClone(disasterFixtures.VTSE41);
  report.Report.Control.Status = "訓練";
  const payload = normalizeDisaster("VTSE41", report);
  assert.equal(payload.ignored, true);
  assert.equal(payload.details, null);
  assert.equal(payload.interpretation, "excluded_training_or_test");
  const missing = structuredClone(disasterFixtures.VTSE41);
  delete missing.Report.Body.Tsunami;
  assert.throws(
    () => normalizeDisaster("VTSE41", missing),
    /Missing tsunami forecast areas/,
  );
  assert.throws(
    () => normalizeDisaster("VXSE53", disasterFixtures.VFVO50),
    /type mismatch/,
  );
});
