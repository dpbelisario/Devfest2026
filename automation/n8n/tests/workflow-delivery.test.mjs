import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const workflow = JSON.parse(
  readFileSync(new URL("../workflow-2.json", import.meta.url), "utf8"),
);
const getNode = (name) => workflow.nodes.find((node) => node.name === name);
const sourceUrl =
  "https://www.data.jma.go.jp/developer/xml/data/20261105010000_0_VPWW53_230000.xml";
const deliveryKey = `jma:${sourceUrl}`;
const timestamp = "2026-11-05T01:00:00Z";

function execute(name, input, upstream = {}, transform = (code) => code) {
  const items = input.map((json) => ({ json }));
  const output = runInNewContext(
    `(() => { ${transform(getNode(name).parameters.jsCode)} })()`,
    {
      $input: { first: () => items[0], all: () => items },
      $: (nodeName) => ({ item: { json: upstream[nodeName] } }),
      $now: { toISO: () => timestamp },
    },
  );
  return JSON.parse(JSON.stringify(output));
}

function row(changes = {}) {
  return {
    sourceUrl,
    publishedAt: timestamp,
    payloadJson: JSON.stringify({
      sourceUrl,
      control: { Status: "通常" },
      infoType: "発表",
      municipalities: [],
      ...changes,
    }),
  };
}

test("handoffs keep source identity, official statuses, cancellation and item pairing", () => {
  const inputs = [row(), row({ infoType: "取消", invalidated: true })];
  const output = execute("Prepare weather handoff", inputs);
  assert.equal(output.length, 2);
  assert.equal(output[0].json.deliveryKey, deliveryKey);
  assert.equal(output[1].pairedItem.item, 1);
  const envelope = JSON.parse(output[1].json.payloadJson);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.bulletinType, "VPWW53");
  assert.equal(envelope.purpose, "warning_ingestion");
  assert.equal(envelope.bulletin.infoType, "取消");
  assert.equal(envelope.bulletin.invalidated, true);
  assert.equal(output[1].json.deliveryStatus, "pending");
  assert.equal(output[1].json.acknowledgedAt, "");
});

test("training and test reports never enter the pending delivery query", () => {
  for (const status of ["訓練", "試験"]) {
    const output = execute("Prepare disaster handoff", [
      row({ control: { Status: status }, ignored: true }),
    ]);
    assert.equal(output[0].json.deliveryStatus, "excluded");
  }
  const filter = getNode("Read pending warning handoffs").parameters.filters;
  assert.deepEqual(filter.conditions, [
    { keyName: "deliveryStatus", keyValue: "pending" },
  ]);
});

test("handoffs reject mismatched identity, untrusted URLs, and malformed payloads", () => {
  for (const input of [
    {
      ...row(),
      sourceUrl: sourceUrl.replace("www.data.jma.go.jp", "evil.test"),
    },
    row({ sourceUrl: "https://example.invalid" }),
    { ...row(), publishedAt: "invalid" },
    { ...row(), payloadJson: "{" },
  ]) {
    assert.throws(() => execute("Prepare weather handoff", [input]));
  }
});

test("delivery is off by default and rejects unsafe endpoint configuration", () => {
  assert.deepEqual(execute("Cloud Run delivery configuration", [{}]), []);
  for (const endpoint of [
    "http://example.test/internal/warnings",
    "https://user:secret@example.test/internal/warnings",
    "https://example.test/internal/warnings?token=secret",
  ]) {
    assert.throws(() =>
      execute("Cloud Run delivery configuration", [{}], {}, (code) =>
        code.replace(
          "enabled: false, endpointUrl: ''",
          `enabled: true, endpointUrl: ${JSON.stringify(endpoint)}`,
        ),
      ),
    );
  }
  const output = execute("Cloud Run delivery configuration", [{}], {}, (code) =>
    code.replace(
      "enabled: false, endpointUrl: ''",
      "enabled: true, endpointUrl: 'https://example.run.app/internal/warnings'",
    ),
  );
  assert.equal(output[0].json.enabled, true);
});

test("only a matching successful backend acknowledgement advances delivery state", () => {
  const upstream = { "Deliver each warning handoff": { deliveryKey } };
  for (const statusCode of [200, 202]) {
    const output = execute(
      "Validate backend acknowledgement",
      [{ statusCode, body: { accepted: true, deliveryKey } }],
      upstream,
    );
    assert.deepEqual(output[0].json, {
      deliveryKey,
      deliveryStatus: "acknowledged",
      acknowledgedAt: timestamp,
    });
  }
  for (const response of [
    { statusCode: 500, body: { accepted: true, deliveryKey } },
    { statusCode: 200, body: { accepted: false, deliveryKey } },
    { statusCode: 200, body: { accepted: true, deliveryKey: "different" } },
    { statusCode: 200 },
    { body: { accepted: true, deliveryKey } },
  ]) {
    assert.throws(() =>
      execute("Validate backend acknowledgement", [response], upstream),
    );
  }
});

test("queue writes precede source deduplication and retries do not depend on fresh feed items", () => {
  const next = (name, index = 0) =>
    workflow.connections[name].main[index].map((link) => link.node);
  assert.deepEqual(next("Validate municipality statuses"), [
    "Prepare weather handoff",
  ]);
  assert.deepEqual(next("Queue weather handoff"), ["Save bulletin snapshot"]);
  assert.deepEqual(next("Normalize earthquake tsunami volcano"), [
    "Prepare disaster handoff",
  ]);
  assert.deepEqual(next("Queue disaster handoff"), ["Store disaster bulletin"]);
  for (const trigger of [
    "Manual recovery check",
    "Every minute - inactive until published",
  ]) {
    assert.ok(next(trigger).includes("Cloud Run delivery configuration"));
  }
  assert.deepEqual(next("Send warning to Cloud Run", 1), [
    "Deliver each warning handoff",
  ]);
  assert.deepEqual(next("Validate backend acknowledgement", 1), [
    "Deliver each warning handoff",
  ]);
  assert.deepEqual(next("Validate backend acknowledgement"), [
    "Record backend acknowledgement",
  ]);
  assert.equal(
    getNode("Send warning to Cloud Run").onError,
    "continueErrorOutput",
  );
  assert.equal(
    getNode("Validate backend acknowledgement").onError,
    "continueErrorOutput",
  );
  assert.equal(workflow.active, false);
  assert.equal(getNode("Send warning to Cloud Run").disabled, true);
});
