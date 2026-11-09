import type { AppConfig } from "../../config.js";
import { FirestoreJobsRepository } from "../../repositories/firestoreJobsRepository.js";
import { MemoryJobsRepository } from "../../repositories/memoryJobsRepository.js";
import { defaultRunId, type JobsContext } from "./context.js";
import { createFcmSender } from "./fcmSender.js";
import { fetchTextWithTimeout } from "./http.js";

/**
 * Build job dependencies from configuration, or undefined when JOBS_ENABLED
 * is not true (the `/jobs` routes are then not mounted and answer 404).
 * FCM_DELIVERY_ENABLED=true adds the Firebase Cloud Messaging sender.
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
  };
}
