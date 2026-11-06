import { createApp } from "./app.js";
import { config } from "./config.js";
import { createJobsContext } from "./services/jobs/createJobsContext.js";
import { createLiveContext } from "./services/createLiveContext.js";

const jobs = createJobsContext(config);
const live = createLiveContext(config);
const app = createApp({ jobs, live });
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
