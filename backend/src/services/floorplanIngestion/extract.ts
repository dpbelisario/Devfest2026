import { randomBytes } from "node:crypto";
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { classifyExit } from "../indoorAtlasSync.js";
import type { FloorPlanProposal, PoiKind } from "./proposal.js";

/**
 * Step 1 of docs/floorplan-to-indooratlas.md: read a floor-plan image with
 * Gemini (structured output) and turn the labels into a *proposed*
 * FloorPlanProposal. The model only reads text and boxes; a deterministic
 * post-processor decides what each label is, so the same model output always
 * gives the same proposal. Walls and the walkable graph are not extracted:
 * a person draws the graph while reviewing.
 */

export const labelCategories = [
  "exit",
  "entrance",
  "stairs",
  "elevator",
  "toilet",
  "room",
  "other",
] as const;

/** One label as Gemini returns it; boxes use Gemini's 0..1000 convention. */
export const ocrLabelSchema = z.object({
  text: z.string().trim().min(1).max(120),
  category: z.enum(labelCategories),
  /** [yMin, xMin, yMax, xMax] in 0..1000 of the image. */
  box: z.tuple([
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
  ]),
  confidence: z.number().min(0).max(1),
});
export type OcrLabel = z.infer<typeof ocrLabelSchema>;
export const ocrResultSchema = z.object({
  labels: z.array(ocrLabelSchema).max(400),
});

/** Gemini call: image in, JSON text out. Tests pass a recorded answer. */
export type LabelModel = (input: {
  image: Buffer;
  mimeType: string;
  prompt: string;
}) => Promise<string>;

export const extractionPrompt = `You read building floor plans and evacuation maps (避難経路図).
List every printed text label on the plan: room names, 出口, 非常口, 入口, 階段, EV/エレベーター, トイレ, and English equivalents.
For each label give: text exactly as printed; category (exit, entrance, stairs, elevator, toilet, room, other);
box as [yMin, xMin, yMax, xMax] scaled 0-1000 to the whole image; confidence 0-1 that text and category are right.
Use category exit only for exits to the outside or emergency exits. Do not invent labels that are not printed.`;

/** Vertex AI Gemini with a JSON response schema (Application Default Credentials). */
export function createGeminiLabelModel(options: {
  project?: string;
  location: string;
  model: string;
}): LabelModel {
  const ai = new GoogleGenAI({
    vertexai: true,
    ...(options.project ? { project: options.project } : {}),
    location: options.location,
    httpOptions: { timeout: 120_000 },
  });
  return async ({ image, mimeType, prompt }) => {
    const response = await ai.models.generateContent({
      model: options.model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: image.toString("base64") } },
            { text: prompt },
          ],
        },
      ],
      config: {
        temperature: 0,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            labels: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING },
                  category: { type: Type.STRING, enum: [...labelCategories] },
                  box: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                  confidence: { type: Type.NUMBER },
                },
                required: ["text", "category", "box", "confidence"],
              },
            },
          },
          required: ["labels"],
        },
      },
    });
    const text = response.text;
    if (!text) throw new Error("Empty model response");
    return text;
  };
}

/** Parse model JSON; invalid labels are dropped one by one, not fatal. */
export function parseLabels(json: string): {
  labels: OcrLabel[];
  dropped: number;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The model did not return JSON.");
  }
  const list =
    typeof raw === "object" &&
    raw !== null &&
    "labels" in raw &&
    Array.isArray(raw.labels)
      ? (raw.labels as unknown[])
      : null;
  if (!list) throw new Error("The model JSON has no labels list.");
  const labels: OcrLabel[] = [];
  for (const item of list.slice(0, 400)) {
    const parsed = ocrLabelSchema.safeParse(item);
    if (parsed.success) labels.push(parsed.data);
  }
  return { labels, dropped: list.length - labels.length };
}

