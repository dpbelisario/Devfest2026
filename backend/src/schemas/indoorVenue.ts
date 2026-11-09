import { z } from "zod";

/**
 * Runtime IndoorAtlas venue configuration. One Firestore document per venue in
 * `indoorVenues` (document ID = `id`), plus the seed in
 * `backend/data/indoor-venues.json`. Validated on every read and write so a bad
 * console edit cannot reach the app.
 *
 * Exits carry their provenance: only `source: "verified"` exits were checked on
 * site. `event-map` and `estimate` exits must never be presented as verified
 * evacuation routes.
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

export const indoorVenueFloorSchema = z
  .object({
    floorPlanId: indoorAtlasIdSchema,
    floorLevel: floorLevelSchema,
    name: z.string().trim().min(1).max(40),
  })
  .strict();

export const indoorVenueExitSchema = z
  .object({
    id: venueSlugSchema,
    name: localizedNameSchema,
    floorLevel: floorLevelSchema,
    lat: latitudeSchema,
    lng: longitudeSchema,
    kind: z.enum(["exit", "entrance", "stairs"]),
    /** `verified` = checked on site; `event-map` = copied from an event map; `estimate` = unverified guess. */
    source: z.enum(["verified", "event-map", "estimate"]),
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

const venueFields = {
  id: venueSlugSchema,
  name: localizedNameSchema,
  enabled: z.boolean(),
  indoorAtlas: z
    .object({
      venueId: indoorAtlasIdSchema,
      floors: z
        .array(indoorVenueFloorSchema)
        .max(60)
        .superRefine(uniqueBy((floor) => floor.floorPlanId, "floorPlanId"))
        .superRefine(uniqueBy((floor) => floor.floorLevel, "floorLevel")),
    })
    .strict(),
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
  notes: z.string().max(2000).optional(),
};

/** A stored venue document (Firestore or seed). `updatedAt` is ISO 8601. */
export const indoorVenueSchema = z
  .object({ ...venueFields, updatedAt: z.iso.datetime({ offset: true }) })
  .strict();
export type IndoorVenue = z.infer<typeof indoorVenueSchema>;

/** Admin script input: same as a stored venue, `updatedAt` is set by the script. */
export const indoorVenueInputSchema = z
  .object({
    ...venueFields,
    updatedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
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

/** One venue in `GET /api/indoor/venues`: enabled only, no internal notes. */
export const publicIndoorVenueSchema = indoorVenueSchema
  .omit({ notes: true, enabled: true })
  .extend({
    /** Where this record came from: the Firestore collection or the bundled seed. */
    origin: z.enum(["firestore", "seed"]),
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
