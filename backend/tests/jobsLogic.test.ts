import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listEqvolEntries,
  normalizeEqvolReport,
  selectEqvolCandidates,
  type EqvolBulletinType,
} from "../src/services/jobs/jmaEqvol.js";
import {
  normalizeWeatherReport,
  selectAichiBulletins,
  selectUnseenWeather,
} from "../src/services/jobs/jmaWeather.js";
import {
  parseNagoyaCsv,
  validateNagoyaRows,
} from "../src/services/jobs/nagoyaDataset.js";
import { prepareHandoff } from "../src/services/jobs/outbox.js";
import { parseXml } from "../src/services/jobs/xml.js";
import {
  eqvolFixtures,
  feedEntry,
  toXml,
  weatherReport,
  weatherUrl,
} from "./jobsHelpers.js";

const header =
  "共通ID,施設・場所名,住所,洪水,崖崩れ、土石流及び地滑り,高潮,地震,津波,大規模な火事,内水氾濫,火山現象,指定避難所との住所同一,緯度,経度,備考";

test("XML parser reproduces the n8n xml2js shapes for official bulletins", () => {
  for (const type of ["VXSE53", "VTSE41", "VFVO50"] as const)
    assert.deepEqual(parseXml(toXml(eqvolFixtures[type])), eqvolFixtures[type]);
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>'));
});

test("CSV validation accepts a complete dataset with a BOM and sorts by ID", () => {
  const csv = `${String.fromCharCode(0xfeff)}${header}\r\n2310000002,B公園,名古屋市中区,,,,1,,1,,,,35.17,136.9,\r\n2310000001,A小学校,名古屋市北区,1,,,1,,,,,,35.2,136.91,備考あり\r\n`;
  const result = validateNagoyaRows(parseNagoyaCsv(csv));
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.equal(result.recordCount, 2);
  const sites = JSON.parse(result.payloadJson);
  assert.deepEqual(
    sites.map((s: { id: string }) => s.id),
    ["2310000001", "2310000002"],
  );
  assert.deepEqual(sites[0].disasters, ["flood", "earthquake"]);
  assert.equal(sites[0].openingStatus, "unknown");
  assert.equal(sites[0].isDemo, false);
  assert.equal(sites[0].remarks, "備考あり");
});

test("CSV validation rejects the whole dataset on any invalid row", () => {
  const csv = [
    header,
    "1,A,addr,1,,,,,,,,,35,136,",
    "1,,addr,,,,,,,,,,abc,136,",
    "2,C,addr,○,,,,,,,,,35,136,",
    "3,D,addr",
  ].join("\n");
  const result = validateNagoyaRows(parseNagoyaCsv(csv));
  assert.equal(result.valid, false);
  assert.equal(result.payloadJson, "");
  const all = result.errors.join("\n");
  assert.match(all, /Row 2: missing or duplicate common ID/);
  assert.match(all, /Row 2: missing name/);
  assert.match(all, /Row 2: invalid coordinates/);
  assert.match(all, /Row 2: no designated hazard/);
  assert.match(all, /Row 3: unknown hazard flag in 洪水/);
  assert.match(all, /Row 4: missing column 緯度/);
  assert.ok(result.errors.length <= 20);
  assert.equal(validateNagoyaRows([]).valid, false);
});

test("feed selection allows only official Aichi VPWW53 links and sorts newest first", () => {
  const feed = parseXml(
    toXml({
      feed: {
        updated: "2026-11-05T02:00:00Z",
        entry: [
          feedEntry(weatherUrl, "2026-11-05T01:00:00Z"),
          feedEntry(
            weatherUrl.replace("010000_0", "020000_0"),
            "2026-11-05T02:00:00Z",
          ),
          feedEntry(
            weatherUrl.replace("www.data.jma.go.jp", "example.com"),
            "2026-11-05T03:00:00Z",
          ),
          feedEntry(
            weatherUrl.replace("VPWW53", "VPWW54"),
            "2026-11-05T03:00:00Z",
          ),
          feedEntry(
            weatherUrl.replace("230000", "130000"),
            "2026-11-05T03:00:00Z",
          ),
          feedEntry(
            weatherUrl.replace("01000", "03000"),
            "2026-11-05T03:00:00Z",
            "東京管区気象台",
          ),
        ],
      },
    }),
  );
  const { candidates } = selectAichiBulletins(feed);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.publishedAt, "2026-11-05T02:00:00Z");
  assert.throws(() => selectAichiBulletins({ feed: { updated: "x" } }));
});

