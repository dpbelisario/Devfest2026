import type { IndoorVenue } from "../schemas/indoorVenue.js";

/** Firestore collection holding one document per venue (document ID = venue `id`). */
export const indoorVenuesCollection = "indoorVenues";

/** A raw stored document; `data` is unvalidated until the service parses it. */
export interface StoredVenueDocument {
  docId: string;
  data: unknown;
}

/**
 * Storage boundary for runtime IndoorAtlas venues. Reads return raw documents
 * so one invalid document can be skipped without failing the whole list.
 */
export interface IndoorVenuesRepository {
  /** Every document in the collection; throws when the store is unreachable. */
  listVenueDocuments(): Promise<StoredVenueDocument[]>;
  /** Replace the document `venue.id` with an already validated venue. */
  saveVenue(venue: IndoorVenue): Promise<void>;
}

/** In-memory store for tests and local smoke runs (state is lost on exit). */
export class MemoryIndoorVenuesRepository implements IndoorVenuesRepository {
  readonly documents = new Map<string, unknown>();
  /** Set to make reads fail, as an unreachable Firestore would. */
  failReads = false;
  reads = 0;

  async listVenueDocuments(): Promise<StoredVenueDocument[]> {
    this.reads++;
    if (this.failReads) throw new Error("Simulated store outage");
    return [...this.documents].map(([docId, data]) => ({
      docId,
      data: structuredClone(data),
    }));
  }

  async saveVenue(venue: IndoorVenue): Promise<void> {
    this.documents.set(venue.id, structuredClone(venue));
  }
}
