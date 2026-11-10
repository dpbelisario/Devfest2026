import type { GeofenceFeature, WayfindingFeature } from "./geojson.js";

/**
 * Merge rules for the two IndoorAtlas `PUT` calls, which replace everything
 * of a venue: read what is there, keep what the proposal does not own, then
 * write the union. Pure functions; publish.ts does the I/O.
 */

const featureId = (feature: unknown): string | null =>
  typeof feature === "object" &&
  feature !== null &&
  "id" in feature &&
  typeof feature.id === "string"
    ? feature.id.toLowerCase()
    : null;

const props = (feature: unknown): Record<string, unknown> =>
  typeof feature === "object" &&
  feature !== null &&
  "properties" in feature &&
  typeof feature.properties === "object" &&
  feature.properties !== null
    ? (feature.properties as Record<string, unknown>)
    : {};

const normalizeName = (value: unknown) =>
  typeof value === "string"
    ? value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
    : "";

/** Stable JSON for comparisons (object keys sorted). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export interface GeofencePlan {
  /** Body for `PUT /venues/{id}/geofences/geojson`. */
  features: unknown[];
  added: string[];
  updated: string[];
  unchanged: string[];
  /** Existing features the proposal does not own, kept as they are. */
  kept: number;
  /** Existing features with the same name and floor as a proposal feature but another id. */
  conflicts: string[];
  /** Conflicting features dropped because `replaceConflicts` was set. */
  replaced: string[];
  changed: boolean;
}

/**
 * Merge proposal features into the venue's current geofences/POIs.
 * Features are matched by id. An existing feature with a different id but the
 * same normalized name on the same floor (e.g. placed by hand in the web app)
 * is a conflict: it is kept and reported, unless `replaceConflicts` drops it,
 * so publishing never creates silent duplicates.
 */
export function planGeofences(
  existing: unknown[],
  ours: GeofenceFeature[],
  options: { replaceConflicts?: boolean } = {},
): GeofencePlan {
  const ourIds = new Set(ours.map((feature) => feature.id));
  const ourNames = new Map(
    ours.map((feature) => [
      `${feature.properties.floor}|${normalizeName(feature.properties.name)}`,
      feature.properties.name,
    ]),
  );
  const byId = new Map(
    existing.flatMap((feature) => {
      const id = featureId(feature);
      return id ? [[id, feature] as const] : [];
    }),
  );
  const conflicts: string[] = [];
  const replaced: string[] = [];
  const keptFeatures: unknown[] = [];
  for (const feature of existing) {
    const id = featureId(feature);
    if (id && ourIds.has(id)) continue;
    const { floor, name } = props(feature);
    const clash = ourNames.get(`${String(floor)}|${normalizeName(name)}`);
    if (clash) {
      const label = `${String(name)} (${id ?? "no id"})`;
      if (options.replaceConflicts) {
        replaced.push(label);
        continue;
      }
      conflicts.push(label);
    }
    keptFeatures.push(feature);
  }
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const feature of ours) {
    const current = byId.get(feature.id);
    const name = feature.properties.name;
    if (!current) added.push(name);
    else if (stableJson(current) === stableJson(feature)) unchanged.push(name);
    else updated.push(name);
  }
  return {
    features: [...keptFeatures, ...ours],
    added,
    updated,
    unchanged,
    kept: keptFeatures.length,
    conflicts,
    replaced,
    changed: added.length + updated.length + replaced.length > 0,
  };
}

export interface WayfindingPlan {
  /** Body for `PUT /venues/{id}/wayfinding/geojson`. */
  features: unknown[];
  added: number;
  /** Existing edges kept (merge) or dropped (`replaceGraph`). */
  kept: number;
  removed: number;
  changed: boolean;
}

const edgeKey = (feature: unknown): string | null => {
  if (typeof feature !== "object" || feature === null) return null;
  const geometry = (feature as { geometry?: unknown }).geometry;
  if (typeof geometry !== "object" || geometry === null) return null;
  const coordinates = (geometry as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return null;
  const ends = coordinates.map((point) =>
    Array.isArray(point)
      ? point
          .map((value) =>
            typeof value === "number" ? value.toFixed(7) : String(value),
          )
          .join(",")
      : "?",
  );
  return ends.sort().join("|");
};

/**
 * Merge proposal edges into the current wayfinding graph. Default: keep every
 * existing edge and add proposal edges not already present (same two
 * endpoints, either direction). `replaceGraph`: the graph becomes exactly the
 * proposal's edges (use after a backup, when an older proposal's edges moved).
 */
export function planWayfinding(
  existing: unknown[],
  ours: WayfindingFeature[],
  options: { replaceGraph?: boolean } = {},
): WayfindingPlan {
  if (options.replaceGraph) {
    const before = new Set(existing.map(edgeKey));
    const after = new Set(ours.map(edgeKey));
    const same =
      before.size === after.size && [...after].every((key) => before.has(key));
    return {
      features: ours,
      added: [...after].filter((key) => !before.has(key)).length,
      kept: 0,
      removed: existing.length,
      changed: !same || existing.length !== ours.length,
    };
  }
  const present = new Set(existing.map(edgeKey));
  const fresh = ours.filter((feature) => {
    const key = edgeKey(feature);
    if (present.has(key)) return false;
    present.add(key);
    return true;
  });
  return {
    features: [...existing, ...fresh],
    added: fresh.length,
    kept: existing.length,
    removed: 0,
    changed: fresh.length > 0,
  };
}
