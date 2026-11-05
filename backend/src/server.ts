import { createApp } from "./app.js";
import { config } from "./config.js";
import { createJobsContext } from "./services/jobs/createJobsContext.js";

const jobs = createJobsContext(config);
const app = createApp({ jobs });
const server = app.listen(config.PORT, config.HOST, () =>
  console.info(
    `Contour API listening on port ${config.PORT}${jobs ? ` (jobs enabled, store=${config.JOBS_STORE})` : ""}`,
  ),
);
function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
