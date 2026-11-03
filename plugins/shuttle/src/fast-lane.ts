// The fast lane: each tick reads the state of the user's PRs with a merge pending, so a merge shows within a
// tick instead of a sync. Each server's pass runs on its own and holds up nothing: not the tick, not a sync,
// not another server. It takes no sync lock, and leaves alone a server that is syncing, still in its last
// pass, or backed off.
import { AdapterError, type PrRead } from "./adapters/adapter";
import type { ServerConfig } from "./config";
import type { SyncFailureKind } from "./contract";
import { errText, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { describeFailure } from "./failures";
import { VIEW_MANY_SIZE } from "./adapters/github";

/** How long after a server took a merge, the PR staying open, Shuttle keeps an eye on it. */
const SENT_WATCH_MS = 24 * 60 * 60_000;
/** A command server reads one PR per command, so a tick asks it about only a few. */
const COMMAND_PRS_PER_TICK = 3;
/** A PR with auto-merge on or in the server's merge queue is read on every tick for its first hour pending… */
const EVERY_TICK_MS = 60 * 60_000;
/** …and then at most this often, since it may wait days for a review. */
const SLOW_READ_MS = 5 * 60_000;

/** Why a server is left alone until its next sync: it limited Shuttle, refused the sign-in, or looks down. */
export type BackOffKind = "rate_limit" | "auth" | "down";

/** One failure is enough here: the fast lane is never urgent enough to ask a struggling server twice. */
const BACK_OFF: Partial<Record<SyncFailureKind, BackOffKind>> = { rate_limit: "rate_limit", auth: "auth", unavailable: "down", network: "down", timeout: "down" };

export interface BackOffs {
  /** Why nothing but the server's next sync may ask it anything, or null when it may be asked. */
  backOff(serverId: string): string | null;
  /** Leaves the server alone until its next sync; `askedAt` is when the read that failed was sent. */
  holdOff(serverId: string, kind: BackOffKind, askedAt: number): void;
}

/** What one server's lane remembers between passes, by PR id. */
interface Lane {
  /** When the fast lane first found the PR pending. */
  since: Map<number, number>;
  /** When it last asked for the PR, whether or not the read went well. */
  tried: Map<number, number>;
  /** PRs whose failed read was logged, so each failure is logged once until a read passes. */
  logged: Set<number>;
}

type Pending = PrRow & { own: number };
type Read = PrRead & { detail?: AdapterError["detail"] };

/** What the user sees of a row; the read times change on every read. */
const shown = ({ fetched_at: _fetched, viewed_at: _viewed, ...rest }: PrRow) => JSON.stringify(rest);

export class FastLane {
  /** Each server's pass under way, by server id. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly lanes = new Map<string, Lane>();

  constructor(
    private readonly ctx: Ctx,
    private readonly backOffs: BackOffs,
  ) {}

  /** Starts a pass on each enabled server that `skip` does not hold back, that is not backed off and whose last pass finished. */
  start(skip: (serverId: string) => boolean, signal?: AbortSignal): void {
    if (signal?.aborted) return;
    for (const server of this.ctx.config().servers) {
      if (!server.enabled || this.running.has(server.id) || skip(server.id) || this.backOffs.backOff(server.id) !== null) continue;
      const run = this.read(server, skip, signal)
        .then((changed) => (changed > 0 ? this.ctx.port.publish() : undefined))
        .catch((error: unknown) => this.ctx.port.log("warn", `fast lane on ${server.id}: ${errText(error)}`))
        .finally(() => this.running.delete(server.id));
      this.running.set(server.id, run);
    }
  }

  /** Resolves once no pass is running. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  /** Reads the server's PRs that are due; returns how many changed. */
  private async read(server: ServerConfig, skip: (serverId: string) => boolean, signal?: AbortSignal): Promise<number> {
    const now = this.ctx.now();
    const rows = this.ctx.store.pendingMergePrs(server.id, now - SENT_WATCH_MS);
    const lane = this.laneOf(server.id, rows, now);
    const last = (pr: Pending) => Math.max(lane.tried.get(pr.id) ?? 0, pr.fetched_at ?? 0);
    // Shuttle's own merges are read on every tick; a server's auto-merge or merge queue slows down after an hour.
    const due = rows
      .filter((pr) => pr.own === 1 || now - lane.since.get(pr.id)! < EVERY_TICK_MS || now - last(pr) >= SLOW_READ_MS)
      .sort((a, b) => last(a) - last(b) || a.id - b.id);
    if (due.length === 0) return 0;
    const adapter = this.ctx.adapter(server.id);
    let changed = 0;
    let stopped = false;
    // A back-off set while the pass ran, by this pass or by a sync, or a sync that took the server, ends it before its next request.
    const ended = () => stopped || signal?.aborted === true || skip(server.id) || this.backOffs.backOff(server.id) !== null;
    const land = (pr: Pending, read: Read) => {
      const result = this.land(server, lane, pr, read, stopped);
      if (result === "changed") changed++;
      if (result === "held") stopped = true;
    };
    if (adapter.viewMany) {
      for (let start = 0; start < due.length && !ended(); start += VIEW_MANY_SIZE) {
        const batch = due.slice(start, start + VIEW_MANY_SIZE);
        for (const pr of batch) lane.tried.set(pr.id, this.ctx.now());
        const refs = batch.map((pr) => ({ repo: pr.repo, number: pr.number }));
        const reads: Read[] = await adapter.viewMany(refs, signal).catch((error: unknown) => refs.map((ref) => failedRead(ref, error)));
        // What came back is landed even after one PR's answer backs the server off: the others' answers are good.
        for (const read of reads) {
          const pr = batch.find((row) => row.repo === read.repo && row.number === read.number);
          if (pr && !signal?.aborted) land(pr, read);
        }
      }
    } else {
      for (const pr of due.slice(0, COMMAND_PRS_PER_TICK)) {
        if (ended()) break;
        lane.tried.set(pr.id, this.ctx.now());
        const ref = { repo: pr.repo, number: pr.number };
        land(pr, await adapter.view(pr.repo, pr.number, signal).then((summary): Read => ({ ...ref, summary, error: null }), (error: unknown) => failedRead(ref, error)));
      }
    }
    return changed;
  }

  /** What the lane keeps of its last pass, for the PRs still pending. */
  private laneOf(serverId: string, rows: readonly Pending[], now: number): Lane {
    const old = this.lanes.get(serverId);
    const lane: Lane = { since: new Map(), tried: new Map(), logged: new Set() };
    for (const pr of rows) {
      lane.since.set(pr.id, old?.since.get(pr.id) ?? now);
      const tried = old?.tried.get(pr.id);
      if (tried !== undefined) lane.tried.set(pr.id, tried);
      if (old?.logged.has(pr.id)) lane.logged.add(pr.id);
    }
    this.lanes.set(serverId, lane);
    return lane;
  }

  /** Stores one read, or the failure: one that says to leave the server alone holds it off, once, and ends the pass. */
  private land(server: ServerConfig, lane: Lane, { own: _own, ...pr }: Pending, read: Read, held: boolean): "changed" | "same" | "failed" | "held" {
    const summary = read.summary;
    if (summary === null) {
      const failure = describeFailure(server, { message: read.error ?? "no answer", ...read.detail });
      const kind = BACK_OFF[failure.kind];
      if (kind !== undefined) {
        if (held) return "held";
        this.backOffs.holdOff(server.id, kind, lane.tried.get(pr.id) ?? this.ctx.now());
        this.ctx.port.log("warn", `fast lane on ${server.id}: ${failure.summary}; Shuttle leaves it until its next sync`);
        return "held";
      }
      this.logOnce(lane, pr, read.error ?? failure.summary);
      return "failed";
    }
    // An answer for another PR must not be stored under this one.
    if (summary.repo.toLowerCase() !== pr.repo.toLowerCase() || summary.number !== pr.number) {
      this.logOnce(lane, pr, `the server answered for ${summary.repo}#${summary.number}`);
      return "failed";
    }
    lane.logged.delete(pr.id);
    const after = this.ctx.store.upsertPr(server.id, { ...summary, repo: pr.repo }, summary.url ?? pr.url, false);
    return shown(after) !== shown(pr) ? "changed" : "same";
  }

  private logOnce(lane: Lane, pr: PrRow, text: string): void {
    if (lane.logged.has(pr.id)) return;
    lane.logged.add(pr.id);
    this.ctx.port.log("warn", `fast lane ${pr.key}: ${text}`);
  }
}

function failedRead(ref: { repo: string; number: number }, error: unknown): Read {
  return { ...ref, summary: null, error: errText(error), ...(error instanceof AdapterError ? { detail: error.detail } : {}) };
}
