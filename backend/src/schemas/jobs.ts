import { z } from "zod";
import { eqvolBulletinTypes, eqvolTypeOf } from "../services/jobs/jmaEqvol.js";
import { weatherSourcePattern } from "../services/jobs/jmaWeather.js";

/**
 * Request/response contracts for the private `/jobs` API called by Google
 * Cloud Workflows. All bodies are JSON; responses are deliberately small.
 */

const isoTimestamp = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
const title = z.string().max(500);
const runId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid runId");

export const emptyRequestSchema = z.object({});
export const runRequestSchema = z.object({ runId });
export const feedModeRequestSchema = z.object({
  mode: z.enum(["recent", "recovery"]),
});

export const nagoyaFetchResponseSchema = z.object({
  runId,
  valid: z.boolean(),
  recordCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  errors: z.array(z.string().max(500)).max(20),
});
export const nagoyaCompareResponseSchema = z.object({
  runId,
  changed: z.boolean(),
  status: z.enum(["changed", "unchanged"]),
});
export const nagoyaPublishResponseSchema = z.object({
  datasetVersion: z.string(),
  recordCount: z.number().int().nonnegative(),
  lastChangedAt: isoTimestamp,
});
export const nagoyaRecordUnchangedResponseSchema = z.object({
  lastCheckedAt: isoTimestamp,
});

/** Only official Aichi VPWW53 URLs are accepted (prevents arbitrary fetches). */
export const weatherCandidateSchema = z.object({
  sourceUrl: z.string().max(300).regex(weatherSourcePattern),
  publishedAt: isoTimestamp,
  title,
});
export const weatherCheckResponseSchema = z.object({
  candidate: weatherCandidateSchema.nullable(),
});
export const weatherProcessRequestSchema = z.object({
  candidate: weatherCandidateSchema,
});
export const weatherProcessResponseSchema = z.object({
  stored: z.boolean(),
  /** null when the candidate was already processed or superseded. */
  infoType: z.string().nullable(),
  invalidated: z.boolean(),
  municipalityCount: z.number().int().nonnegative(),
  nagoyaKinds: z
    .array(z.object({ code: z.string(), name: z.string(), status: z.string() }))
    .max(50),
  queued: z.boolean(),
});

const bulletinType = z.enum(eqvolBulletinTypes);
/** Only official VXSE53/VTSE41/VFVO50 URLs whose type matches `bulletinType`. */
export const eqvolCandidateSchema = z
  .object({
    sourceUrl: z.string().max(300),
    publishedAt: isoTimestamp,
    bulletinType,
    title,
  })
  .refine(
    (candidate) => eqvolTypeOf(candidate.sourceUrl) === candidate.bulletinType,
    { message: "Unsupported source URL", path: ["sourceUrl"] },
  );
export const eqvolCheckResponseSchema = z.object({
  candidates: z.array(eqvolCandidateSchema).max(9),
});
export const eqvolProcessRequestSchema = z.object({
  candidate: eqvolCandidateSchema,
});
export const eqvolProcessResponseSchema = z.object({
  stored: z.boolean(),
  bulletinType,
  ignored: z.boolean(),
  invalidated: z.boolean(),
  aichiMentioned: z.boolean().nullable(),
  queued: z.boolean(),
});

const count = z.number().int().nonnegative();
/** Small summary only; message contents and keys stay in Firestore/logs. */
export const outboxDeliverResponseSchema = z.object({
  deliveryEnabled: z.boolean(),
  pending: count,
  attempted: count.max(3),
  sent: count.max(3),
  skipped: count,
  failed: count.max(3),
});
