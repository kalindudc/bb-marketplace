import { z } from "zod";
import type { SpeechKey } from "./says";
import type { VoiceMode } from "./settings";

export const stripSceneSchema = z.object({
  revision: z.string(),
  at: z.number().nullable(),
  role: z.enum(["keeper", "ranger", "smith", "warden", "wanderer", "other"]),
  stage: z.enum(["plan", "work", "review", "rest", "neutral"]),
  activity: z.enum(["read", "make", "unknown"]),
  moment: z.enum(["assignment", "plan-ready", "report", "verified", "wrapped", "none"]),
  posture: z.enum(["clear", "held", "gone"]),
});

export type StripScene = z.infer<typeof stripSceneSchema>;
export type StripProp = "scroll" | "book" | "bookmarked" | "folio" | "anvil" | "seal";

export function dialogueSlot(scene: StripScene | undefined, voice: VoiceMode): SpeechKey | null {
  if (!scene || scene.posture !== "clear" || scene.at === null || voice === "off") return null;
  if (scene.moment === "verified") return "verified";
  if (scene.moment === "wrapped") return "wrap";
  return voice === "full" && (scene.moment === "assignment" || scene.moment === "plan-ready") ? "working" : null;
}

export function validateDialogue(value: unknown) {
  if (typeof value !== "string" || value.length > 56 || !/^[A-Za-z][A-Za-z ,'’-]*[.!?]$/.test(value) || value.split(/ +/).length > 10) return null;
  if (/\b(merged|approved|deployed|verified|passed|failed|fixed|completed|shipped|guaranteed|tested|won)\b/i.test(value)) return null;
  return value;
}

export function stripProp(scene: StripScene | undefined): StripProp | null {
  if (!scene || scene.posture === "gone") return null;
  if (scene.moment === "verified") return "seal";
  if (scene.stage === "review") return "folio";
  if (scene.stage === "plan" || scene.moment === "plan-ready") return "scroll";
  if (scene.stage !== "work") return null;
  if (scene.activity === "read" || scene.activity === "unknown" && scene.role === "ranger") return scene.moment === "report" ? "bookmarked" : "book";
  if (scene.activity === "make" || scene.activity === "unknown" && scene.role === "smith") return "anvil";
  return null;
}
