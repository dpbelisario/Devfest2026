import type { AppConfig } from "../../config.js";
import { FirestoreIndoorVenuesRepository } from "../../repositories/firestoreIndoorVenuesRepository.js";
import { MemoryIndoorVenuesRepository } from "../../repositories/indoorVenuesRepository.js";
import { FirestoreJobsRepository } from "../../repositories/firestoreJobsRepository.js";
import { MemoryJobsRepository } from "../../repositories/memoryJobsRepository.js";
import { defaultRunId, type JobsContext } from "./context.js";
import { createFcmSender } from "./fcmSender.js";
import { fetchTextWithTimeout } from "./http.js";
import { createIndoorAtlasClient } from "../indoorAtlasClient.js";
import { CloudIndoorAtlasArchiveStore } from "../../repositories/cloudIndoorAtlasArchiveStore.js";

/**
 * Build job dependencies from configuration, or undefined when JOBS_ENABLED
 * is not true (the `/jobs` routes are then not mounted and answer 404).
 * FCM_DELIVERY_ENABLED=true adds the Firebase Cloud Messaging sender;
 * INDOORATLAS_MAPPING_API_KEY enables the IndoorAtlas venue sync and
 * INDOORATLAS_ARCHIVE_BUCKET its raw archive (Firestore store only).
 */
export function createJobsContext(config: AppConfig): JobsContext | undefined {
  if (!config.JOBS_ENABLED) return undefined;
  if (config.JOBS_STORE === "memory")
    console.warn(
      "JOBS_STORE=memory: job state is process-local and lost on restart.",
    );
  const repository =
    config.JOBS_STORE === "memory"
      ? new MemoryJobsRepository()
      : FirestoreJobsRepository.create({
          projectId: config.GOOGLE_CLOUD_PROJECT,
          databaseId: config.FIRESTORE_DATABASE_ID,
        });
  return {
    repository,
    fetchText: fetchTextWithTimeout,
    now: () => new Date(),
    newRunId: () => defaultRunId(),
    delivery: {
      topic: config.FCM_TOPIC,
      sender: config.FCM_DELIVERY_ENABLED
        ? createFcmSender({ projectId: config.GOOGLE_CLOUD_PROJECT })
        : null,
    },
    indoorAtlas: {
      client: config.INDOORATLAS_MAPPING_API_KEY
        ? createIndoorAtlasClient({
            apiKey: config.INDOORATLAS_MAPPING_API_KEY,
          })
        : null,
      venues:
        config.JOBS_STORE === "memory"
          ? new MemoryIndoorVenuesRepository()
          : FirestoreIndoorVenuesRepository.create({
              projectId: config.GOOGLE_CLOUD_PROJECT,
              databaseId: config.FIRESTORE_DATABASE_ID,
            }),
      archive:
        config.INDOORATLAS_ARCHIVE_BUCKET && config.JOBS_STORE !== "memory"
          ? CloudIndoorAtlasArchiveStore.create({
              bucket: config.INDOORATLAS_ARCHIVE_BUCKET,
              projectId: config.GOOGLE_CLOUD_PROJECT,
              databaseId: config.FIRESTORE_DATABASE_ID,
            })
          : null,
    },
  };
}
