import { readFileSync } from "node:fs";
import { XMLBuilder } from "fast-xml-parser";
import { MemoryJobsRepository } from "../src/repositories/memoryJobsRepository.js";
import type { JobsContext } from "../src/services/jobs/context.js";
import { JobError } from "../src/services/jobs/errors.js";

/**
 * OFFLINE TEST FIXTURES ONLY: JMA sample tsunami XML plus historical
 * earthquake and volcano bulletins in n8n/xml2js shape. Never import as live
 * warnings.
 */
export const eqvolFixtures = JSON.parse(
  readFileSync(new URL("./fixtures/jma-eqvol.json", import.meta.url), "utf8"),
) as Record<
  "VXSE53" | "VTSE41" | "VFVO50",
  { Report: Record<string, unknown> }
>;

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  attributesGroupName: "$",
  textNodeName: "_",
});

/** Serialise an xml2js-shaped object back to XML for parser round trips. */
export function toXml(value: unknown): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${String(builder.build(value))}`;
}

export const weatherUrl =
  "https://www.data.jma.go.jp/developer/xml/data/20261105010000_0_VPWW53_230000.xml";

/** Synthetic Aichi weather report, never persisted as an official warning. */
export function weatherReport() {
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
    } as Record<string, unknown> & {
      Control: Record<string, unknown>;
      Head: Record<string, unknown>;
      Body?: unknown;
    },
  };
}

/** Atom feed entry in xml2js shape. */
export function feedEntry(
  href: string,
  updated: string,
  author = "名古屋地方気象台",
) {
  return {
    title: "気象特別警報・警報・注意報",
    updated,
    author: { name: author },
    link: { $: { type: "application/xml", href } },
  };
}

export function feedXml(entries: unknown[]): string {
  return toXml({
    feed: {
      $: { xmlns: "http://www.w3.org/2005/Atom", lang: "ja" },
      title: "test feed",
      updated: "2026-11-05T02:00:00Z",
      entry: entries,
    },
  });
}

/** Context with an in-memory repository and a URL → body map instead of network. */
export function testContext(responses: Record<string, string> = {}) {
  const repository = new MemoryJobsRepository();
  const fetched: string[] = [];
  let runCounter = 0;
  const context: JobsContext = {
    repository,
    now: () => new Date("2026-11-05T02:00:00.000Z"),
    newRunId: () => `run-${++runCounter}`,
    delivery: { topic: "contour-test-warnings", sender: null },
    fetchText: async (url) => {
      fetched.push(url);
      const body = responses[url];
      if (body === undefined)
        throw new JobError("UPSTREAM_UNAVAILABLE", 502, `No mock for ${url}`);
      return body;
    },
  };
  return { context, repository, fetched, responses };
}
