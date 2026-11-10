import { z } from "zod";

/**
 * Response shapes of the IndoorAtlas Mapping REST API
 * (`https://mapping-api.indooratlas.com/public/v1`, OpenAPI 0.5.0) used by
 * the venue sync. Only the fields the sync reads are declared; unknown fields
 * are ignored (`z.object` strips them) because IndoorAtlas may add more.
 * Lists are parsed item by item so one malformed item is skipped, not fatal.
 */

const uuid = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const iaLatLonSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/** One item of `GET /venues`. */
export const iaVenueSchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullish(),
  address: z.string().nullish(),
  coordinates: iaLatLonSchema,
});
export type IaVenue = z.infer<typeof iaVenueSchema>;

/** One item of `GET /venues/{venueId}/floorplans`. Image URLs expire and are never stored. */
export const iaFloorPlanSchema = z.object({
  id: uuid,
  venueId: uuid.nullish(),
  name: z.string().nullish(),
  floorNumber: z.number().int(),
  image: z
    .object({
      /** Expires; read only by the image proxy, never stored. */
      url: z.string().nullish(),
      width: z.number().nullish(),
      height: z.number().nullish(),
      bearing: z.number().nullish(),
      widthMeters: z.number().nullish(),
      heightMeters: z.number().nullish(),
      center: iaLatLonSchema.nullish(),
      topLeft: iaLatLonSchema.nullish(),
      topRight: iaLatLonSchema.nullish(),
      bottomLeft: iaLatLonSchema.nullish(),
      bottomRight: iaLatLonSchema.nullish(),
    })
    .nullish(),
});
export type IaFloorPlan = z.infer<typeof iaFloorPlanSchema>;

/** A GeoJSON FeatureCollection envelope; features are validated one by one. */
export const iaFeatureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.unknown()),
});

/**
 * A point of interest from `GET /venues/{venueId}/geofences/geojson`.
 * Polygon features are geofences, see {@link iaPolygonFeatureSchema}.
 */
export const iaPoiFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: uuid,
  properties: z.object({
    floor: z.number().int(),
    name: z.string().nullish(),
    description: z.string().nullish(),
  }),
  geometry: z.object({
    type: z.literal("Point"),
    coordinates: z.tuple([
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
    ]),
  }),
});
export type IaPoiFeature = z.infer<typeof iaPoiFeatureSchema>;

/**
 * A geofence polygon from `GET /venues/{venueId}/geofences/geojson`. Only the
 * outer ring is used; coordinates are `[lon, lat]`.
 */
export const iaPolygonFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: uuid,
  properties: z.object({
    floor: z.number().int(),
    name: z.string().nullish(),
    description: z.string().nullish(),
  }),
  geometry: z.object({
    type: z.literal("Polygon"),
    coordinates: z
      .array(
        z
          .array(
            z
              .array(z.number())
              .min(2)
              .max(3)
              .refine(
                ([lon, lat]) =>
                  lon !== undefined &&
                  lat !== undefined &&
                  Math.abs(lon) <= 180 &&
                  Math.abs(lat) <= 90,
              ),
          )
          .min(4)
          .max(10_000),
      )
      .min(1),
  }),
});
export type IaPolygonFeature = z.infer<typeof iaPolygonFeatureSchema>;

/** A wayfinding graph edge from `GET /venues/{venueId}/wayfinding/geojson`. */
export const iaWayfindingEdgeSchema = z.object({
  type: z.literal("Feature"),
  geometry: z.object({
    type: z.literal("LineString"),
    coordinates: z.array(z.array(z.number()).min(2).max(3)).length(2),
  }),
});

/** Result of `POST /jobs/indooratlas/sync`. Counts refer to venues written or kept this run. */
export const indoorAtlasSyncSummarySchema = z
  .object({
    /** False when INDOORATLAS_MAPPING_API_KEY is not set; nothing was fetched or written. */
    configured: z.boolean(),
    /** IndoorAtlas venues mapped successfully this run. */
    venues: z.number().int().min(0),
    floors: z.number().int().min(0),
    pois: z.number().int().min(0),
    exits: z.number().int().min(0),
    /** Geofence polygons kept as display-only `areas`. */
    areas: z.number().int().min(0),
    /** Raw snapshots written to the archive this run (content changed). */
    archived: z.number().int().min(0),
    /** Documents written because their content changed (or are new). */
    updated: z.number().int().min(0),
    /** Synced documents disabled because the venue no longer exists in IndoorAtlas. */
    disabled: z.number().int().min(0),
    /** Venues not written: fetch failed, invalid, or a manual document already covers them. */
    skipped: z.number().int().min(0),
  })
  .strict();
export type IndoorAtlasSyncSummary = z.infer<
  typeof indoorAtlasSyncSummarySchema
>;
