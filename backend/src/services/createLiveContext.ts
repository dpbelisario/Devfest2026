import type { AppConfig } from "../config.js";
import { FirestoreJobsRepository } from "../repositories/firestoreJobsRepository.js";
import { MemoryJobsRepository } from "../repositories/memoryJobsRepository.js";
import type { LiveContext } from "../routes/live.js";
import { AssistantService } from "./assistantService.js";
import { createGeminiGenerate } from "./geminiClient.js";
import { LiveDataService } from "./liveDataService.js";
import { RateLimiter } from "./rateLimiter.js";

/**
 * Build the public `/api` dependencies, or undefined when LIVE_DATA_STORE=off.
 * Reads only; the service account needs Firestore read access
 * (roles/datastore.viewer or broader) and roles/aiplatform.user for Gemini.
 */
export function createLiveContext(config: AppConfig): LiveContext | undefined {
  if (config.LIVE_DATA_STORE === "off") return undefined;
  const repository =
    config.LIVE_DATA_STORE === "memory"
      ? new MemoryJobsRepository()
      : FirestoreJobsRepository.create({
          projectId: config.GOOGLE_CLOUD_PROJECT,
          databaseId: config.FIRESTORE_DATABASE_ID,
        });
  const live = new LiveDataService({ repository });
  // Vertex AI needs an explicit project; without one the assistant stays off
  // (POST /api/assistant answers 503) instead of failing server startup.
  if (config.ASSISTANT_ENABLED && !config.GOOGLE_CLOUD_PROJECT)
    console.warn("Assistant disabled: set GOOGLE_CLOUD_PROJECT to enable it.");
  const assistant =
    config.ASSISTANT_ENABLED && config.GOOGLE_CLOUD_PROJECT
      ? new AssistantService({
          live,
          model: config.ASSISTANT_MODEL,
          generate: createGeminiGenerate({
            project: config.GOOGLE_CLOUD_PROJECT,
            location: config.GOOGLE_CLOUD_LOCATION,
            model: config.ASSISTANT_MODEL,
          }),
        })
      : undefined;
  return {
    live,
    assistant,
    assistantLimiter: new RateLimiter({
      windowMs: 60_000,
      perKeyLimit: config.ASSISTANT_PER_CLIENT_PER_MINUTE,
      totalLimit: config.ASSISTANT_TOTAL_PER_MINUTE,
    }),
  };
}
