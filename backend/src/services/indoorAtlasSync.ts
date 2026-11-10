import type { IndoorVenuesRepository } from "../repositories/indoorVenuesRepository.js";
import {
  iaFeatureCollectionSchema,
  iaFloorPlanSchema,
  iaPoiFeatureSchema,
  iaVenueSchema,
  iaWayfindingEdgeSchema,
  type IaFloorPlan,
  type IaPoiFeature,
  type IaVenue,
  type IndoorAtlasSyncSummary,
} from "../schemas/indoorAtlas.js";
import { indoorVenueSchema, type IndoorVenue } from "../schemas/indoorVenue.js";
import type { IndoorAtlasClient } from "./indoorAtlasClient.js";
import { parseVenueDocuments } from "./indoorVenueService.js";
import { JobError } from "./jobs/errors.js";

/**
 * Mirror the venue owner's IndoorAtlas account into Firestore `indoorVenues`
 * ("whatever is on IndoorAtlas is 01"). See docs/indoor-venues.md#indooratlas-sync.
 *
 * Mapping rules (each IndoorAtlas venue → one document `ia-<venue UUID>`):
 * - floors: every floor plan → `{ floorPlanId, floorLevel: floorNumber, name: "2F" | "B1" }`;
 *   floor numbers outside -5..60 and duplicate floor numbers (first plan wins) are skipped.
 * - location: venue coordinates; `radiusM` = farthest floor-plan corner from them + 20 m
 *   (clamped to 50..2000), else {@link defaultVenueRadiusM}.
 * - pois: every GeoJSON Point → `{ id: ia-<feature UUID>, indoorAtlasPoiId, lat, lng, floorLevel }`.
 * - exits: POIs whose name or description matches {@link classifyExit} keywords, with
 *   `source: "indooratlas"` (owner-marked, not independently verified).
 * - names: one IndoorAtlas name for both `en` and `ja`, unless it contains " / " (`en / ja`).
 * - `indoorAtlas.hasWayfinding`: whether the venue's wayfinding graph has edges.
 */

/** Gate radius when no floor-plan corners are available. */
export const defaultVenueRadiusM = 120;

const minRadiusM = 50;
const maxRadiusM = 2000;
const radiusMarginM = 20;
const maxPois = 500;
const maxExits = 200;

export interface IndoorAtlasSyncDependencies {
  /** Null when INDOORATLAS_MAPPING_API_KEY is not configured. */
  client: IndoorAtlasClient | null;
  /** May be null only when `client` is null (nothing is read or written then). */
  repository: IndoorVenuesRepository | null;
  now: () => Date;
  /** Receives skipped-item and progress messages; never receives the API key. */
  log?: (message: string) => void;
}

/** Venue ID used for the synced document of an IndoorAtlas venue. */
export function syncedVenueId(indoorAtlasVenueId: string): string {
  return `ia-${indoorAtlasVenueId.trim().toLowerCase()}`;
}

/** Split `English / 日本語` names; otherwise one name serves both languages. */
export function splitName(raw: string): { en: string; ja: string } | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return null;
  const separator = name.indexOf(" / ");
  const [en, ja] =
    separator > 0
      ? [name.slice(0, separator).trim(), name.slice(separator + 3).trim()]
      : [name, name];
  const clip = (value: string) => value.slice(0, 120).trim();
  return en && ja
    ? { en: clip(en), ja: clip(ja) }
    : { en: clip(name), ja: clip(name) };
}

const exitPattern = /\b(?:emergency\s+)?exits?\b|出口|非常口|避難/iu;
const entrancePattern = /\bentrances?\b|入口/iu;
const stairsPattern = /\bstair(?:s|case|cases|way|ways)?\b|階段/iu;

/**
 * Exit kind for a POI name/description, or null when it is not an exit.
 * Keywords (case-insensitive): exit, emergency exit, 出口, 非常口, 避難 → `exit`;
 * entrance, 入口 → `entrance`; stairs/staircase/stairway, 階段 → `stairs`.
 * When several match, exit wins over entrance, entrance over stairs.
 */
export function classifyExit(
  text: string,
): "exit" | "entrance" | "stairs" | null {
  const value = text.normalize("NFKC");
  if (exitPattern.test(value)) return "exit";
  if (entrancePattern.test(value)) return "entrance";
  if (stairsPattern.test(value)) return "stairs";
  return null;
}

