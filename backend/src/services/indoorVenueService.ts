import { readFileSync } from "node:fs";
import type { IndoorVenuesRepository } from "../repositories/indoorVenuesRepository.js";
import {
  indoorVenueSchema,
  indoorVenueSeedSchema,
  indoorVenuesResponseSchema,
  type IndoorVenue,
  type IndoorVenuesResponse,
  type PublicIndoorVenue,
} from "../schemas/indoorVenue.js";

/** Bundled fallback venues (`backend/data/indoor-venues.json`), validated at load. */
export function loadSeedVenues(): IndoorVenue[] {
  return indoorVenueSeedSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../data/indoor-venues.json", import.meta.url),
        "utf8",
      ),
    ),
  ).venues;
}

export interface ParsedVenueDocuments {
  venues: IndoorVenue[];
  /** Document IDs that failed validation, with a short reason. */
  rejected: { docId: string; reason: string }[];
}

/**
 * Validate raw documents one by one. Invalid documents, and documents whose ID
 * differs from their `id` field, are rejected instead of failing the list.
 */
export function parseVenueDocuments(
  documents: { docId: string; data: unknown }[],
): ParsedVenueDocuments {
  const result: ParsedVenueDocuments = { venues: [], rejected: [] };
  for (const { docId, data } of documents) {
    const parsed = indoorVenueSchema.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      result.rejected.push({
        docId,
        reason: issue
          ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
          : "invalid",
      });
    } else if (parsed.data.id !== docId)
      result.rejected.push({
        docId,
        reason: `document ID differs from id "${parsed.data.id}"`,
      });
    else result.venues.push(parsed.data);
  }
  return result;
}

/**
 * Combine Firestore and seed venues. A Firestore document overrides the seed
 * venue with the same `id` (including disabling it); seed venues without a
 * document stay available, so today's venue keeps working after a new one is
 * added. Returns every venue, enabled or not, sorted by id.
 */
export function mergeVenues(
  stored: IndoorVenue[],
  seed: IndoorVenue[],
): { venue: IndoorVenue; origin: "firestore" | "seed" }[] {
  const storedIds = new Set(stored.map((venue) => venue.id));
  return [
    ...stored.map((venue) => ({ venue, origin: "firestore" as const })),
    ...seed
      .filter((venue) => !storedIds.has(venue.id))
      .map((venue) => ({ venue, origin: "seed" as const })),
  ].sort((a, b) => a.venue.id.localeCompare(b.venue.id));
}

function toPublic(
  venue: IndoorVenue,
  origin: "firestore" | "seed",
): PublicIndoorVenue {
  const { notes: _notes, enabled: _enabled, ...rest } = venue;
  void _notes;
  void _enabled;
  return { ...rest, origin };
}

export interface IndoorVenueServiceOptions {
  /** Omit for seed-only operation (LIVE_DATA_STORE=off). */
  repository?: IndoorVenuesRepository;
  seed?: IndoorVenue[];
  now?: () => number;
  /** How long a successful read is reused; default 5 minutes. */
  ttlMs?: number;
  /** How long to wait before retrying after a failed read; default 30 seconds. */
  retryMs?: number;
  warn?: (message: string) => void;
}

/**
 * Cached list of enabled IndoorAtlas venues for the public API. One instance
 * per process. Never throws: when the store is unavailable it serves the last
 * good list, or the seed.
 */
export class IndoorVenueService {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly seed: IndoorVenue[];
  private readonly warn: (message: string) => void;
  private cached: { expiresAt: number; value: IndoorVenuesResponse } | null =
    null;
  private loading: Promise<IndoorVenuesResponse> | null = null;

  constructor(private readonly options: IndoorVenueServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.retryMs = options.retryMs ?? 30_000;
    this.seed = options.seed ?? loadSeedVenues();
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Enabled venues, served from cache when fresh. */
  async listEnabledVenues(): Promise<IndoorVenuesResponse> {
    if (this.cached && this.now() < this.cached.expiresAt)
      return this.cached.value;
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private build(
    entries: { venue: IndoorVenue; origin: "firestore" | "seed" }[],
    source: "firestore" | "seed",
  ): IndoorVenuesResponse {
    return indoorVenuesResponseSchema.parse({
      venues: entries
        .filter(({ venue }) => venue.enabled)
        .map(({ venue, origin }) => toPublic(venue, origin)),
      source,
      checkedAt: new Date(this.now()).toISOString(),
    });
  }

  private async load(): Promise<IndoorVenuesResponse> {
    const seedOnly = mergeVenues([], this.seed);
    if (!this.options.repository) {
      const value = this.build(seedOnly, "seed");
      this.cached = { expiresAt: this.now() + this.ttlMs, value };
      return value;
    }
    try {
      const documents = await this.options.repository.listVenueDocuments();
      const { venues, rejected } = parseVenueDocuments(documents);
      for (const { docId, reason } of rejected)
        this.warn(`Skipping invalid indoorVenues/${docId}: ${reason}`);
      const value =
        venues.length > 0
          ? this.build(mergeVenues(venues, this.seed), "firestore")
          : this.build(seedOnly, "seed");
      this.cached = { expiresAt: this.now() + this.ttlMs, value };
      return value;
    } catch (error) {
      this.warn(
        `indoorVenues unavailable, serving ${this.cached ? "the last good list" : "the seed"}: ${error instanceof Error ? error.message : String(error)}`,
      );
      const value = this.cached?.value ?? this.build(seedOnly, "seed");
      this.cached = { expiresAt: this.now() + this.retryMs, value };
      return value;
    }
  }
}
