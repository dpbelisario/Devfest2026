import {
  iaFeatureCollectionSchema,
  iaFloorPlanSchema,
} from "../../schemas/indoorAtlas.js";
import type { IndoorAtlasClient } from "../indoorAtlasClient.js";
import {
  buildGeofenceFeatures,
  buildWayfindingFeatures,
  planCorners,
} from "./geojson.js";
import type { IndoorAtlasWriter } from "./mappingWriter.js";
import {
  planGeofences,
  planWayfinding,
  type GeofencePlan,
  type WayfindingPlan,
} from "./merge.js";
import { checkProposal, type FloorPlanProposal } from "./proposal.js";

/** A backup of one replaced GeoJSON document, enough to restore it with `PUT`. */
export interface FloorPlanBackup {
  kind: "geofences" | "wayfinding";
  venueId: string;
  takenAt: string;
  /** The exact body `GET` returned (a FeatureCollection), or an empty one when there was none. */
  body: { type: "FeatureCollection"; features: unknown[] };
}

export interface PublishDependencies {
  client: IndoorAtlasClient;
  /** Required for `apply`; null for dry runs. */
  writer: IndoorAtlasWriter | null;
  /** Stores a backup and returns where it went (path or URL). */
  saveBackup: (backup: FloorPlanBackup) => Promise<string>;
  now: () => Date;
}

export interface PublishOptions {
  /** False (default): read, plan and report only; nothing is written. */
  apply?: boolean;
  replaceConflicts?: boolean;
  replaceGraph?: boolean;
}

export interface PublishReport {
  applied: boolean;
  geofences: GeofencePlan;
  /** Null when the proposal has no graph (wayfinding is left untouched). */
  wayfinding: WayfindingPlan | null;
  backups: string[];
  /** Human-readable report lines (no secrets). */
  lines: string[];
}

/** Input problem the operator must fix; the message is safe to print. */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

async function readCollection(
  client: IndoorAtlasClient,
  path: string,
): Promise<{ type: "FeatureCollection"; features: unknown[] }> {
  const result = await client.get(path);
  if (result.status === "notFound")
    return { type: "FeatureCollection", features: [] };
  const parsed = iaFeatureCollectionSchema.safeParse(result.body);
  if (!parsed.success)
    throw new PublishError(`IndoorAtlas ${path} is not a FeatureCollection.`);
  return {
    ...(result.body as object),
    type: "FeatureCollection",
    features: parsed.data.features,
  };
}

/**
 * Publish a reviewed proposal to IndoorAtlas (docs/floorplan-to-indooratlas.md).
 *
 * 1. Checks the proposal (checkProposal) and that the IndoorAtlas floor plan
 *    exists, is on the proposal's floor, is placed on the map and has the
 *    same aspect ratio as the traced image (within 1%).
 * 2. Reads the venue's geofences and wayfinding graph and plans the merge
 *    (merge.ts). Conflicts stop the run unless `replaceConflicts`.
 * 3. Dry run (default): returns the plan, writes nothing.
 *    `apply`: requires `review.status: "reviewed"`, saves a backup of every
 *    document it will replace, then PUTs only the documents that change.
 *
 * Throws PublishError for proposal/venue problems and JobError for API failures.
 */
