import type { IaFloorPlan } from "../../schemas/indoorAtlas.js";
import {
  nodePosition,
  type FloorPlanProposal,
  type ImagePoint,
} from "./proposal.js";

/** Floor plan corners in degrees, from `GET /venues/{id}/floorplans`. */
export interface PlanCorners {
  topLeft: { lat: number; lon: number };
  topRight: { lat: number; lon: number };
  bottomLeft: { lat: number; lon: number };
}

/** Corners of an IndoorAtlas floor plan, or null when the plan is not placed on the map. */
export function planCorners(plan: IaFloorPlan): PlanCorners | null {
  const image = plan.image;
  const ok = (value: { lat: number; lon: number } | null | undefined) =>
    value && !(value.lat === 0 && value.lon === 0) ? value : null;
  const topLeft = ok(image?.topLeft);
  const topRight = ok(image?.topRight);
  const bottomLeft = ok(image?.bottomLeft);
  return topLeft && topRight && bottomLeft
    ? { topLeft, topRight, bottomLeft }
    : null;
}

const round7 = (value: number) => Math.round(value * 1e7) / 1e7;

/**
 * `[lng, lat]` of a normalized image point on a placed floor plan. The image
 * is treated as a parallelogram spanned by its top edge and left edge, which
 * is exact for IndoorAtlas placements (rotation + scale) at building size.
 */
export function imageToLngLat(
  [x, y]: ImagePoint,
  corners: PlanCorners,
): [number, number] {
  const { topLeft, topRight, bottomLeft } = corners;
  const lat =
    topLeft.lat +
    x * (topRight.lat - topLeft.lat) +
    y * (bottomLeft.lat - topLeft.lat);
  const lon =
    topLeft.lon +
    x * (topRight.lon - topLeft.lon) +
    y * (bottomLeft.lon - topLeft.lon);
  return [round7(lon), round7(lat)];
}

export interface GeofenceFeature {
  type: "Feature";
  id: string;
  properties: { floor: number; name: string; description: string };
  geometry:
    | { type: "Point"; coordinates: [number, number] }
    | { type: "Polygon"; coordinates: [number, number][][] };
}

export interface WayfindingFeature {
  type: "Feature";
  properties: Record<string, never>;
  geometry: {
    type: "LineString";
    coordinates: [[number, number, number], [number, number, number]];
  };
}

/** POIs (Point) and areas (Polygon) as IndoorAtlas geofence features. */
export function buildGeofenceFeatures(
  proposal: FloorPlanProposal,
  corners: PlanCorners,
): GeofenceFeature[] {
  const floor = proposal.floor.floorNumber;
  return [
    ...proposal.pois.map((poi): GeofenceFeature => ({
      type: "Feature",
      id: poi.id,
      properties: { floor, name: poi.name, description: poi.description },
      geometry: { type: "Point", coordinates: imageToLngLat(poi.at, corners) },
    })),
    ...proposal.areas.map((area): GeofenceFeature => ({
      type: "Feature",
      id: area.id,
      properties: { floor, name: area.name, description: area.description },
      geometry: {
        type: "Polygon",
        coordinates: [area.ring.map((point) => imageToLngLat(point, corners))],
      },
    })),
  ];
}

/** Graph edges as wayfinding LineStrings with `[lng, lat, floor]` positions. */
export function buildWayfindingFeatures(
  proposal: FloorPlanProposal,
  corners: PlanCorners,
): WayfindingFeature[] {
  const floor = proposal.floor.floorNumber;
  const nodes = new Map(proposal.graph.nodes.map((node) => [node.id, node]));
  const position = (id: string): [number, number, number] => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Unknown graph node ${id}`);
    const [lng, lat] = imageToLngLat(nodePosition(proposal, node), corners);
    return [lng, lat, floor];
  };
  return proposal.graph.edges.map(([a, b]) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: [position(a), position(b)] },
  }));
}
