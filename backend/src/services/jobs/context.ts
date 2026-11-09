import { randomBytes } from "node:crypto";
import type { IndoorVenuesRepository } from "../../repositories/indoorVenuesRepository.js";
import type { JobsRepository } from "../../repositories/jobsRepository.js";
import type { IndoorAtlasClient } from "../indoorAtlasClient.js";
import type { FetchText } from "./http.js";
import type { WarningSender } from "./warningPush.js";

/**
 * Warning push settings. `sender` is null when FCM_DELIVERY_ENABLED is false;
 * `/jobs/outbox/deliver` then only counts the pending backlog.
 */
export interface WarningDelivery {
  topic: string;
  sender: WarningSender | null;
}

/** Dependencies shared by all job services; injected so tests need no network. */
export interface JobsContext {
  repository: JobsRepository;
  fetchText: FetchText;
  now: () => Date;
  newRunId: () => string;
  delivery: WarningDelivery;
  /**
   * IndoorAtlas venue sync (`/jobs/indooratlas/sync`). `client` is null when
   * INDOORATLAS_MAPPING_API_KEY is unset; omitted entirely, the sync also
   * reports `configured: false`.
   */
  indoorAtlas?: {
    client: IndoorAtlasClient | null;
    venues: IndoorVenuesRepository;
  };
}

/** Sortable, Firestore-safe run identifier, e.g. `20261105T061200Z-1a2b3c4d`. */
export function defaultRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}
