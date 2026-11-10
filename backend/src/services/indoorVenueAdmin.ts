import { z } from "zod";
import type { IndoorVenuesRepository } from "../repositories/indoorVenuesRepository.js";
import {
  indoorVenueInputSchema,
  type IndoorVenue,
} from "../schemas/indoorVenue.js";
import type { IndoorAtlasClient } from "./indoorAtlasClient.js";
import { syncIndoorAtlasVenues } from "./indoorAtlasSync.js";
import {
  readRawSnapshot,
  type IndoorAtlasArchiveStore,
} from "./indoorAtlasArchive.js";
import { mergeVenues, parseVenueDocuments } from "./indoorVenueService.js";

export const indoorVenuesUsage = `Usage: npm run indoor-venues --workspace backend -- <command>
  list                 Show stored and seed venues (enabled/disabled, origin)
  upsert <file.json>   Validate and write one venue, an array, or {"venues": [...]}
  enable <id>          Enable a venue (copies a seed venue into Firestore if needed)
  disable <id>         Disable a venue (copies a seed venue into Firestore if needed)
  sync                 Mirror the IndoorAtlas account (INDOORATLAS_MAPPING_API_KEY) into Firestore
  export <venueId|all> <dir>
                       Write the raw IndoorAtlas archive (INDOORATLAS_ARCHIVE_BUCKET) to <dir>`;

/** Thrown for bad input; the script prints the message without a stack trace. */
export class AdminInputError extends Error {}

