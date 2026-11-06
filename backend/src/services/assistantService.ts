import type { Content, FunctionDeclaration, Part } from "@google/genai";
import { z } from "zod";
import {
  siteDisasters,
  type LiveDataService,
  type LiveSiteResult,
} from "./liveDataService.js";

/**
 * Evacuation assistant: Gemini answers questions by calling tools that read
 * the live job data (designated sites, JMA alerts) and can ask the app to
 * show sites on the map or start AR guidance. The model never sees anything
 * it could present as opening status or capacity, because the data has none.
 */

export const assistantLanguages = ["en", "ja", "zh", "ko"] as const;
export type AssistantLanguage = (typeof assistantLanguages)[number];

export interface AssistantRequest {
  message: string;
  language: AssistantLanguage;
  /** Where the app currently places the user; `demo` when GPS is not in use. */
  location: { lat: number; lng: number; source: "gps" | "demo" } | null;
  /** Earlier turns, oldest first (text only). */
  history: { role: "user" | "model"; text: string }[];
}

/** Something the app should do after showing the reply. */
export type AssistantAction =
  | { type: "showSites"; siteIds: string[] }
  | { type: "startAr"; siteId: string };

export interface AssistantReply {
  reply: string;
  /** Sites returned by tools during this turn (nearest first), for chips. */
  sites: LiveSiteResult[];
  actions: AssistantAction[];
  toolCalls: string[];
  model: string;
}

/** One model call: returns the model's content (text and/or function calls). */
export type GenerateTurn = (input: {
  systemInstruction: string;
  contents: Content[];
  tools: FunctionDeclaration[];
}) => Promise<Content>;

const maxToolRounds = 4;

const languageNames: Record<AssistantLanguage, string> = {
  en: "English",
  ja: "Japanese",
  zh: "Simplified Chinese",
  ko: "Korean",
};

const tools: FunctionDeclaration[] = [
  {
    name: "find_evacuation_sites",
    description:
      "Nearest official designated emergency evacuation sites (指定緊急避難場所) in Nagoya to the user's current location. Distances are straight-line metres, not walking routes. Opening status and capacity are not known.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        disaster: {
          type: "string",
          enum: [...siteDisasters],
          description:
            "Only sites designated for this hazard. Omit for any hazard.",
        },
        limit: { type: "integer", minimum: 1, maximum: 8 },
        radius_meters: { type: "integer", minimum: 100, maximum: 10000 },
      },
    },
  },
  {
    name: "get_current_alerts",
    description:
      "Latest official Japan Meteorological Agency information stored by Contour: the Aichi weather warning bulletin (statuses for Nagoya) and recent earthquake, tsunami and volcano bulletins. Data can be several minutes old.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "show_sites_on_map",
    description:
      "Highlight sites on the user's map. Use it whenever you recommend specific sites.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        site_ids: { type: "array", items: { type: "string" }, maxItems: 8 },
      },
      required: ["site_ids"],
    },
  },
  {
    name: "start_ar_navigation",
    description:
      "Open the camera AR arrow pointing toward one site. Call it whenever the user asks to be guided, navigated or taken to a place.",
    parametersJsonSchema: {
      type: "object",
      properties: { site_id: { type: "string" } },
      required: ["site_id"],
    },
  },
];

function systemInstruction(request: AssistantRequest): string {
  const where = request.location
    ? request.location.source === "gps"
      ? "The user's location comes from the phone's GPS."
      : "GPS is not in use: the app places the user at a demo position near Nagoya University. Say so if location matters."
    : "The user's location is unknown; site searches will fail until they enable location.";
  return [
    "You are Contour's evacuation assistant for Nagoya, Japan, used during or before disasters.",
    `Reply in ${languageNames[request.language]}, in plain text without Markdown, in at most 120 words.`,
    "Use the tools for every fact about sites, distances and alerts. Never invent sites, distances, warnings or earthquake information.",
    "Designated emergency evacuation sites are places to flee to for specific hazards; they are not necessarily shelters for staying. Their opening status and capacity are unknown: never say a site is open, safe, staffed or has space.",
    "Distances are straight-line, not walking routes. Prefer sites designated for the hazard the user mentions.",
    "Weather statuses are official JMA wording. If there is no data, say it is unknown; never declare an all-clear.",
    "Always tell people to follow instructions from Nagoya City and the Japan Meteorological Agency. For life-threatening emergencies, call 119 (fire and ambulance) or 110 (police).",
    "When you recommend specific sites, call show_sites_on_map with their ids.",
    "If the user asks to be guided, navigated or taken somewhere (for example: guide me, take me, navigate, 案内して, 带我去, 안내해 줘), find suitable sites and then call start_ar_navigation with the single best one (nearest site designated for their hazard). Do not ask for confirmation first.",
    where,
  ].join("\n");
}

