import { z } from "zod";

/**
 * Runtime IndoorAtlas venue configuration. One Firestore document per venue in
 * `indoorVenues` (document ID = `id`), plus the seed in
 * `backend/data/indoor-venues.json`. Validated on every read and write so a bad
 * console edit cannot reach the app.
 *
 * Exits carry their provenance: only `source: "verified"` exits were checked on
 * site. `event-map`, `estimate` and `indooratlas` exits must never be presented
 * as verified evacuation routes.
 *
 * Venues written by the IndoorAtlas sync job (`services/indoorAtlasSync.ts`)
 * carry `syncedFrom: "indooratlas"`, use the document ID `ia-<venue UUID>` and
 * are only ever changed by that job (or enabled/disabled by the admin script).
 */

/** Venue/POI/exit IDs: lowercase slug, also usable as a Firestore document ID. */
export const venueSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    "Use lowercase letters, digits and hyphens (max 64 characters)",
  );

/** IndoorAtlas IDs (venue, floor plan, POI) are UUIDs; the template's all-zero IDs are rejected. */
const indoorAtlasIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: "Expected an IndoorAtlas UUID",
  })
  .refine((id) => !/^0{8}-0{4}-0{4}-0{4}-/.test(id), {
    message: "Placeholder ID from the template: copy the real ID",
  });

export const localizedNameSchema = z
  .object({
    en: z.string().trim().min(1).max(120),
    ja: z.string().trim().min(1).max(120),
  })
  .strict();

const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);
const notNullIsland = (point: { lat?: number; lng?: number }) =>
  !(point.lat === 0 && point.lng === 0);
const nullIslandMessage = {
  message: "Placeholder coordinates 0,0 from the template",
};
/** Logical floor level as configured in IndoorAtlas (1 = ground floor, -1 = B1). */
const floorLevelSchema = z.number().int().min(-5).max(60);

const pointSchema = z
  .object({ lat: latitudeSchema, lng: longitudeSchema })
  .strict()
  .refine(notNullIsland, nullIslandMessage);

/**
 * Where an IndoorAtlas floor plan image lies on the map (from the Mapping API
 * floor plan `image` object). The image URL itself expires and is never
 * stored: the app loads `GET /api/indoor/floorplans/{floorPlanId}/image`.
 * The corners place the image exactly (any rotation); `bearing` is degrees
 * clockwise from north, informational.
 */
export const indoorFloorPlanPlacementSchema = z
  .object({
    topLeft: pointSchema,
    topRight: pointSchema,
    bottomLeft: pointSchema,
    bottomRight: pointSchema,
    center: pointSchema.optional(),
    bearing: z.number().min(-360).max(360).optional(),
    widthPx: z.number().int().positive().max(100_000).optional(),
    heightPx: z.number().int().positive().max(100_000).optional(),
    widthM: z.number().positive().max(10_000).optional(),
    heightM: z.number().positive().max(10_000).optional(),
  })
  .strict();
export type IndoorFloorPlanPlacement = z.infer<
  typeof indoorFloorPlanPlacementSchema
>;

export const indoorVenueFloorSchema = z
  .object({
    floorPlanId: indoorAtlasIdSchema,
    floorLevel: floorLevelSchema,
    name: z.string().trim().min(1).max(40),
    /** Map placement of the floor plan image; synced venues only. */
    plan: indoorFloorPlanPlacementSchema.optional(),
  })
  .strict();

/**
 * A geofence polygon drawn in IndoorAtlas, shown as-is on the map. It carries
 * no evacuation meaning (not a safe area, not a hazard zone). `ring` is the
 * outer ring without the closing point, at most 64 points (simplified by the sync).
 */
export const indoorVenueAreaSchema = z
  .object({
    id: venueSlugSchema,
    name: localizedNameSchema.optional(),
    description: z.string().trim().min(1).max(500).optional(),
    floorLevel: floorLevelSchema,
    indoorAtlasGeofenceId: indoorAtlasIdSchema.optional(),
    ring: z.array(pointSchema).min(3).max(64),
  })
  .strict();
export type IndoorVenueArea = z.infer<typeof indoorVenueAreaSchema>;

export const indoorVenueExitSchema = z
  .object({
    id: venueSlugSchema,
    name: localizedNameSchema,
    floorLevel: floorLevelSchema,
    lat: latitudeSchema,
    lng: longitudeSchema,
    kind: z.enum(["exit", "entrance", "stairs"]),
    /**
     * `verified` = checked on site; `event-map` = copied from an event map;
     * `estimate` = unverified guess; `indooratlas` = a POI the venue owner
     * marked in IndoorAtlas whose name looks like an exit (not independently verified).
     */
    source: z.enum(["verified", "event-map", "estimate", "indooratlas"]),
    /** IndoorAtlas POI (GeoJSON feature) the exit came from, when synced. */
    indoorAtlasPoiId: indoorAtlasIdSchema.optional(),
  })
  .strict()
  .refine(notNullIsland, nullIslandMessage);

export const indoorVenuePoiSchema = z
  .object({
    id: venueSlugSchema,
    name: localizedNameSchema,
    floorLevel: floorLevelSchema,
    /** POI ID from the IndoorAtlas CMS; without it the app matches the SDK POI by name. */
    indoorAtlasPoiId: indoorAtlasIdSchema.optional(),
    lat: latitudeSchema.optional(),
    lng: longitudeSchema.optional(),
  })
  .strict()
  .refine((poi) => (poi.lat === undefined) === (poi.lng === undefined), {
    message: "Give both lat and lng, or neither",
  })
  .refine(notNullIsland, nullIslandMessage);

