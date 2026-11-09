/**
 * Admin CLI for runtime IndoorAtlas venues (Firestore `indoorVenues`), see
 * docs/indoor-venues.md. Uses Application Default Credentials, e.g. Cloud Shell
 * or `gcloud auth application-default login`; writes need roles/datastore.user.
 *
 *   npm run indoor-venues --workspace backend -- list
 *   npm run indoor-venues --workspace backend -- upsert path/to/venue.json
 *   npm run indoor-venues --workspace backend -- enable|disable <id>
 *   INDOORATLAS_MAPPING_API_KEY=… npm run indoor-venues --workspace backend -- sync
 *
 * GOOGLE_CLOUD_PROJECT and FIRESTORE_DATABASE_ID are honoured when set.
 * `sync` reads the IndoorAtlas Mapping API key from the environment only.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIndoorAtlasClient } from "../src/services/indoorAtlasClient.js";
import { FirestoreIndoorVenuesRepository } from "../src/repositories/firestoreIndoorVenuesRepository.js";
import {
  AdminInputError,
  runIndoorVenuesCommand,
} from "../src/services/indoorVenueAdmin.js";
import { loadSeedVenues } from "../src/services/indoorVenueService.js";

const optional = (value: string | undefined) => value?.trim() || undefined;
// npm runs workspace scripts from backend/; resolve files against the caller's directory.
const callerDirectory = process.env.INIT_CWD ?? process.cwd();

const mappingApiKey = optional(process.env.INDOORATLAS_MAPPING_API_KEY);

try {
  const lines = await runIndoorVenuesCommand(process.argv.slice(2), {
    repository: FirestoreIndoorVenuesRepository.create({
      projectId: optional(process.env.GOOGLE_CLOUD_PROJECT),
      databaseId: optional(process.env.FIRESTORE_DATABASE_ID),
    }),
    seed: loadSeedVenues(),
    indoorAtlasClient: mappingApiKey
      ? createIndoorAtlasClient({ apiKey: mappingApiKey })
      : null,
    log: (message) => console.warn(message),
    readJson: async (path) => {
      const text = await readFile(resolve(callerDirectory, path), "utf8");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AdminInputError(`${path} is not valid JSON.`);
      }
    },
  });
  for (const line of lines) console.log(line);
  process.exit(0);
} catch (error) {
  console.error(
    error instanceof AdminInputError
      ? error.message
      : `Failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
