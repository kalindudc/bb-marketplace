import { z } from "zod";
import { DIALOGUE_DEADLINE_MS, DIALOGUE_INSTALL_CAP, DIALOGUE_THREAD_CAP, dialogueSlot, validateDialogue, type StripScene } from "../shared/strip-scene";
import type { VoiceMode } from "../shared/settings";
import type { KeeperStore } from "./keeper/store";

const MAX_INPUT = 800;
const MAX_OUTPUT = 64;
const DAY_MS = 86_400_000;
const profileSchema = z.object({ endpoint: z.url({ protocol: /^https$/ }), model: z.string().trim().min(1).max(140),
  inputUsdPerMillion: z.number().positive(), outputUsdPerMillion: z.number().positive(), qualified: z.literal(true) }).strict();
export type DialogueProfile = Omit<z.infer<typeof profileSchema>, "qualified"> & { apiKey: string };

export function dialogueProfile(env: NodeJS.ProcessEnv) {
  const apiKey = env.TAVERN_SPEECH_API_KEY;
  if (!apiKey || !env.TAVERN_SPEECH_PROFILE) return null;
  try {
    const { qualified: _, ...profile } = profileSchema.parse(JSON.parse(env.TAVERN_SPEECH_PROFILE));
    const url = new URL(profile.endpoint);
    if (url.username || url.password || url.search || url.hash) return null;
    const upperUsd = (MAX_INPUT * profile.inputUsdPerMillion + MAX_OUTPUT * profile.outputUsdPerMillion) / 1_000_000;
    return upperUsd * DIALOGUE_INSTALL_CAP < 0.10 ? { ...profile, apiKey } : null;
  } catch {
    return null;
  }
}

export class BubbleQuota {
  constructor(private store: KeeperStore) {}

  reserve(seat: string, at: number, now: number) {
    const day = Math.floor(now / DAY_MS);
    if (!seat || now < at || now - at >= DIALOGUE_DEADLINE_MS || Math.floor(at / DAY_MS) !== day) return false;
    return this.store.atomic(() => {
      const { db } = this.store;
      const read = db.prepare("SELECT attempts, latest FROM tavern_dialogue_daily WHERE day=? AND seat=?");
      const thread = read.get(day, seat) as { attempts: number; latest: number } | undefined;
      const install = read.get(day, "") as { attempts: number } | undefined;
      if (thread && (thread.attempts >= DIALOGUE_THREAD_CAP || thread.latest >= at) || (install?.attempts ?? 0) >= DIALOGUE_INSTALL_CAP) return false;
      const add = db.prepare(`INSERT INTO tavern_dialogue_daily(day, seat, attempts, latest) VALUES (?, ?, 1, ?)
        ON CONFLICT(day, seat) DO UPDATE SET attempts=attempts+1, latest=excluded.latest`);
      add.run(day, seat, at);
      add.run(day, "", at);
      db.prepare("DELETE FROM tavern_dialogue_daily WHERE day < ?").run(day - 1);
      return true;
    });
  }
}

const replySchema = z.object({ status: z.literal("completed"), model: z.string(),
  usage: z.object({ input_tokens: z.number().int().min(1).max(MAX_INPUT), output_tokens: z.number().int().min(1).max(MAX_OUTPUT) }),
  output: z.array(z.object({ type: z.string(), role: z.string().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })) });

export async function requestDialogue(profile: DialogueProfile, { role, stage, moment }: Pick<StripScene, "role" | "stage" | "moment">,
  signal: AbortSignal, fetcher = fetch) {
  const input = `One cozy medieval remark in five simple words, then a period. Letters and single spaces only. No claims, names, commands or titles. Role: ${role}; stage: ${stage}; change: ${moment}.`;
  const response = await fetcher(profile.endpoint, { method: "POST", redirect: "error", signal,
    headers: { authorization: `Bearer ${profile.apiKey}`, "content-type": "application/json", "cache-control": "no-cache" },
    body: JSON.stringify({ model: profile.model, input, max_output_tokens: MAX_OUTPUT, reasoning: { effort: "none" }, store: false, service_tier: "default" }) });
  if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); return null; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "", bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) { void reader.cancel().catch(() => {}); return null; }
      raw += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  const result = replySchema.safeParse(JSON.parse(raw + decoder.decode()));
  if (!result.success || result.data.model !== profile.model) return null;
  const { output, usage } = result.data;
  const [message] = output;
  if (output.length !== 1 || !message || message.type !== "message" || message.role !== "assistant" || message.content?.length !== 1 || message.content[0]?.type !== "output_text") return null;
  return { text: validateDialogue(message.content[0].text), inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

type Line = { revision: string; text: string | null };
type Pane = (line: Line) => void;
type Watch = { panes: Set<Pane>; seen: string; flight?: AbortController };

export class DialogueWatches {
  private readonly seats = new Map<string, Watch>();
  constructor(private read: (seat: string) => { scene: StripScene; voice: VoiceMode } | null,
    private reserve: (seat: string, at: number, now: number) => boolean,
    private complete: (scene: StripScene, signal: AbortSignal) => Promise<string | null>,
    private now = Date.now) {}

  has(seat: string) { return this.seats.has(seat); }

  subscribe(seat: string, pane: Pane) {
    const current = this.read(seat);
    if (!current || current.scene.posture === "gone" || current.voice === "off") return null;
    let watch = this.seats.get(seat);
    if (!watch) {
      if (this.seats.size >= DIALOGUE_INSTALL_CAP) return null;
      watch = { panes: new Set(), seen: current.scene.revision };
      this.seats.set(seat, watch);
    }
    if (watch.panes.size >= 4) return null;
    const active = watch;
    active.panes.add(pane);
    return () => {
      active.panes.delete(pane);
      if (active.panes.size === 0 && this.seats.get(seat) === active) this.drop(seat);
    };
  }

  drop(seat: string) {
    this.seats.get(seat)?.flight?.abort();
    this.seats.delete(seat);
  }

  cancelFlights() { for (const watch of this.seats.values()) watch.flight?.abort(); }

  dispose() { for (const seat of this.seats.keys()) this.drop(seat); }

  async changed(seat: string) {
    const watch = this.seats.get(seat);
    if (!watch) return;
    const state = this.read(seat);
    if (!state || state.scene.posture === "gone" || state.voice === "off") { this.drop(seat); return; }
    const { scene, voice } = state;
    if (!dialogueSlot(scene, voice)) watch.flight?.abort();
    if (watch.seen === scene.revision) return;
    watch.seen = scene.revision;
    if (watch.flight) { watch.flight.abort(); return; }
    if (!dialogueSlot(scene, voice) || scene.at === null) return;
    const at = scene.at, now = this.now();
    const panes = [...watch.panes];
    const publish = (text: string | null) => {
      for (const pane of panes) if (watch.panes.has(pane)) pane({ revision: scene.revision, text });
    };
    if (now < at || now - at >= DIALOGUE_DEADLINE_MS) return;
    if (!this.reserve(seat, at, now)) { publish(null); return; }
    const flight = watch.flight = new AbortController();
    const signal = AbortSignal.any([flight.signal, AbortSignal.timeout(DIALOGUE_DEADLINE_MS - (now - at))]);
    try {
      const text = await this.complete(scene, signal).catch(() => null);
      const current = !signal.aborted && this.now() - at < DIALOGUE_DEADLINE_MS && this.read(seat);
      if (current && current.scene.revision === scene.revision && current.voice === voice && dialogueSlot(current.scene, current.voice)) publish(text);
    } finally {
      if (watch.flight === flight) watch.flight = undefined;
    }
  }
}
