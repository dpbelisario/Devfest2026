/**
 * Floor plan → IndoorAtlas CLI (docs/floorplan-to-indooratlas.md).
 *
 *   npm run floorplan --workspace backend -- check backend/data/floorplans/sai-dining-2f.json
 *   npm run floorplan --workspace backend -- extract plan.png --venue <uuid> --floor 2 \
 *       --floor-plan <uuid> --title "Source title" --out proposal.json
 *   INDOORATLAS_MAPPING_API_KEY=… npm run floorplan --workspace backend -- publish proposal.json [--apply]
 *       [--replace-conflicts] [--replace-graph] [--backup-dir ./floorplan-backups]
 *   INDOORATLAS_MAPPING_API_KEY=… npm run floorplan --workspace backend -- restore backup.json --apply
 *
 * `extract` uses Gemini on Vertex AI with Application Default Credentials
 * (GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION default `global`,
 * FLOORPLAN_MODEL default `gemini-3.5-flash-lite`, the model the app assistant uses). `publish` is a dry run unless
 * `--apply`; with `--apply` it backs up every replaced document to
 * `--backup-dir` and, when INDOORATLAS_ARCHIVE_BUCKET is set, to
 * gs://<bucket>/floorplan-backups/. The API key is read from the environment only.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { Storage } from "@google-cloud/storage";
import { createIndoorAtlasClient } from "../src/services/indoorAtlasClient.js";
import {
  checkProposal,
  createGeminiLabelModel,
  createIndoorAtlasWriter,
  extractionPrompt,
  floorPlanProposalSchema,
  labelsToProposal,
  parseLabels,
  publishFloorPlanProposal,
  PublishError,
  restoreFloorPlanBackup,
  type FloorPlanBackup,
} from "../src/services/floorplanIngestion/index.js";

const callerDirectory = process.env.INIT_CWD ?? process.cwd();
const here = (path: string) => resolve(callerDirectory, path);
const optional = (value: string | undefined) => value?.trim() || undefined;

const [command, file, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const value = (name: string) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};

async function readProposal(path: string) {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(here(path), "utf8"));
  } catch {
    throw new PublishError(`${path} is not readable JSON.`);
  }
  const parsed = floorPlanProposalSchema.safeParse(json);
  if (!parsed.success)
    throw new PublishError(
      `${path} is not a valid proposal:\n${parsed.error.issues
        .slice(0, 10)
        .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
        .join("\n")}`,
    );
  return parsed.data;
}

function mappingKey(): string {
  const key = optional(process.env.INDOORATLAS_MAPPING_API_KEY);
  if (!key)
    throw new PublishError(
      "Set INDOORATLAS_MAPPING_API_KEY (Secret Manager: indooratlas-mapping-api-key).",
    );
  return key;
}

async function run(): Promise<string[]> {
  if (!command || !file)
    throw new PublishError(
      "Usage: floorplan check|extract|publish|restore <file> [options]; see the header of backend/scripts/floorplan.ts.",
    );
  if (command === "check") {
    const proposal = await readProposal(file);
    const problems = checkProposal(proposal);
    if (problems.length) throw new PublishError(problems.join("\n"));
    return [
      `OK: ${proposal.pois.length} POIs, ${proposal.areas.length} areas, ${proposal.graph.edges.length} graph edges, review ${proposal.review.status}.`,
    ];
  }
  if (command === "extract") {
    const venueId = value("venue");
    const floorPlanId = value("floor-plan");
    const floor = Number(value("floor"));
    const out = value("out");
    if (!venueId || !floorPlanId || !Number.isInteger(floor) || !out)
      throw new PublishError(
        "extract needs --venue <uuid> --floor <n> --floor-plan <uuid> --out <file>.",
      );
    const image = await readFile(here(file));
    const ext = extname(file).toLowerCase();
    const mimeType =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : null;
    if (!mimeType) throw new PublishError("Use a PNG or JPEG image.");
    const aspect = imageAspect(image, mimeType);
    const model = createGeminiLabelModel({
      project: optional(process.env.GOOGLE_CLOUD_PROJECT),
      location: optional(process.env.GOOGLE_CLOUD_LOCATION) ?? "global",
      model: optional(process.env.FLOORPLAN_MODEL) ?? "gemini-3.5-flash",
    });
    const { labels, dropped } = parseLabels(
      await model({ image, mimeType, prompt: extractionPrompt }),
    );
    const proposal = labelsToProposal(labels, {
      venue: {
        indoorAtlasVenueId: venueId.toLowerCase(),
        name: value("name") ?? basename(file),
      },
      floor: {
        floorNumber: floor,
        floorPlanId: floorPlanId.toLowerCase(),
        imageAspect: aspect,
      },
      source: { kind: "floor-plan", title: value("title") ?? basename(file) },
      now: new Date(),
    });
    await writeFile(here(out), `${JSON.stringify(proposal, null, 2)}\n`);
    return [
      `Wrote ${out}: ${proposal.pois.length} proposed POIs from ${labels.length} labels (${dropped} malformed dropped).`,
      'Review every POI, add the walkable graph, then set review.status to "reviewed".',
    ];
  }
  if (command === "publish") {
    const proposal = await readProposal(file);
    const apply = flag("apply");
    const key = mappingKey();
    const backupDir = here(value("backup-dir") ?? "floorplan-backups");
    const bucket = optional(process.env.INDOORATLAS_ARCHIVE_BUCKET);
    const report = await publishFloorPlanProposal(
      proposal,
      {
        client: createIndoorAtlasClient({ apiKey: key }),
        writer: apply ? createIndoorAtlasWriter({ apiKey: key }) : null,
        now: () => new Date(),
        saveBackup: async (backup) => {
          const name = `${backup.venueId}/${backup.takenAt.replace(/[:.]/g, "-")}-${backup.kind}.json`;
          const text = `${JSON.stringify(backup, null, 2)}\n`;
          const path = resolve(backupDir, name);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, text);
          if (!bucket) return path;
          await new Storage()
            .bucket(bucket)
            .file(`floorplan-backups/${name}`)
            .save(text, { contentType: "application/json" });
          return `${path} + gs://${bucket}/floorplan-backups/${name}`;
        },
      },
      {
        apply,
        replaceConflicts: flag("replace-conflicts"),
        replaceGraph: flag("replace-graph"),
      },
    );
    return report.lines;
  }
  if (command === "restore") {
    const backup = JSON.parse(
      await readFile(here(file), "utf8"),
    ) as FloorPlanBackup;
    if (
      (backup.kind !== "geofences" && backup.kind !== "wayfinding") ||
      !/^[0-9a-f-]{36}$/i.test(backup.venueId) ||
      !Array.isArray(backup.body?.features)
    )
      throw new PublishError(`${file} is not a floor plan backup.`);
    if (!flag("apply"))
      return [
        `Would restore ${backup.kind} of venue ${backup.venueId} from ${backup.takenAt} (${backup.body.features.length} features). Add --apply.`,
      ];
    return [
      await restoreFloorPlanBackup(
        backup,
        createIndoorAtlasWriter({ apiKey: mappingKey() }),
      ),
    ];
  }
  throw new PublishError(`Unknown command ${command}.`);
}

/** Width / height from a PNG or JPEG header (1 when the header is unreadable). */
function imageAspect(image: Buffer, mimeType: string): number {
  if (mimeType === "image/png" && image.length > 24)
    return (
      Math.round((image.readUInt32BE(16) / image.readUInt32BE(20)) * 1e4) / 1e4
    );
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < image.length) {
      const marker = image.readUInt16BE(offset);
      const length = image.readUInt16BE(offset + 2);
      if (marker >= 0xffc0 && marker <= 0xffc3)
        return (
          Math.round(
            (image.readUInt16BE(offset + 7) / image.readUInt16BE(offset + 5)) *
              1e4,
          ) / 1e4
        );
      offset += 2 + length;
    }
  }
  return 1;
}

try {
  for (const line of await run()) console.log(line);
  process.exit(0);
} catch (error) {
  console.error(
    error instanceof PublishError
      ? error.message
      : `Failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
