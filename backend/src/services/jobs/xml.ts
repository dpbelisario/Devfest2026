import { XMLParser } from "fast-xml-parser";
import { invalidUpstream } from "./errors.js";

/**
 * Parser configured to produce the same shapes as n8n's XML node
 * (xml2js with explicitArray=false, mergeAttrs=false, trim=true):
 * attributes under `$`, text under `_` only when attributes exist, a single
 * child as an object and repeated children as an array. Values stay strings.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  attributesGroupName: "$",
  textNodeName: "_",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  processEntities: true,
  htmlEntities: false,
});

/** Parse an official JMA XML document. Throws INVALID_UPSTREAM_DATA on failure. */
export function parseXml(xml: string): Record<string, unknown> {
  // JMA documents never declare a DOCTYPE; refusing it avoids entity expansion.
  if (/<!DOCTYPE/i.test(xml)) throw invalidUpstream("XML DOCTYPE refused");
  let parsed: unknown;
  try {
    parsed = parser.parse(xml, true);
  } catch (error) {
    throw invalidUpstream(
      `Malformed XML: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  if (!isRecord(parsed)) throw invalidUpstream("Malformed XML root");
  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** xml2js-style `explicitArray: false` normalization: absent → [], single → [value]. */
export function list(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read element text whether it was parsed as a string or as `{ _: text, $: attrs }`. */
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value._ === "string") return value._;
  return "";
}

/** Safe nested property access over parsed XML (`get(report, "Head", "Title")`). */
export function get(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Attribute value of a parsed element, or undefined. */
export function attribute(value: unknown, name: string): unknown {
  return get(value, "$", name);
}