const findArgsSchema = z.object({
  disaster: z.enum(siteDisasters).optional(),
  limit: z.coerce.number().int().min(1).max(8).default(5),
  radius_meters: z.coerce.number().int().min(100).max(10000).default(3000),
});
const showArgsSchema = z.object({
  site_ids: z.array(z.string()).max(8),
});
const arArgsSchema = z.object({ site_id: z.string() });

/** Runs one assistant turn, including up to `maxToolRounds` tool rounds. */
export class AssistantService {
  constructor(
    private readonly options: {
      live: LiveDataService;
      generate: GenerateTurn;
      model: string;
    },
  ) {}

  async reply(request: AssistantRequest): Promise<AssistantReply> {
    const contents: Content[] = [
      ...request.history.map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      })),
      { role: "user", parts: [{ text: request.message }] },
    ];
    const sites = new Map<string, LiveSiteResult>();
    const actions: AssistantAction[] = [];
    const toolCalls: string[] = [];
    const system = systemInstruction(request);

    for (let round = 0; round <= maxToolRounds; round += 1) {
      const content = await this.options.generate({
        systemInstruction: system,
        contents,
        tools: round < maxToolRounds ? tools : [],
      });
      const parts = content.parts ?? [];
      const calls = parts.flatMap((part) =>
        part.functionCall?.name ? [part.functionCall] : [],
      );
      if (calls.length === 0) {
        const text = parts
          .map((part) => (part.thought ? "" : (part.text ?? "")))
          .join("")
          .trim();
        return {
          reply: text,
          sites: [...sites.values()],
          actions,
          toolCalls,
          model: this.options.model,
        };
      }
      contents.push({ role: "model", parts });
      const responses: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        toolCalls.push(name);
        const result = await this.runTool(name, call.args ?? {}, request, {
          sites,
          actions,
        });
        responses.push({
          functionResponse: { id: call.id, name, response: result },
        });
      }
      contents.push({ role: "user", parts: responses });
    }
    throw new Error("Assistant did not finish within the tool-round limit");
  }

  private async runTool(
    name: string,
    args: Record<string, unknown>,
    request: AssistantRequest,
    state: {
      sites: Map<string, LiveSiteResult>;
      actions: AssistantAction[];
    },
  ): Promise<Record<string, unknown>> {
    try {
      switch (name) {
        case "find_evacuation_sites": {
          if (!request.location)
            return {
              error: "Location unknown. Ask the user to enable location.",
            };
          const parsed = findArgsSchema.parse(args);
          const found = await this.options.live.findSites({
            lat: request.location.lat,
            lng: request.location.lng,
            limit: parsed.limit,
            radiusMeters: parsed.radius_meters,
            disaster: parsed.disaster,
          });
          if (!found) return { error: "Site data is not available yet." };
          for (const site of found.sites) state.sites.set(site.id, site);
          return {
            locationSource: request.location.source,
            datasetUpdated: found.info.lastChangedAt,
            sites: found.sites.map((site) => ({
              id: site.id,
              name: site.name,
              address: site.address,
              designatedFor: site.disasters,
              straightLineMeters: site.distanceMeters,
              bearingDegrees: site.bearingDegrees,
              openingStatus: "unknown",
            })),
          };
        }
        case "get_current_alerts":
          return { ...(await this.options.live.getAlerts()) };
        case "show_sites_on_map": {
          const ids = showArgsSchema
            .parse(args)
            .site_ids.filter((id) => state.sites.has(id));
          if (ids.length === 0)
            return {
              error: "Unknown site ids. Call find_evacuation_sites first.",
            };
          state.actions.push({ type: "showSites", siteIds: ids });
          return { shown: ids.length };
        }
        case "start_ar_navigation": {
          const id = arArgsSchema.parse(args).site_id;
          if (!state.sites.has(id))
            return {
              error: "Unknown site id. Call find_evacuation_sites first.",
            };
          state.actions.push({ type: "startAr", siteId: id });
          return { started: true };
        }
        default:
          return { error: `Unknown tool ${name}` };
      }
    } catch (error) {
      if (error instanceof z.ZodError) return { error: "Invalid arguments." };
      throw error;
    }
  }
}