test("empty, duplicate and older feeds preserve the current state", () => {
  const candidate = {
    sourceUrl: weatherUrl,
    publishedAt: "2026-11-05T01:00:00Z",
    title: "",
  };
  const state = {
    sourceUrl: weatherUrl,
    publishedAt: candidate.publishedAt,
    processedUrls: [weatherUrl],
  };
  for (const candidates of [
    [],
    [candidate],
    [
      {
        ...candidate,
        sourceUrl: weatherUrl.replace("010000", "000000"),
        publishedAt: "2026-11-05T00:00:00Z",
      },
    ],
  ])
    assert.equal(selectUnseenWeather(state, candidates), null);
  // A missing state row is the initial state, not an error.
  assert.equal(
    selectUnseenWeather(null, [candidate])?.sourceUrl,
    candidate.sourceUrl,
  );
});

test("a distinct correction URL with equal timestamp is accepted", () => {
  const correction = {
    sourceUrl: weatherUrl.replace("_0_", "_1_"),
    publishedAt: "2026-11-05T01:00:00Z",
    title: "",
  };
  const result = selectUnseenWeather(
    {
      sourceUrl: weatherUrl,
      publishedAt: correction.publishedAt,
      processedUrls: [],
    },
    [correction],
  );
  assert.equal(result?.sourceUrl, correction.sourceUrl);
  assert.deepEqual(result?.processedUrls, [weatherUrl]);
});

const weatherCandidate = {
  sourceUrl: weatherUrl,
  publishedAt: "2026-11-05T01:00:00Z",
  processedUrls: [],
};
const normalizeWeather = (report: unknown) =>
  normalizeWeatherReport(
    parseXml(toXml(report)),
    weatherCandidate,
    "2026-11-05T02:00:00.000Z",
  );

test("an advisory elsewhere does not turn Nagoya's no-warning status into a warning", () => {
  const payload = normalizeWeather(weatherReport());
  assert.equal(payload?.nagoya?.kinds[0]?.status, "発表警報・注意報はなし");
  assert.equal(payload?.municipalities[1]?.kinds[0]?.status, "継続");
  assert.equal(payload?.notificationsSent, false);
  assert.equal(payload?.backendConnected, false);
  assert.deepEqual(payload?.processedUrls, [weatherUrl]);
});

test("corrections and lifted statuses remain explicit", () => {
  const report = weatherReport();
  report.Report.Head.InfoType = "訂正";
  const body = report.Report.Body as {
    Warning: { Item: { Kind: unknown }[] };
  };
  body.Warning.Item[0]!.Kind = [
    { Code: "03", Name: "大雨警報", Status: "解除" },
    { Code: "14", Name: "雷注意報", Status: "発表" },
  ];
  const payload = normalizeWeather(report);
  assert.equal(payload?.infoType, "訂正");
  assert.deepEqual(
    payload?.nagoya?.kinds.map((kind) => kind.status),
    ["解除", "発表"],
  );
});

test("bulletin cancellation means unknown, rather than no warnings", () => {
  const report = weatherReport();
  report.Report.Head.InfoType = "取消";
  delete report.Report.Body;
  const payload = normalizeWeather(report);
  assert.equal(payload?.invalidated, true);
  assert.equal(payload?.interpretation, "bulletin_cancelled_status_unknown");
  assert.equal(payload?.nagoya, null);
  assert.deepEqual(payload?.municipalities, []);
});

test("training weather bulletins are excluded", () => {
  const report = weatherReport();
  report.Report.Control.Status = "訓練";
  assert.equal(normalizeWeather(report), null);
});

