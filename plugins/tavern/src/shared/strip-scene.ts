import { z } from "zod";
import type { SpeechKey } from "./says";
import type { VoiceMode } from "./settings";

const roadPlaceSchema = z.object({
  id: z.string(),
  kind: z.enum(["plan", "read", "make", "review", "seal", "report"]),
  state: z.enum(["done", "active", "held"]),
  waypoint: z.string().optional(),
});
const stripRoadSchema = z.object({
  key: z.string(),
  title: z.string().optional(),
  current: z.string(),
  places: z.array(roadPlaceSchema),
});

export type RoadPlace = z.infer<typeof roadPlaceSchema>;
export type StripRoad = z.infer<typeof stripRoadSchema>;

export const stripSceneSchema = z.object({
  revision: z.string(),
  at: z.number().nullable(),
  role: z.enum(["keeper", "ranger", "smith", "warden", "wanderer", "other"]),
  stage: z.enum(["plan", "work", "review", "rest", "neutral"]),
  activity: z.enum(["read", "make", "unknown"]),
  moment: z.enum(["assignment", "plan-ready", "report", "verified", "wrapped", "none"]),
  posture: z.enum(["clear", "held", "gone"]),
  road: stripRoadSchema.optional(),
});

export type StripScene = z.infer<typeof stripSceneSchema>;
export const SPEECH_REPLY_MS = 10_000;
export const dialogueRequestSchema = z.object({ kind: z.enum(["click", "ambient"]), at: z.number().int().nonnegative() }).strict();
export type DialogueRequest = z.infer<typeof dialogueRequestSchema>;
export type SpeechContext = Pick<StripScene, "role" | "stage"> & { moment: StripScene["moment"] | DialogueRequest["kind"] };

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
