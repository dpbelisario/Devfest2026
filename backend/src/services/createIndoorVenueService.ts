import type { AppConfig } from "../config.js";
import { FirestoreIndoorVenuesRepository } from "../repositories/firestoreIndoorVenuesRepository.js";
import { MemoryIndoorVenuesRepository } from "../repositories/indoorVenuesRepository.js";
import { IndoorVenueService } from "./indoorVenueService.js";

/**
 * Venue list for `GET /api/indoor/venues`, following LIVE_DATA_STORE:
 * `firestore` reads the `indoorVenues` collection (falling back to the seed),
 * `memory` starts empty (seed only, local runs), `off` serves the seed only.
 */
export function createIndoorVenueService(
  config: Pick<
    AppConfig,
    "LIVE_DATA_STORE" | "GOOGLE_CLOUD_PROJECT" | "FIRESTORE_DATABASE_ID"
  >,
): IndoorVenueService {
  if (config.LIVE_DATA_STORE === "off") return new IndoorVenueService();
  return new IndoorVenueService({
    repository:
      config.LIVE_DATA_STORE === "memory"
        ? new MemoryIndoorVenuesRepository()
        : FirestoreIndoorVenuesRepository.create({
            projectId: config.GOOGLE_CLOUD_PROJECT,
            databaseId: config.FIRESTORE_DATABASE_ID,
          }),
  });
}