test("malformed weather reports and missing Nagoya fail before persistence", () => {
  assert.throws(
    () => normalizeWeather({ Other: {} }),
    /Missing JMA report headers/,
  );
  const missing = weatherReport();
  (
    missing.Report.Body as { Warning: { Item: unknown[] } }
  ).Warning.Item.shift();
  assert.throws(() => normalizeWeather(missing), /Nagoya status missing/);
  const malformed = weatherReport();
  (
    malformed.Report.Body as { Warning: { Item: { Kind: unknown }[] } }
  ).Warning.Item[0]!.Kind = { Status: "発表" };
  assert.throws(() => normalizeWeather(malformed), /Missing warning kind/);
});

const eqvolUrl = (type: string, index = 0) =>
  `https://www.data.jma.go.jp/developer/xml/data/2026110501000${index}_0_${type}_010000.xml`;

function normalizeDisaster(
  type: EqvolBulletinType,
  input: unknown = eqvolFixtures[type],
) {
  return normalizeEqvolReport(parseXml(toXml(input)), {
    sourceUrl: eqvolUrl(type),
    publishedAt: "2026-11-05T01:00:00Z",
    bulletinType: type,
  });
}

test("second feed accepts only supported official bulletin URLs and bounds each type", () => {
  const entries = ["VTSE41", "VFVO50", "VXSE53", "VXSE43", "VFVO53"].flatMap(
    (type) =>
      [0, 1, 2, 3].map((index) =>
        feedEntry(eqvolUrl(type, index), `2026-11-05T01:00:0${index}Z`),
      ),
  );
  entries.push(
    feedEntry(
      "https://example.com/20261105010000_0_VTSE41_010000.xml",
      "2026-11-05T01:01:00Z",
    ),
    feedEntry(eqvolUrl("VTSE41", 3), "2026-11-05T01:00:03Z"),
  );
  const listed = listEqvolEntries(
    parseXml(
      toXml({ feed: { updated: "2026-11-05T02:00:00Z", entry: entries } }),
    ),
  );
  const result = selectEqvolCandidates(listed, new Set());
  assert.equal(result.length, 9);
  assert.deepEqual(
    [...new Set(result.map((r) => r.bulletinType))],
    ["VTSE41", "VFVO50", "VXSE53"],
  );
  assert.equal(result[0]?.publishedAt, "2026-11-05T01:00:03Z");
  assert.equal(new Set(result.map((r) => r.sourceUrl)).size, 9);
});

test("stored second-feed URLs and empty feeds produce no duplicate work", () => {
  const url = eqvolUrl("VXSE53");
  const stored = new Set([`eqvol:${url.split("/").pop()}`]);
  for (const entry of [undefined, feedEntry(url, "2026-11-05T01:00:00Z")]) {
    const listed = listEqvolEntries(
      parseXml(toXml({ feed: { updated: "2026-11-05T02:00:00Z", entry } })),
    );
    assert.deepEqual(selectEqvolCandidates(listed, stored), []);
  }
});

test("earthquake reports retain event identity, origin, magnitude and observation areas", () => {
  const payload = normalizeDisaster("VXSE53");
  const details = payload.details as {
    kind: string;
    earthquake: Record<string, { _: string }>;
    observedPrefectures: { Name: string }[];
  };
  assert.equal(details.kind, "earthquake_information");
  assert.equal(payload.eventId, "20261105113536");
  assert.equal(details.earthquake["jmx_eb:Magnitude"]?._, "3.4");
  assert.equal(details.observedPrefectures[0]?.Name, "東京都");
  assert.equal(payload.aichiMentioned, false);
  assert.equal(payload.notificationsSent, false);
});

test("tsunami sample retains forecast categories and unknown heights without inventing numbers", () => {
  const payload = normalizeDisaster("VTSE41");
  const details = payload.details as {
    kind: string;
    areas: {
      areaCode: string;
      areaName: string;
      category: { Kind: { Name: string } };
      maxHeight: Record<string, { _: string }>;
    }[];
  };
  assert.equal(details.kind, "tsunami_warning_advisory_forecast");
  const aichi = details.areas.find((area) => area.areaCode === "390");
  assert.equal(aichi?.areaName, "愛知県外海");
  assert.equal(aichi?.category.Kind.Name, "津波注意報");
  assert.equal(aichi?.maxHeight["jmx_eb:TsunamiHeight"]?._, "NaN");
  assert.equal(payload.aichiMentioned, true);
});

