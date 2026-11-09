import { Firestore, Timestamp } from "@google-cloud/firestore";
import type { IndoorVenue } from "../schemas/indoorVenue.js";
import {
  indoorVenuesCollection,
  type IndoorVenuesRepository,
  type StoredVenueDocument,
} from "./indoorVenuesRepository.js";

/**
 * Firestore implementation (Application Default Credentials). The public API
 * only reads (roles/datastore.viewer); the admin script writes
 * (roles/datastore.user).
 */
export class FirestoreIndoorVenuesRepository implements IndoorVenuesRepository {
  constructor(private readonly db: Firestore) {}

  static create(options: {
    projectId?: string;
    databaseId?: string;
  }): FirestoreIndoorVenuesRepository {
    return new FirestoreIndoorVenuesRepository(
      new Firestore({
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.databaseId ? { databaseId: options.databaseId } : {}),
        ignoreUndefinedProperties: true,
      }),
    );
  }

  async listVenueDocuments(): Promise<StoredVenueDocument[]> {
    const snapshot = await this.db
      .collection(indoorVenuesCollection)
      .limit(200)
      .get();
    return snapshot.docs.map((doc) => ({
      docId: doc.id,
      data: normalizeTimestamps(doc.data()),
    }));
  }

  async saveVenue(venue: IndoorVenue): Promise<void> {
    await this.db.collection(indoorVenuesCollection).doc(venue.id).set(venue);
  }
}

/** Console edits may store `updatedAt` as a Timestamp; compare as ISO text. */
function normalizeTimestamps(data: Record<string, unknown>) {
  const value = data.updatedAt;
  return value instanceof Timestamp
    ? { ...data, updatedAt: value.toDate().toISOString() }
    : data;
}
