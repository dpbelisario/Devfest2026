import { z } from "zod";

const booleanFlag = z
  .enum(["true", "false", ""])
  .default("false")
  .transform((value) => value === "true");

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  /** Mounts the private `/jobs` ingestion routes. Leave unset on the public service. */
  JOBS_ENABLED: booleanFlag,
  /** `firestore` in Cloud Run; `memory` only for local smoke runs (state is lost on exit). */
  JOBS_STORE: z.enum(["firestore", "memory"]).default("firestore"),
  /** Optional; Application Default Credentials usually supply the project. */
  GOOGLE_CLOUD_PROJECT: optionalText,
  /** Optional named Firestore database; defaults to `(default)`. */
  FIRESTORE_DATABASE_ID: optionalText,
  /**
   * Where `/api/sites` and `/api/alerts` read job outputs: `firestore`
   * (Cloud Run), `memory` (empty; local smoke runs) or `off` (not mounted).
   */
  LIVE_DATA_STORE: z.enum(["firestore", "memory", "off"]).default("firestore"),
  /** Gemini assistant at POST /api/assistant (Vertex AI, ADC). */
  ASSISTANT_ENABLED: z
    .enum(["true", "false", ""])
    .default("true")
    .transform((value) => value !== "false"),
  ASSISTANT_MODEL: z.string().trim().min(1).default("gemini-3.5-flash-lite"),
  /** Vertex AI location for Gemini; `global` serves the most models. */
  GOOGLE_CLOUD_LOCATION: z.string().trim().min(1).default("global"),
  /** Assistant requests allowed per client IP per minute, per instance. */
  ASSISTANT_PER_CLIENT_PER_MINUTE: z.coerce.number().int().min(1).default(8),
  /** Assistant requests allowed per minute in total, per instance. */
  ASSISTANT_TOTAL_PER_MINUTE: z.coerce.number().int().min(1).default(60),
});

export type AppConfig = z.infer<typeof environmentSchema>;

/** Parse and validate environment variables; throws a ZodError on invalid values. */
export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  return environmentSchema.parse(environment);
}

export const config = parseConfig(process.env);
