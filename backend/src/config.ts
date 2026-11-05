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
});

export type AppConfig = z.infer<typeof environmentSchema>;

/** Parse and validate environment variables; throws a ZodError on invalid values. */
export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  return environmentSchema.parse(environment);
}

export const config = parseConfig(process.env);
