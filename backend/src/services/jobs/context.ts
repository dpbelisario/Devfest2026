import { randomBytes } from "node:crypto";
import type { JobsRepository } from "../../repositories/jobsRepository.js";
import type { FetchText } from "./http.js";

/** Dependencies shared by all job services; injected so tests need no network. */
export interface JobsContext {
  repository: JobsRepository;
  fetchText: FetchText;
  now: () => Date;
  newRunId: () => string;
}

/** Sortable, Firestore-safe run identifier, e.g. `20261105T061200Z-1a2b3c4d`. */
export function defaultRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}