const uniqueBy =
  <T>(key: (item: T) => string | number, what: string) =>
  (items: T[], context: z.RefinementCtx) => {
    const seen = new Set<string | number>();
    for (const item of items) {
      const value = key(item);
      if (seen.has(value))
        context.addIssue({
          code: "custom",
          message: `Duplicate ${what}: ${value}`,
        });
      seen.add(value);
    }
  };

/** Exit provenance values; see {@link indoorVenueExitSchema}. */
export type IndoorVenueExitSource = z.infer<
  typeof indoorVenueExitSchema
>["source"];

const venueFields = {
  id: venueSlugSchema,
  name: localizedNameSchema,
  enabled: z.boolean(),
  /** Set only by the IndoorAtlas sync job; manual documents never carry it. */
  syncedFrom: z.literal("indooratlas").optional(),
  /** Position in the IndoorAtlas venue list (0 = first); synced documents only. */
  syncOrder: z.number().int().min(0).max(10_000).optional(),
  /** Street address as entered in IndoorAtlas (synced venues) or by hand. */
  address: z.string().trim().min(1).max(300).optional(),
  /** Free-text venue description from IndoorAtlas; display only. */
  description: z.string().trim().min(1).max(1000).optional(),
  /**
   * IndoorAtlas venue. Absent for venues the app knows without IndoorAtlas
   * (e.g. the Central Library floor maps): such venues are listed and
   * numbered but never matched against the IndoorAtlas SDK.
   */
  indoorAtlas: z
    .object({
      venueId: indoorAtlasIdSchema,
      /** Whether the IndoorAtlas venue has a wayfinding graph (the SDK routes on it). Unknown when absent. */
      hasWayfinding: z.boolean().optional(),
      floors: z
        .array(indoorVenueFloorSchema)
        .max(60)
        .superRefine(uniqueBy((floor) => floor.floorPlanId, "floorPlanId"))
        .superRefine(uniqueBy((floor) => floor.floorLevel, "floorLevel")),
    })
    .strict()
    .optional(),
  /** Floor levels of a venue without IndoorAtlas floor plans (display only). */
  floorLevels: z.array(floorLevelSchema).max(60).optional(),
  location: z
    .object({
      lat: latitudeSchema,
      lng: longitudeSchema,
      /** Coarse gate around the building; positions outside it are ignored. */
      radiusM: z.number().positive().max(2000),
    })
    .strict()
    .refine(notNullIsland, nullIslandMessage),
  exits: z
    .array(indoorVenueExitSchema)
    .max(200)
    .superRefine(uniqueBy((exit) => exit.id, "exit id")),
  pois: z
    .array(indoorVenuePoiSchema)
    .max(500)
    .superRefine(uniqueBy((poi) => poi.id, "poi id")),
  /** IndoorAtlas geofence polygons (display only); synced venues. */
  areas: z
    .array(indoorVenueAreaSchema)
    .max(100)
    .superRefine(uniqueBy((area) => area.id, "area id"))
    .optional(),
  notes: z.string().max(2000).optional(),
};

const syncFieldsTogether = (venue: {
  syncedFrom?: string;
  syncOrder?: number;
}) => venue.syncOrder === undefined || venue.syncedFrom !== undefined;
const syncFieldsMessage = { message: "syncOrder needs syncedFrom" };

/** A stored venue document (Firestore or seed). `updatedAt` is ISO 8601. */
export const indoorVenueSchema = z
  .object({ ...venueFields, updatedAt: z.iso.datetime({ offset: true }) })
  .strict()
  .refine(syncFieldsTogether, syncFieldsMessage);
export type IndoorVenue = z.infer<typeof indoorVenueSchema>;

/** Admin script input: same as a stored venue, `updatedAt` is set by the script. */
export const indoorVenueInputSchema = z
  .object({
    ...venueFields,
    updatedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(syncFieldsTogether, syncFieldsMessage);
export type IndoorVenueInput = z.infer<typeof indoorVenueInputSchema>;

/** Seed file: `backend/data/indoor-venues.json`. */
export const indoorVenueSeedSchema = z
  .object({ venues: z.array(indoorVenueSchema) })
  .strict()
  .superRefine((seed, context) =>
    uniqueBy((venue: IndoorVenue) => venue.id, "venue id")(
      seed.venues,
      context,
    ),
  );

/**
 * One venue in `GET /api/indoor/venues`: enabled only, no internal notes.
 * Listed IndoorAtlas-synced first (IndoorAtlas order), then manual Firestore
 * venues (by id), then seed venues (seed file order); `rank` is the 1-based
 * position ("01", "02", …) and `primary` marks rank 1.
 */
export const publicIndoorVenueSchema = z
  .object({ ...venueFields, updatedAt: z.iso.datetime({ offset: true }) })
  .omit({ notes: true, enabled: true, syncOrder: true })
  .extend({
    /** Where this record came from: the Firestore collection or the bundled seed. */
    origin: z.enum(["firestore", "seed"]),
    rank: z.number().int().min(1),
    primary: z.boolean(),
  })
  .strict();
export type PublicIndoorVenue = z.infer<typeof publicIndoorVenueSchema>;

/** Response of `GET /api/indoor/venues`. */
export const indoorVenuesResponseSchema = z
  .object({
    venues: z.array(publicIndoorVenueSchema),
    /** `firestore` when the collection was read, `seed` when it was empty, unavailable or disabled. */
    source: z.enum(["firestore", "seed"]),
    checkedAt: z.iso.datetime(),
  })
  .strict();
export type IndoorVenuesResponse = z.infer<typeof indoorVenuesResponseSchema>;
