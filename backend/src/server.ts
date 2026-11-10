import { createApp } from "./app.js";
import { config } from "./config.js";
import { createJobsContext } from "./services/jobs/createJobsContext.js";
import { createLiveContext } from "./services/createLiveContext.js";
import { createIndoorVenueService } from "./services/createIndoorVenueService.js";
import { createIndoorAtlasClient } from "./services/indoorAtlasClient.js";
import { FloorPlanImageService } from "./services/floorPlanImageService.js";
import { archiveImageSource } from "./services/indoorAtlasArchive.js";
import { CloudIndoorAtlasArchiveStore } from "./repositories/cloudIndoorAtlasArchiveStore.js";

const jobs = createJobsContext(config);
const live = createLiveContext(config);
const indoorVenues = createIndoorVenueService(config);
// Floor plan image proxy: archived copy first (INDOORATLAS_ARCHIVE_BUCKET),
// else a fresh URL from the Mapping API (needs the key on this service too).
const floorPlanImages = new FloorPlanImageService({
  venues: indoorVenues,
  archive: config.INDOORATLAS_ARCHIVE_BUCKET
    ? archiveImageSource(
        CloudIndoorAtlasArchiveStore.create({
          bucket: config.INDOORATLAS_ARCHIVE_BUCKET,
          projectId: config.GOOGLE_CLOUD_PROJECT,
          databaseId: config.FIRESTORE_DATABASE_ID,
        }),
      )
    : null,
  client: config.INDOORATLAS_MAPPING_API_KEY
    ? createIndoorAtlasClient({ apiKey: config.INDOORATLAS_MAPPING_API_KEY })
    : null,
});
const app = createApp({ jobs, live, indoorVenues, floorPlanImages });
const server = app.listen(config.PORT, config.HOST, () =>
  console.info(
    `Contour API listening on port ${config.PORT}${jobs ? ` (jobs enabled, store=${config.JOBS_STORE})` : ""}${live ? ` (live data: ${config.LIVE_DATA_STORE}, assistant: ${live.assistant ? config.ASSISTANT_MODEL : "off"})` : ""}`,
  ),
);
function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