/** Accepts one venue object, an array, or `{ venues: [...] }`; sets `updatedAt`. */
export function parseVenueUpload(
  input: unknown,
  now: () => Date = () => new Date(),
): IndoorVenue[] {
  const wrapped = z
    .object({ venues: z.array(z.unknown()) })
    .strict()
    .safeParse(input);
  const list: unknown[] = Array.isArray(input)
    ? input
    : wrapped.success
      ? wrapped.data.venues
      : [input];
  if (list.length === 0) throw new AdminInputError("No venues in the file.");
  return list.map((item, index) => {
    const parsed = indoorVenueInputSchema.safeParse(item);
    if (!parsed.success)
      throw new AdminInputError(
        `Venue ${index + 1} is invalid:\n${parsed.error.issues
          .map(
            (issue) =>
              `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("\n")}`,
      );
    return { ...parsed.data, updatedAt: now().toISOString() };
  });
}

/**
 * Run one admin command against a repository. Returns the lines to print.
 * Throws AdminInputError for usage errors and invalid venue files.
 */
export async function runIndoorVenuesCommand(
  args: string[],
  dependencies: {
    repository: IndoorVenuesRepository;
    seed: IndoorVenue[];
    readJson: (path: string) => Promise<unknown>;
    now?: () => Date;
    /** For `sync`; null when INDOORATLAS_MAPPING_API_KEY is not set. */
    indoorAtlasClient?: IndoorAtlasClient | null;
    /** Sync progress/skip messages. */
    log?: (message: string) => void;
    /** Raw archive for `sync` and `export`; null when INDOORATLAS_ARCHIVE_BUCKET is unset. */
    archive?: IndoorAtlasArchiveStore | null;
    /** Writes one export file (creating directories); required for `export`. */
    writeFile?: (path: string, data: string | Buffer) => Promise<void>;
  },
): Promise<string[]> {
  const { repository, seed } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const [command, argument] = args;
  const load = async () => {
    const parsed = parseVenueDocuments(await repository.listVenueDocuments());
    return { ...parsed, merged: mergeVenues(parsed.venues, seed) };
  };
  switch (command) {
    case "list": {
      const { merged, rejected } = await load();
      return [
        ...merged.map(
          ({ venue, origin }) =>
            `${venue.enabled ? "enabled " : "disabled"}  ${venue.id}  (${venue.syncedFrom === "indooratlas" ? "indooratlas sync" : origin})  ${venue.name.en}  venue=${venue.indoorAtlas?.venueId ?? "none"}  floors=${venue.indoorAtlas?.floors.length ?? venue.floorLevels?.length ?? 0} pois=${venue.pois.length} exits=${venue.exits.length}  updated ${venue.updatedAt}`,
        ),
        ...rejected.map(
          ({ docId, reason }) =>
            `INVALID   ${docId}  (ignored by the API): ${reason}`,
        ),
      ];
    }
    case "upsert": {
      if (!argument) throw new AdminInputError(indoorVenuesUsage);
      const venues = parseVenueUpload(
        await dependencies.readJson(argument),
        now,
      );
      for (const venue of venues) await repository.saveVenue(venue);
      return venues.map(
        (venue) =>
          `Saved indoorVenues/${venue.id} (${venue.enabled ? "enabled" : "disabled"}). The app picks it up within about 2 minutes.`,
      );
    }
    case "enable":
    case "disable": {
      if (!argument) throw new AdminInputError(indoorVenuesUsage);
      const { merged } = await load();
      const entry = merged.find(({ venue }) => venue.id === argument);
      if (!entry)
        throw new AdminInputError(
          `No venue "${argument}". Known: ${merged.map(({ venue }) => venue.id).join(", ") || "none"}`,
        );
      const enabled = command === "enable";
      await repository.saveVenue({
        ...entry.venue,
        enabled,
        updatedAt: now().toISOString(),
      });
      return [
        `${enabled ? "Enabled" : "Disabled"} indoorVenues/${argument}${entry.origin === "seed" ? " (copied from the seed)" : ""}. The app picks it up within about 2 minutes.`,
      ];
    }
    case "sync": {
      const summary = await syncIndoorAtlasVenues({
        client: dependencies.indoorAtlasClient ?? null,
        repository,
        now,
        archive: dependencies.archive ?? null,
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
      if (!summary.configured)
        return [
          "IndoorAtlas sync is not configured: set INDOORATLAS_MAPPING_API_KEY (the IndoorAtlas Mapping API key). Nothing was changed.",
        ];
      return [
        `IndoorAtlas sync: ${summary.venues} venues (${summary.floors} floors, ${summary.pois} POIs, ${summary.exits} exits, ${summary.areas} areas), ${summary.updated} written, ${summary.disabled} disabled, ${summary.skipped} skipped. The app picks changes up within about 2 minutes.`,
      ];
    }
    case "export": {
      const directory = args[2];
      if (!argument || !directory) throw new AdminInputError(indoorVenuesUsage);
      const { archive, writeFile } = dependencies;
      if (!archive || !writeFile)
        throw new AdminInputError(
          "Raw archive not configured: set INDOORATLAS_ARCHIVE_BUCKET (e.g. <project>-indooratlas).",
        );
      return exportRawArchive(archive, writeFile, argument, directory);
    }
    default:
      throw new AdminInputError(indoorVenuesUsage);
  }
}

/**
 * Write the current raw snapshot of one venue (or `all`) as plain files:
 * `<dir>/<venueId>/{meta,snapshot,venue,floorplans}.json`,
 * `{geofences,wayfinding,radios}.geojson`, `paths/<floorPlanId>.geojson` and
 * `images/<floorPlanId>.<ext>`. Contains no API key (none is ever stored).
 */
export async function exportRawArchive(
  archive: IndoorAtlasArchiveStore,
  writeFile: (path: string, data: string | Buffer) => Promise<void>,
  target: string,
  directory: string,
): Promise<string[]> {
  const ids =
    target === "all"
      ? (await archive.listMeta()).map((meta) => meta.venueId)
      : [target.trim().toLowerCase()];
  if (ids.length === 0) return ["The raw archive is empty: run a sync first."];
  const lines: string[] = [];
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new AdminInputError(`"${id}" is not an IndoorAtlas venue UUID.`);
    const stored = await readRawSnapshot(archive, id);
    if (!stored) {
      lines.push(`No raw snapshot for ${id}.`);
      continue;
    }
    const { meta, snapshot } = stored;
    const base = `${directory}/${id}`;
    await writeFile(`${base}/meta.json`, json(meta));
    await writeFile(`${base}/snapshot.json`, json(snapshot));
    await writeFile(`${base}/venue.json`, json(snapshot.venue));
    await writeFile(`${base}/floorplans.json`, json(snapshot.floorPlans));
    await writeFile(`${base}/geofences.geojson`, json(snapshot.geofences));
    await writeFile(`${base}/wayfinding.geojson`, json(snapshot.wayfinding));
    await writeFile(`${base}/radios.geojson`, json(snapshot.radios));
    for (const [floorPlanId, paths] of Object.entries(snapshot.paths))
      await writeFile(`${base}/paths/${floorPlanId}.geojson`, json(paths));
    let images = 0;
    for (const image of meta.images) {
      const bytes = await archive.getObject(image.path);
      if (!bytes) continue;
      const ext = image.path.split(".").pop() ?? "img";
      await writeFile(`${base}/images/${image.floorPlanId}.${ext}`, bytes);
      images++;
    }
    lines.push(
      `Exported ${id} (${meta.name}, snapshot ${meta.contentHash.slice(0, 12)} from ${meta.fetchedAt}, ${images} images) to ${base}`,
    );
  }
  return lines;
}