export async function publishFloorPlanProposal(
  proposal: FloorPlanProposal,
  dependencies: PublishDependencies,
  options: PublishOptions = {},
): Promise<PublishReport> {
  const problems = checkProposal(proposal);
  if (problems.length)
    throw new PublishError(
      `The proposal has problems:\n- ${problems.join("\n- ")}`,
    );
  const venueId = proposal.venue.indoorAtlasVenueId;
  const plans = await dependencies.client.get(`/venues/${venueId}/floorplans`);
  if (plans.status === "notFound" || !Array.isArray(plans.body))
    throw new PublishError(
      `IndoorAtlas venue ${venueId} not found or has no floor plans.`,
    );
  const plan = plans.body
    .map((raw) => iaFloorPlanSchema.safeParse(raw))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .find((item) => item.id.toLowerCase() === proposal.floor.floorPlanId);
  if (!plan)
    throw new PublishError(
      `Floor plan ${proposal.floor.floorPlanId} is not in venue ${venueId}.`,
    );
  if (plan.floorNumber !== proposal.floor.floorNumber)
    throw new PublishError(
      `Floor plan ${plan.id} is on floor ${plan.floorNumber}, the proposal says ${proposal.floor.floorNumber}.`,
    );
  const corners = planCorners(plan);
  if (!corners)
    throw new PublishError(
      `Floor plan ${plan.id} is not placed on the map yet (no corner coordinates).`,
    );
  const width = plan.image?.width;
  const height = plan.image?.height;
  if (width && height) {
    const aspect = width / height;
    if (
      Math.abs(aspect - proposal.floor.imageAspect) /
        proposal.floor.imageAspect >
      0.01
    )
      throw new PublishError(
        `Floor plan image is ${width}x${height} (aspect ${aspect.toFixed(4)}) but the proposal was traced on aspect ${proposal.floor.imageAspect}; it is probably a different crop.`,
      );
  }

  const geofencePath = `/venues/${venueId}/geofences/geojson`;
  const wayfindingPath = `/venues/${venueId}/wayfinding/geojson`;
  const currentGeofences = await readCollection(
    dependencies.client,
    geofencePath,
  );
  const geofences = planGeofences(
    currentGeofences.features,
    buildGeofenceFeatures(proposal, corners),
    { replaceConflicts: options.replaceConflicts },
  );
  const hasGraph = proposal.graph.edges.length > 0;
  const currentWayfinding = hasGraph
    ? await readCollection(dependencies.client, wayfindingPath)
    : null;
  const wayfinding = currentWayfinding
    ? planWayfinding(
        currentWayfinding.features,
        buildWayfindingFeatures(proposal, corners),
        { replaceGraph: options.replaceGraph },
      )
    : null;

  const lines = [
    `Venue ${proposal.venue.name} (${venueId}), floor ${proposal.floor.floorNumber}, plan ${plan.id}`,
    `Geofences/POIs: ${geofences.added.length} added, ${geofences.updated.length} updated, ${geofences.unchanged.length} unchanged, ${geofences.kept} existing kept${geofences.replaced.length ? `, ${geofences.replaced.length} replaced` : ""}`,
    ...geofences.added.map((name) => `  + ${name}`),
    ...geofences.updated.map((name) => `  ~ ${name}`),
    ...geofences.replaced.map((name) => `  - ${name} (replaced)`),
    wayfinding
      ? `Wayfinding: ${wayfinding.added} edges added, ${wayfinding.kept} kept, ${wayfinding.removed} removed`
      : "Wayfinding: proposal has no graph, left untouched",
  ];
  if (geofences.conflicts.length) {
    lines.push(
      "Conflicts (same name and floor, different id; rerun with --replace-conflicts to replace them):",
      ...geofences.conflicts.map((name) => `  ! ${name}`),
    );
  }
  const report: PublishReport = {
    applied: false,
    geofences,
    wayfinding,
    backups: [],
    lines,
  };
  if (!options.apply) {
    lines.push("Dry run: nothing was written. Add --apply to publish.");
    return report;
  }
  if (geofences.conflicts.length) throw new PublishError(lines.join("\n"));
  if (proposal.review.status !== "reviewed")
    throw new PublishError(
      'Only reviewed proposals can be published: set review.status to "reviewed" after checking every item.',
    );
  if (!dependencies.writer)
    throw new PublishError("No IndoorAtlas writer configured.");
  const takenAt = dependencies.now().toISOString();
  if (geofences.changed) {
    report.backups.push(
      await dependencies.saveBackup({
        kind: "geofences",
        venueId,
        takenAt,
        body: currentGeofences,
      }),
    );
    await dependencies.writer.put(geofencePath, {
      type: "FeatureCollection",
      features: geofences.features,
    });
  }
  if (wayfinding?.changed && currentWayfinding) {
    report.backups.push(
      await dependencies.saveBackup({
        kind: "wayfinding",
        venueId,
        takenAt,
        body: currentWayfinding,
      }),
    );
    await dependencies.writer.put(wayfindingPath, {
      type: "FeatureCollection",
      features: wayfinding.features,
    });
  }
  report.applied = true;
  lines.push(
    geofences.changed || wayfinding?.changed
      ? `Published. Backups: ${report.backups.join(", ")}`
      : "Nothing to change; IndoorAtlas already matches the proposal.",
  );
  return report;
}

/** Restore a backup taken by {@link publishFloorPlanProposal}. */
export async function restoreFloorPlanBackup(
  backup: FloorPlanBackup,
  writer: IndoorAtlasWriter,
): Promise<string> {
  const path = `/venues/${backup.venueId}/${backup.kind}/geojson`;
  await writer.put(path, backup.body);
  return `Restored ${backup.kind} of venue ${backup.venueId} from ${backup.takenAt} (${backup.body.features.length} features).`;
}
