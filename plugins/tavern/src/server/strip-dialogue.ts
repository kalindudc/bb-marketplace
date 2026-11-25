import { dialogueSlot, type DialogueRequest, type SpeechContext, type StripScene } from "../shared/strip-scene";
import type { VoiceMode } from "../shared/settings";
import type { KeeperStore } from "./keeper/store";

const DAY_MS = 86_400_000;
const utcDay = (at: number) => Math.floor(at / DAY_MS);

export class SpeechAttempts {
  constructor(private store: KeeperStore) {}

  used(now: number): number {
    const row = this.store.db.prepare("SELECT attempts FROM tavern_dialogue_daily WHERE day=? AND seat=''").get(utcDay(now)) as { attempts: number } | undefined;
    return row?.attempts ?? 0;
  }

  reserve(seat: string, at: number | null, now: number) {
    const day = utcDay(now);
    if (!seat || (at !== null && (now < at || utcDay(at) !== day))) return false;
    return this.store.atomic(() => {
      const { db } = this.store;
      const add = db.prepare(`INSERT INTO tavern_dialogue_daily(day, seat, attempts, latest) VALUES (?, ?, 1, ?)
        ON CONFLICT(day, seat) DO UPDATE SET attempts=attempts+1, latest=excluded.latest`);
      if (at !== null) {
        const thread = db.prepare("SELECT latest FROM tavern_dialogue_daily WHERE day=? AND seat=?").get(day, seat) as { latest: number } | undefined;
        if (thread && thread.latest >= at) return false;
        add.run(day, seat, at);
      }
      add.run(day, "", now);
      db.prepare("DELETE FROM tavern_dialogue_daily WHERE day < ?").run(day - 1);
      return true;
    });
  }
}

type Line = { revision: string; text: string; request?: DialogueRequest };
type Pane = (line: Line) => void;
type Flight = { controller: AbortController; panes: Map<Pane, DialogueRequest | undefined> };
type Watch = { panes: Set<Pane>; seen: string; since: number; ambientSince: number; flight?: Flight };

export class DialogueWatches {
  private readonly seats = new Map<string, Watch>();
  constructor(private read: (seat: string) => { scene: StripScene; voice: VoiceMode } | null,
    private reserve: (seat: string, at: number | null, now: number) => boolean,
    private complete: (scene: SpeechContext, signal: AbortSignal, reserve: () => boolean, current: () => boolean) => Promise<string | null>,
    private now = Date.now,
    private watching: (active: boolean) => void = () => {}) {}

  has(seat: string) { return this.seats.has(seat); }

  subscribe(seat: string, pane: Pane) {
    const current = this.read(seat);
    if (!current || current.scene.posture === "gone" || current.voice === "off") return null;
    let watch = this.seats.get(seat);
    if (!watch) {
      if (this.seats.size >= 100) return null;
      const now = this.now();
      watch = { panes: new Set(), seen: current.scene.revision, since: now, ambientSince: now };
      this.seats.set(seat, watch);
      if (this.seats.size === 1) this.watching(true);
    }
    if (watch.panes.size >= 4) return null;
    const active = watch;
    active.panes.add(pane);
    return () => {
      active.panes.delete(pane);
      active.flight?.panes.delete(pane);
      if (active.flight?.panes.size === 0) active.flight.controller.abort();
      if (active.panes.size === 0 && this.seats.get(seat) === active) this.drop(seat);
    };
  }

  drop(seat: string) {
    this.seats.get(seat)?.flight?.controller.abort();
    if (this.seats.delete(seat) && this.seats.size === 0) this.watching(false);
  }

  cancelFlights() { for (const watch of this.seats.values()) watch.flight?.controller.abort(); }

  dispose() { for (const seat of this.seats.keys()) this.drop(seat); }

  async changed(seat: string) {
    const watch = this.seats.get(seat);
    if (!watch) return;
    const state = this.read(seat);
    if (!state || state.scene.posture === "gone" || state.voice === "off") { this.drop(seat); return; }
    const { scene, voice } = state;
    if (scene.posture !== "clear") watch.flight?.controller.abort();
    if (watch.seen === scene.revision) return;
    watch.seen = scene.revision;
    const since = watch.since, now = watch.since = this.now();
    if (watch.flight) { watch.flight.controller.abort(); return; }
    if (!dialogueSlot(scene, voice) || scene.at === null || scene.at < since || scene.at > now) return;
    await this.speak(seat, watch, scene, voice, new Map([...watch.panes].map(pane => [pane, undefined])));
  }

  async request(seat: string, pane: Pane, request: DialogueRequest, minGapMs: number) {
    const watch = this.seats.get(seat), now = this.now();
    if (!watch?.panes.has(pane)) return;
    const state = this.read(seat);
    if (!state || state.voice === "off" || state.scene.posture !== "clear") return;
    if (watch.flight) {
      if (request.kind === "click" && !watch.flight.controller.signal.aborted) watch.flight.panes.set(pane, request);
      return;
    }
    if (request.kind === "ambient") {
      if (state.voice !== "full" || now - watch.ambientSince < minGapMs) return;
      watch.ambientSince = now;
    }
    await this.speak(seat, watch, state.scene, state.voice, new Map([[pane, request]]), request.kind);
  }

  private async speak(seat: string, watch: Watch, scene: StripScene, voice: VoiceMode, panes: Flight["panes"], kind?: DialogueRequest["kind"]) {
    const current = () => {
      const state = this.read(seat);
      return state?.scene.revision === scene.revision && state.voice === voice &&
        (kind ? state.scene.posture === "clear" : !!dialogueSlot(state.scene, state.voice));
    };
    const flight = watch.flight = { controller: new AbortController(), panes };
    const signal = flight.controller.signal;
    try {
      const text = await this.complete({ threadId: seat, role: scene.role, stage: scene.stage, moment: kind ?? scene.moment }, signal, () =>
        !signal.aborted && current() && this.reserve(seat, kind ? null : scene.at, this.now()), current);
      if (text && !signal.aborted && current()) {
        for (const [pane, request] of panes) pane({ revision: scene.revision, text, ...(request ? { request } : {}) });
      }
    } finally {
      if (watch.flight === flight) watch.flight = undefined;
    }
  }
}
