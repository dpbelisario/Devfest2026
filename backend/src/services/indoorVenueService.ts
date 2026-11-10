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

/** A venue with where it came from. */
export interface MergedVenue {
  venue: IndoorVenue;
  origin: "firestore" | "seed";
}

/** Listing group: IndoorAtlas-synced documents, manual documents, then seed. */
function group({ venue, origin }: MergedVenue): number {
  if (origin === "seed") return 2;
  return venue.syncedFrom === "indooratlas" ? 0 : 1;
}

/**
 * Combine Firestore and seed venues. A Firestore document overrides the seed
 * venue with the same `id` (including disabling it); seed venues without a
 * document stay available. Returns every venue, enabled or not, in listing
 * order: IndoorAtlas-synced documents first (by `syncOrder`, then name), then
 * manual Firestore documents (by id), then seed venues (in seed file order).
 */
export function mergeVenues(
  stored: IndoorVenue[],
  seed: IndoorVenue[],
): MergedVenue[] {
  const storedIds = new Set(stored.map((venue) => venue.id));
  const seedOrder = new Map(seed.map((venue, index) => [venue.id, index]));
  return [
    ...stored.map((venue) => ({ venue, origin: "firestore" as const })),
    ...seed
      .filter((venue) => !storedIds.has(venue.id))
      .map((venue) => ({ venue, origin: "seed" as const })),
  ].sort(
    (a, b) =>
      group(a) - group(b) ||
      (a.venue.syncOrder ?? 0) - (b.venue.syncOrder ?? 0) ||
      (group(a) === 0 ? a.venue.name.en.localeCompare(b.venue.name.en) : 0) ||
      (group(a) === 2
        ? (seedOrder.get(a.venue.id) ?? 0) - (seedOrder.get(b.venue.id) ?? 0)
        : 0) ||
      a.venue.id.localeCompare(b.venue.id),
  );
}

/**
 * Enabled venues as the public list shows them, numbered continuously:
 * synced venues are 01, 02…, followed by manual and seed venues. A Firestore
 * document with a seed venue's id can still disable it.
 */
export function visibleVenues(merged: MergedVenue[]): MergedVenue[] {
  return merged.filter(({ venue }) => venue.enabled);
}

function toPublic(
  { venue, origin }: MergedVenue,
  index: number,
): PublicIndoorVenue {
  const {
    notes: _notes,
    enabled: _enabled,
    syncOrder: _syncOrder,
    ...rest
  } = venue;
  void _notes;
  void _enabled;
  void _syncOrder;
  return { ...rest, origin, rank: index + 1, primary: index === 0 };
}

/**
 * Server cache of the venue list. Chosen over a Firestore "version" document:
 * one collection read (at most 200 small documents) per minute per instance is
 * cheap, needs no extra write path in the sync and cannot get out of step.
 */
export const defaultVenueCacheMs = 60_000;

export interface IndoorVenueServiceOptions {
  /** Omit for seed-only operation (LIVE_DATA_STORE=off). */
  repository?: IndoorVenuesRepository;
  seed?: IndoorVenue[];
  now?: () => number;
  /**
   * How long a successful read is reused; default {@link defaultVenueCacheMs}
   * (60 s), so an IndoorAtlas sync reaches the API within about a minute.
   */
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
    this.ttlMs = options.ttlMs ?? defaultVenueCacheMs;
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
    entries: MergedVenue[],
    source: "firestore" | "seed",
  ): IndoorVenuesResponse {
    return indoorVenuesResponseSchema.parse({
      venues: visibleVenues(entries).map(toPublic),
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