/** UUID v1 (IndoorAtlas feature ids) from a time and 10 random bytes. */
export function uuidV1(now: Date, random: Buffer = randomBytes(10)): string {
  const ticks = BigInt(now.getTime()) * 10_000n + 0x01b21dd213814000n; // 100 ns since 1582-10-15
  const hex = (value: bigint, length: number) =>
    value.toString(16).padStart(length, "0");
  const timeLow = ticks & 0xffffffffn;
  const timeMid = (ticks >> 32n) & 0xffffn;
  const timeHigh = ((ticks >> 48n) & 0x0fffn) | 0x1000n;
  const clock =
    ((BigInt(random.readUInt16BE(0)) & 0x3fffn) | 0x8000n) & 0xffffn;
  const node =
    (BigInt(`0x${random.subarray(2, 8).toString("hex")}`) | 0x010000000000n) &
    0xffffffffffffn;
  return `${hex(timeLow, 8)}-${hex(timeMid, 4)}-${hex(timeHigh, 4)}-${hex(clock, 4)}-${hex(node, 12)}`;
}

/** English half of a bilingual name for common Japanese floor-plan words. */
const englishFor: [RegExp, string][] = [
  [/非常口/, "Emergency exit"],
  [/出口/, "Exit"],
  [/入口/, "Entrance"],
  [/階段.*(EV|エレベーター)|(EV|エレベーター).*階段/i, "Stairs and elevator"],
  [/階段/, "Stairs"],
  [/^(EV|エレベーター|エレベータ)$/i, "Elevator"],
  [/トイレ|便所/, "Toilets"],
];

/** Kind by the same keyword rules the app sync uses, plus elevator/toilet. */
export function ruleKind(text: string): PoiKind | null {
  const exit = classifyExit(text);
  if (exit) return exit;
  const value = text.normalize("NFKC");
  if (/トイレ|便所|toilet|restroom|wc\b/i.test(value)) return "toilet";
  if (/^(EV|エレベーター|エレベータ)$|elevator|lift/i.test(value))
    return "elevator";
  return null;
}

/**
 * Deterministic post-processor: labels → proposed POIs at box centers.
 * - Kind: the keyword rule wins; the model's category is used only when no
 *   rule matches, and a disagreement halves the confidence.
 * - Only exit, entrance, stairs, elevator and toilet labels become POIs
 *   (rooms are listed in the note for the reviewer, not published).
 * - Names become `English / 日本語` when a known Japanese word is found.
 * - Every POI is `origin: "ocr"` and the proposal is `review.status: "proposed"`.
 */
export function labelsToProposal(
  labels: OcrLabel[],
  options: {
    venue: FloorPlanProposal["venue"];
    floor: FloorPlanProposal["floor"];
    source: FloorPlanProposal["source"];
    now: Date;
    random?: () => Buffer;
  },
): FloorPlanProposal {
  const pois: FloorPlanProposal["pois"] = [];
  const rooms: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const rule = ruleKind(label.text);
    const kind: PoiKind = rule ?? label.category;
    if (kind === "room" || kind === "other") {
      if (kind === "room") rooms.push(label.text);
      continue;
    }
    const [yMin, xMin, yMax, xMax] = label.box;
    const at: [number, number] = [
      Math.round(((xMin + xMax) / 2) * 10) / 10_000,
      Math.round(((yMin + yMax) / 2) * 10) / 10_000,
    ];
    const key = `${kind}|${at.map((v) => v.toFixed(2)).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const english = englishFor.find(([pattern]) => pattern.test(label.text));
    const name =
      english && english[1].toLowerCase() !== label.text.toLowerCase()
        ? `${english[1]} / ${label.text}`
        : label.text;
    const confidence =
      rule && rule !== label.category ? label.confidence / 2 : label.confidence;
    pois.push({
      id: uuidV1(options.now, options.random?.()),
      name: name.slice(0, 120),
      // No source title here: a title such as 避難経路図 would make every POI read as an exit.
      description:
        "Read by OCR from the floor plan. Proposal; check the plan and on site.",
      kind,
      at,
      confidence: Math.round(confidence * 100) / 100,
      origin: "ocr",
    });
  }
  return {
    schemaVersion: 1,
    venue: options.venue,
    floor: options.floor,
    source: options.source,
    review: {
      status: "proposed",
      note: rooms.length
        ? `Room labels seen (not published): ${rooms.slice(0, 50).join(", ")}`
        : undefined,
    },
    pois,
    areas: [],
    graph: { nodes: [], edges: [] },
  };
}
