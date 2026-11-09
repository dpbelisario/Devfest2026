import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import {
  emptyRequestSchema,
  eqvolCheckResponseSchema,
  eqvolProcessRequestSchema,
  eqvolProcessResponseSchema,
  feedModeRequestSchema,
  nagoyaCompareResponseSchema,
  nagoyaFetchResponseSchema,
  nagoyaPublishResponseSchema,
  nagoyaRecordUnchangedResponseSchema,
  outboxDeliverResponseSchema,
  runRequestSchema,
  weatherCheckResponseSchema,
  weatherProcessRequestSchema,
  weatherProcessResponseSchema,
} from "../schemas/jobs.js";
import { indoorAtlasSyncSummarySchema } from "../schemas/indoorAtlas.js";
import { syncIndoorAtlasVenues } from "../services/indoorAtlasSync.js";
import type { JobsContext } from "../services/jobs/context.js";
import { JobError } from "../services/jobs/errors.js";
import { checkEqvol, processEqvol } from "../services/jobs/jmaEqvol.js";
import { checkWeather, processWeather } from "../services/jobs/jmaWeather.js";
import {
  compareNagoyaDataset,
  fetchNagoyaDataset,
  publishNagoyaDataset,
  recordNagoyaUnchanged,
} from "../services/jobs/nagoyaDataset.js";
import { deliverOutbox } from "../services/jobs/outbox.js";

/**
 * Wrap a job: validate the body, run the service, validate the response.
 * JobErrors map to `{ error: code }`; anything else is logged and returns
 * INTERNAL_ERROR so internal details never leave the service.
 */
function job<I extends z.ZodType, O extends z.ZodType>(
  name: string,
  input: I,
  output: O,
  run: (body: z.output<I>) => Promise<z.input<O>>,
) {
  return async (req: Request, res: Response) => {
    const parsed = input.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_REQUEST" });
      return;
    }
    try {
      res.json(output.parse(await run(parsed.data)));
    } catch (error) {
      if (error instanceof JobError) {
        console.warn(`Job ${name} failed: ${error.code}`, error.message);
        res.status(error.status).json({ error: error.code });
        return;
      }
      console.error(`Job ${name} failed unexpectedly`, error);
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  };
}

/** Private ingestion routes. Mount only on the IAM-protected jobs service. */
export function createJobsRouter(context: JobsContext): Router {
  const router = Router();
  router.post(
    "/nagoya/fetch",
    job("nagoya/fetch", emptyRequestSchema, nagoyaFetchResponseSchema, () =>
      fetchNagoyaDataset(context),
    ),
  );
  router.post(
    "/nagoya/compare",
    job(
      "nagoya/compare",
      runRequestSchema,
      nagoyaCompareResponseSchema,
      ({ runId }) => compareNagoyaDataset(context, runId),
    ),
  );
  router.post(
    "/nagoya/publish",
    job(
      "nagoya/publish",
      runRequestSchema,
      nagoyaPublishResponseSchema,
      ({ runId }) => publishNagoyaDataset(context, runId),
    ),
  );
  router.post(
    "/nagoya/record-unchanged",
    job(
      "nagoya/record-unchanged",
      runRequestSchema,
      nagoyaRecordUnchangedResponseSchema,
      ({ runId }) => recordNagoyaUnchanged(context, runId),
    ),
  );
  router.post(
    "/jma/weather/check",
    job(
      "jma/weather/check",
      feedModeRequestSchema,
      weatherCheckResponseSchema,
      ({ mode }) => checkWeather(context, mode),
    ),
  );
  router.post(
    "/jma/weather/process",
    job(
      "jma/weather/process",
      weatherProcessRequestSchema,
      weatherProcessResponseSchema,
      ({ candidate }) => processWeather(context, candidate),
    ),
  );
  router.post(
    "/jma/eqvol/check",
    job(
      "jma/eqvol/check",
      feedModeRequestSchema,
      eqvolCheckResponseSchema,
      ({ mode }) => checkEqvol(context, mode),
    ),
  );
  router.post(
    "/jma/eqvol/process",
    job(
      "jma/eqvol/process",
      eqvolProcessRequestSchema,
      eqvolProcessResponseSchema,
      ({ candidate }) => processEqvol(context, candidate),
    ),
  );
  router.post(
    "/outbox/deliver",
    job("outbox/deliver", emptyRequestSchema, outboxDeliverResponseSchema, () =>
      deliverOutbox(context),
    ),
  );
  router.post(
    "/indooratlas/sync",
    job(
      "indooratlas/sync",
      emptyRequestSchema,
      indoorAtlasSyncSummarySchema,
      () =>
        syncIndoorAtlasVenues({
          client: context.indoorAtlas?.client ?? null,
          repository: context.indoorAtlas?.venues ?? null,
          now: context.now,
        }),
    ),
  );
  return router;
}
