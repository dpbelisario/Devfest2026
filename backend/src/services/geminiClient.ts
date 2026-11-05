import { GoogleGenAI } from "@google/genai";
import type { GenerateTurn } from "./assistantService.js";

/**
 * Gemini on Vertex AI using Application Default Credentials (the Cloud Run
 * service account needs roles/aiplatform.user). No API key is involved.
 */
export function createGeminiGenerate(options: {
  project?: string;
  location: string;
  model: string;
  timeoutMs?: number;
}): GenerateTurn {
  const ai = new GoogleGenAI({
    vertexai: true,
    ...(options.project ? { project: options.project } : {}),
    location: options.location,
    httpOptions: { timeout: options.timeoutMs ?? 20_000 },
  });
  // Gemini 2.5 Flash thinks by default; a zero budget keeps replies fast and cheap.
  const thinking = /^gemini-2\.5-flash/.test(options.model)
    ? { thinkingConfig: { thinkingBudget: 0 } }
    : {};
  return async ({ systemInstruction, contents, tools }) => {
    const response = await ai.models.generateContent({
      model: options.model,
      contents,
      config: {
        systemInstruction,
        temperature: 0.2,
        maxOutputTokens: 1024,
        ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
        ...thinking,
      },
    });
    const content = response.candidates?.[0]?.content;
    if (!content?.parts?.length) throw new Error("Empty model response");
    return content;
  };
}
