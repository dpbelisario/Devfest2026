import { Firestore } from "@google-cloud/firestore";
import { Storage, type Bucket } from "@google-cloud/storage";
import {
  rawMetaCollection,
  type IndoorAtlasArchiveStore,
  type RawVenueMeta,
} from "../services/indoorAtlasArchive.js";

/**
 * Raw IndoorAtlas archive in Cloud Storage (snapshots, images) and Firestore
 * `indoorAtlasRaw` (metadata), with Application Default Credentials.
 * contour-jobs writes (objectAdmin on the bucket, datastore.user); the public
 * `api` service only reads images (objectViewer on the bucket).
 */
export class CloudIndoorAtlasArchiveStore implements IndoorAtlasArchiveStore {
  constructor(
    private readonly bucket: Bucket,
    private readonly db: Firestore,
  ) {}

  static create(options: {
    bucket: string;
    projectId?: string;
    databaseId?: string;
  }): CloudIndoorAtlasArchiveStore {
    return new CloudIndoorAtlasArchiveStore(
      new Storage(
        options.projectId ? { projectId: options.projectId } : {},
      ).bucket(options.bucket),
      new Firestore({
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.databaseId ? { databaseId: options.databaseId } : {}),
        ignoreUndefinedProperties: true,
      }),
    );
  }

  async readMeta(venueId: string): Promise<RawVenueMeta | null> {
    const doc = await this.db.collection(rawMetaCollection).doc(venueId).get();
    return doc.exists ? (doc.data() as RawVenueMeta) : null;
  }

  async writeMeta(venueId: string, meta: RawVenueMeta): Promise<void> {
    await this.db.collection(rawMetaCollection).doc(venueId).set(meta);
  }

  async listMeta(): Promise<RawVenueMeta[]> {
    const snapshot = await this.db
      .collection(rawMetaCollection)
      .limit(200)
      .get();
    return snapshot.docs.map((doc) => doc.data() as RawVenueMeta);
  }

  async putObject(
    path: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.bucket.file(path).save(bytes, { resumable: false, contentType });
  }

  async getObject(path: string): Promise<Buffer | null> {
    try {
      const [bytes] = await this.bucket.file(path).download();
      return bytes;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 404
      )
        return null;
      throw error;
    }
  }

  async deleteObject(path: string): Promise<void> {
    await this.bucket.file(path).delete({ ignoreNotFound: true });
  }

  async listObjects(
    prefix: string,
  ): Promise<{ name: string; updated: string }[]> {
    const [files] = await this.bucket.getFiles({ prefix, maxResults: 200 });
    return files.map((file) => ({
      name: file.name,
      updated: String(file.metadata.updated ?? ""),
    }));
  }
}