function floorName(level: number): string {
  return level < 0 ? `B${-level}` : `${level}F`;
}

function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Gate radius from floor-plan corners (see module docs). */
export function venueRadius(
  center: { lat: number; lng: number },
  floorPlans: IaFloorPlan[],
): number {
  const corners = floorPlans.flatMap((plan) =>
    [
      plan.image?.topLeft,
      plan.image?.topRight,
      plan.image?.bottomLeft,
      plan.image?.bottomRight,
    ].filter((corner) => corner != null),
  );
  if (corners.length === 0) return defaultVenueRadiusM;
  const farthest = Math.max(
    ...corners.map((corner) =>
      distanceM(center, { lat: corner.lat, lng: corner.lon }),
    ),
  );
  if (!Number.isFinite(farthest)) return defaultVenueRadiusM;
  return Math.round(
    Math.min(maxRadiusM, Math.max(minRadiusM, farthest + radiusMarginM)),
  );
}

/** Raw data fetched for one IndoorAtlas venue. */
export interface IndoorAtlasVenueData {
  venue: IaVenue;
  /** Position in the IndoorAtlas venue list. */
  order: number;
  floorPlans: unknown[];
  /** Raw GeoJSON features (geofences and POIs); null when not set. */
  geofenceFeatures: unknown[] | null;
  /** Raw wayfinding features; null when the venue has no graph. */
  wayfindingFeatures: unknown[] | null;
}

/**
 * Map fetched IndoorAtlas data to a venue document. Malformed floor plans and
 * features are skipped (reported through `log`). Returns null when the venue
 * itself cannot be represented (no name, or 0,0 coordinates).
 */
export function mapIndoorAtlasVenue(
  data: IndoorAtlasVenueData,
  options: { updatedAt: string; log?: (message: string) => void },
): IndoorVenue | null {
  const log = options.log ?? (() => undefined);
  const { venue } = data;
  const name = splitName(venue.name);
  if (!name) {
    log(`IndoorAtlas venue ${venue.id}: empty name, skipped`);
    return null;
  }
  const center = { lat: venue.coordinates.lat, lng: venue.coordinates.lon };

  const plans: IaFloorPlan[] = [];
  data.floorPlans.forEach((raw, index) => {
    const parsed = iaFloorPlanSchema.safeParse(raw);
    if (parsed.success) plans.push(parsed.data);
    else
      log(
        `IndoorAtlas venue ${venue.id}: floor plan #${index} malformed, skipped`,
      );
  });
  const floors: IndoorVenue["indoorAtlas"]["floors"] = [];
  for (const plan of plans) {
    if (plan.floorNumber < -5 || plan.floorNumber > 60) {
      log(
        `IndoorAtlas floor plan ${plan.id}: floor ${plan.floorNumber} out of range, skipped`,
      );
      continue;
    }
    if (floors.some((floor) => floor.floorLevel === plan.floorNumber)) {
      log(
        `IndoorAtlas floor plan ${plan.id}: second plan for floor ${plan.floorNumber}, skipped`,
      );
      continue;
    }
    floors.push({
      floorPlanId: plan.id.toLowerCase(),
      floorLevel: plan.floorNumber,
      name: floorName(plan.floorNumber),
    });
  }
  floors.sort((a, b) => a.floorLevel - b.floorLevel);

  const pois: IndoorVenue["pois"] = [];
  const exits: IndoorVenue["exits"] = [];
  (data.geofenceFeatures ?? []).forEach((raw, index) => {
    if (
      typeof raw === "object" &&
      raw !== null &&
      "geometry" in raw &&
      typeof raw.geometry === "object" &&
      raw.geometry !== null &&
      "type" in raw.geometry &&
      raw.geometry.type !== "Point"
    )
      return; // geofence polygon: not used
    const parsed = iaPoiFeatureSchema.safeParse(raw);
    if (!parsed.success) {
      log(
        `IndoorAtlas venue ${venue.id}: feature #${index} malformed, skipped`,
      );
      return;
    }
    const poi = mapPoi(parsed.data);
    if (!poi) {
      log(
        `IndoorAtlas POI ${parsed.data.id}: no name, null island or floor out of range, skipped`,
      );
      return;
    }
    if (pois.length >= maxPois || pois.some((other) => other.id === poi.id)) {
      log(
        `IndoorAtlas POI ${parsed.data.id}: duplicate or over ${maxPois} POIs, skipped`,
      );
      return;
    }
    pois.push(poi);
    const kind = classifyExit(
      `${parsed.data.properties.name ?? ""}\n${parsed.data.properties.description ?? ""}`,
    );
    if (kind && exits.length < maxExits)
      exits.push({
        id: poi.id,
        name: poi.name,
        floorLevel: poi.floorLevel,
        lat: poi.lat!,
        lng: poi.lng!,
        kind,
        source: "indooratlas",
        indoorAtlasPoiId: poi.indoorAtlasPoiId,
      });
  });

  const hasWayfinding =
    data.wayfindingFeatures !== null &&
    data.wayfindingFeatures.some(
      (feature) => iaWayfindingEdgeSchema.safeParse(feature).success,
    );

  const candidate = {
    id: syncedVenueId(venue.id),
    name,
    enabled: true,
    syncedFrom: "indooratlas" as const,
    syncOrder: data.order,
    indoorAtlas: {
      venueId: venue.id.toLowerCase(),
      hasWayfinding,
      floors,
    },
    location: {
      lat: center.lat,
      lng: center.lng,
      radiusM: venueRadius(center, plans),
    },
    exits,
    pois,
    updatedAt: options.updatedAt,
    notes:
      "Synced from IndoorAtlas by contour-jobs. Exits are POIs whose name or description matched exit keywords (source indooratlas); they are not verified on site.",
  };
  const parsed = indoorVenueSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    log(
      `IndoorAtlas venue ${venue.id}: does not fit the venue schema (${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}), skipped`,
    );
    return null;
  }
  return parsed.data;
}