test("volcanic warning release remains a release and is not treated as a Nagoya warning", () => {
  const payload = normalizeDisaster("VFVO50");
  const details = payload.details as {
    kind: string;
    sections: {
      sectionType: string;
      items: { kind: { Condition: string }; areas: { name: string }[] }[];
    }[];
  };
  assert.equal(details.kind, "volcano_warning_forecast");
  const municipal = details.sections.find(
    (section) => section.sectionType === "噴火警報・予報（対象市町村等）",
  );
  assert.equal(municipal?.items[0]?.kind.Condition, "解除");
  assert.equal(municipal?.items[0]?.areas[0]?.name, "北海道釧路市");
  assert.equal(payload.aichiMentioned, false);
});

test("disaster cancellation does not imply an all-clear and preserves the event ID", () => {
  for (const type of ["VXSE53", "VTSE41", "VFVO50"] as const) {
    const report = structuredClone(eqvolFixtures[type]);
    (report.Report.Head as Record<string, unknown>).InfoType = "取消";
    delete report.Report.Body;
    const payload = normalizeDisaster(type, report);
    assert.equal(payload.invalidated, true);
    assert.equal(payload.interpretation, "bulletin_cancelled_status_unknown");
    assert.equal(payload.details, null);
    assert.equal(payload.aichiMentioned, null);
    assert.equal(
      payload.eventId,
      (eqvolFixtures[type].Report.Head as Record<string, unknown>).EventID,
    );
  }
});

test("training disaster reports are marked excluded and malformed reports fail", () => {
  const report = structuredClone(eqvolFixtures.VTSE41);
  (report.Report.Control as Record<string, unknown>).Status = "訓練";
  const payload = normalizeDisaster("VTSE41", report);
  assert.equal(payload.ignored, true);
  assert.equal(payload.details, null);
  assert.equal(payload.interpretation, "excluded_training_or_test");
  const missing = structuredClone(eqvolFixtures.VTSE41);
  delete (missing.Report.Body as Record<string, unknown>).Tsunami;
  assert.throws(
    () => normalizeDisaster("VTSE41", missing),
    /Missing tsunami forecast areas/,
  );
  assert.throws(
    () => normalizeDisaster("VXSE53", eqvolFixtures.VFVO50),
    /type mismatch/,
  );
});

test("handoffs keep identity and exclude training reports from pending delivery", () => {
  const bulletin = { sourceUrl: weatherUrl, control: { Status: "通常" } };
  const entry = prepareHandoff(
    { sourceUrl: weatherUrl, publishedAt: "2026-11-05T01:00:00Z", bulletin },
    "2026-11-05T02:00:00Z",
  );
  assert.equal(entry.deliveryKey, `jma:${weatherUrl}`);
  assert.equal(entry.deliveryStatus, "pending");
  assert.equal(entry.bulletinType, "VPWW53");
  for (const status of ["訓練", "試験"]) {
    const excluded = prepareHandoff(
      {
        sourceUrl: eqvolUrl("VTSE41"),
        publishedAt: "2026-11-05T01:00:00Z",
        bulletin: {
          sourceUrl: eqvolUrl("VTSE41"),
          bulletinType: "VTSE41",
          ignored: true,
          control: { Status: status },
        },
      },
      "2026-11-05T02:00:00Z",
    );
    assert.equal(excluded.deliveryStatus, "excluded");
  }
  for (const row of [
    {
      sourceUrl: weatherUrl.replace("www.data.jma.go.jp", "evil.test"),
      publishedAt: "2026-11-05T01:00:00Z",
      bulletin,
    },
    {
      sourceUrl: weatherUrl,
      publishedAt: "2026-11-05T01:00:00Z",
      bulletin: { sourceUrl: "https://example.invalid" },
    },
    { sourceUrl: weatherUrl, publishedAt: "invalid", bulletin },
  ])
    assert.throws(() => prepareHandoff(row, "2026-11-05T02:00:00Z"));
});
