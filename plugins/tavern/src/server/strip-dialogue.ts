import { dialogueSlot, type StripScene } from "../shared/strip-scene";
import { DEFAULT_SETTINGS, type TavernSettings, type VoiceMode } from "../shared/settings";
import type { KeeperStore } from "./keeper/store";

const DAY_MS = 86_400_000;
const utcDay = (at: number) => Math.floor(at / DAY_MS);
type Limits = Pick<TavernSettings["tavern"], "speechThreadLimit" | "speechInstallLimit">;

export class BubbleQuota {
  constructor(private store: KeeperStore) {}

  used(now: number): number {
    const row = this.store.db.prepare("SELECT attempts FROM tavern_dialogue_daily WHERE day=? AND seat=''").get(utcDay(now)) as { attempts: number } | undefined;
    return row?.attempts ?? 0;
  }

  reserve(seat: string, at: number, now: number, limits: Limits = DEFAULT_SETTINGS.tavern) {
    const day = utcDay(now);
    if (!seat || now < at || utcDay(at) !== day) return false;
    return this.store.atomic(() => {
      const { db } = this.store;
      const thread = db.prepare("SELECT attempts, latest FROM tavern_dialogue_daily WHERE day=? AND seat=?").get(day, seat) as { attempts: number; latest: number } | undefined;
      if ((thread && (thread.attempts >= limits.speechThreadLimit || thread.latest >= at)) || this.used(now) >= limits.speechInstallLimit) return false;
      const add = db.prepare(`INSERT INTO tavern_dialogue_daily(day, seat, attempts, latest) VALUES (?, ?, 1, ?)
        ON CONFLICT(day, seat) DO UPDATE SET attempts=attempts+1, latest=excluded.latest`);
      add.run(day, seat, at);
      add.run(day, "", at);
      db.prepare("DELETE FROM tavern_dialogue_daily WHERE day < ?").run(day - 1);
      return true;
    });
  }
}

type Line = { revision: string; text: string | null };
type Pane = (line: Line) => void;
type Watch = { panes: Set<Pane>; seen: string; since: number; flight?: AbortController };

export class DialogueWatches {
  private readonly seats = new Map<string, Watch>();
  constructor(private read: (seat: string) => { scene: StripScene; voice: VoiceMode } | null,
    private reserve: (seat: string, at: number, now: number) => boolean,
    private complete: (scene: StripScene, signal: AbortSignal, reserve: () => boolean) => Promise<string | null>,
    private now = Date.now) {}

  has(seat: string) { return this.seats.has(seat); }

  subscribe(seat: string, pane: Pane) {
    const current = this.read(seat);
    if (!current || current.scene.posture === "gone" || current.voice === "off") return null;
    let watch = this.seats.get(seat);
    if (!watch) {
      if (this.seats.size >= 100) return null;
      watch = { panes: new Set(), seen: current.scene.revision, since: this.now() };
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
    const since = watch.since, now = watch.since = this.now();
    if (watch.flight) { watch.flight.abort(); return; }
    if (!dialogueSlot(scene, voice) || scene.at === null || scene.at < since || scene.at > now) return;
    const at = scene.at;
    const current = () => {
      const state = this.read(seat);
      return state?.scene.revision === scene.revision && state.voice === voice && !!dialogueSlot(state.scene, state.voice);
    };
    const panes = [...watch.panes];
    const publish = (text: string | null) => {
      for (const pane of panes) if (watch.panes.has(pane)) pane({ revision: scene.revision, text });
    };
    const flight = watch.flight = new AbortController();
    try {
      const text = await this.complete(scene, flight.signal, () =>
        !flight.signal.aborted && current() && this.reserve(seat, at, this.now()));
      if (text && !flight.signal.aborted && current()) publish(text);
    } finally {
      if (watch.flight === flight) watch.flight = undefined;
    }
  }
}