function mapPoi(feature: IaPoiFeature): IndoorVenue["pois"][number] | null {
  const name = splitName(feature.properties.name ?? "");
  const [lng, lat] = feature.geometry.coordinates;
  const floorLevel = feature.properties.floor;
  if (!name || (lat === 0 && lng === 0) || floorLevel < -5 || floorLevel > 60)
    return null;
  const id = feature.id.toLowerCase();
  return {
    id: `ia-${id}`,
    name,
    floorLevel,
    indoorAtlasPoiId: id,
    lat,
    lng,
  };
}

/** Content comparison that ignores `updatedAt`, so unchanged venues are not rewritten. */
function sameContent(a: IndoorVenue, b: IndoorVenue): boolean {
  const strip = ({ updatedAt: _updatedAt, ...rest }: IndoorVenue) => {
    void _updatedAt;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

async function fetchFeatures(
  client: IndoorAtlasClient,
  path: string,
): Promise<unknown[] | null> {
  const result = await client.get(path);
  if (result.status === "notFound") return null;
  const parsed = iaFeatureCollectionSchema.safeParse(result.body);
  if (!parsed.success)
    throw new JobError(
      "INVALID_UPSTREAM_DATA",
      502,
      `IndoorAtlas ${path} is not a FeatureCollection`,
    );
  return parsed.data.features;
}

/**
 * Run one sync. GET-only against IndoorAtlas; writes only documents with
 * `syncedFrom: "indooratlas"`.
 *
 * - Not configured (no client): returns `configured: false` and touches nothing.
 * - `GET /venues` fails or is not a list: throws JobError (nothing written).
 * - A venue whose floor plans/geofences/wayfinding cannot be fetched, or that
 *   does not map to a valid document, is skipped; its existing document is kept.
 * - A venue already covered by a manual document (same IndoorAtlas venue ID, or
 *   a manual document occupying `ia-<id>`) is skipped: manual documents win.
 * - Synced documents whose IndoorAtlas venue is gone are set `enabled: false`.
 * - New venues are enabled; existing synced documents keep their `enabled`
 *   flag (so `indoor-venues disable ia-…` sticks). Unchanged content is not rewritten.
 */
export async function syncIndoorAtlasVenues(
  dependencies: IndoorAtlasSyncDependencies,
): Promise<IndoorAtlasSyncSummary> {
  const { client, repository } = dependencies;
  const log = dependencies.log ?? ((message) => console.warn(message));
  const summary: IndoorAtlasSyncSummary = {
    configured: client !== null,
    venues: 0,
    floors: 0,
    pois: 0,
    exits: 0,
    updated: 0,
    disabled: 0,
    skipped: 0,
  };
  if (!client) return summary;
  if (!repository)
    throw new Error("IndoorAtlas sync has a client but no indoorVenues store");

  const list = await client.get("/venues");
  if (list.status !== "ok" || !Array.isArray(list.body))
    throw new JobError(
      "INVALID_UPSTREAM_DATA",
      502,
      "IndoorAtlas /venues did not return a list",
    );
  const venues: IaVenue[] = [];
  list.body.forEach((raw, index) => {
    const parsed = iaVenueSchema.safeParse(raw);
    if (parsed.success) venues.push(parsed.data);
    else log(`IndoorAtlas venue #${index} malformed, skipped`);
  });

  const parsedDocs = parseVenueDocuments(await repository.listVenueDocuments());
  for (const { docId, reason } of parsedDocs.rejected)
    log(`Ignoring invalid indoorVenues/${docId} during sync: ${reason}`);
  const existing = new Map(parsedDocs.venues.map((venue) => [venue.id, venue]));
  const manual = parsedDocs.venues.filter(
    (venue) => venue.syncedFrom !== "indooratlas",
  );
  // Documents that fail validation are left alone; their IDs are never reused.
  const rejectedIds = new Set(parsedDocs.rejected.map(({ docId }) => docId));
  const updatedAt = dependencies.now().toISOString();
  const seenIds = new Set<string>();

  for (const [order, venue] of venues.entries()) {
    const id = syncedVenueId(venue.id);
    if (seenIds.has(id)) {
      log(`IndoorAtlas venue ${venue.id}: listed twice, second copy skipped`);
      continue;
    }
    seenIds.add(id);
    const current = existing.get(id);
    const manualCover = manual.find(
      (doc) =>
        doc.id === id ||
        doc.indoorAtlas.venueId.toLowerCase() === venue.id.toLowerCase(),
    );
    if (manualCover || rejectedIds.has(id)) {
      log(
        `IndoorAtlas venue ${venue.id}: ${manualCover ? `manual document indoorVenues/${manualCover.id} covers it` : `indoorVenues/${id} is invalid`}, not synced`,
      );
      summary.skipped++;
      continue;
    }
    let mapped: IndoorVenue | null;
    try {
      const plans = await client.get(`/venues/${venue.id}/floorplans`);
      const floorPlans =
        plans.status === "ok" && Array.isArray(plans.body) ? plans.body : [];
      if (plans.status === "ok" && !Array.isArray(plans.body))
        log(
          `IndoorAtlas venue ${venue.id}: floor plans are not a list, ignored`,
        );
      const geofenceFeatures = await fetchFeatures(
        client,
        `/venues/${venue.id}/geofences/geojson`,
      );
      const wayfindingFeatures = await fetchFeatures(
        client,
        `/venues/${venue.id}/wayfinding/geojson`,
      );
      mapped = mapIndoorAtlasVenue(
        { venue, order, floorPlans, geofenceFeatures, wayfindingFeatures },
        { updatedAt, log },
      );
    } catch (error) {
      if (!(error instanceof JobError)) throw error;
      log(
        `IndoorAtlas venue ${venue.id}: ${error.message}; keeping the stored copy`,
      );
      summary.skipped++;
      continue;
    }
    if (!mapped) {
      summary.skipped++;
      continue;
    }
    const next: IndoorVenue = current
      ? { ...mapped, enabled: current.enabled }
      : mapped;
    if (!current || !sameContent(current, next)) {
      await repository.saveVenue(next);
      summary.updated++;
    }
    summary.venues++;
    summary.floors += next.indoorAtlas.floors.length;
    summary.pois += next.pois.length;
    summary.exits += next.exits.length;
  }

  for (const doc of parsedDocs.venues) {
    if (doc.syncedFrom !== "indooratlas" || seenIds.has(doc.id) || !doc.enabled)
      continue;
    await repository.saveVenue({ ...doc, enabled: false, updatedAt });
    log(`indoorVenues/${doc.id}: venue no longer in IndoorAtlas, disabled`);
    summary.disabled++;
  }
  return summary;
}
