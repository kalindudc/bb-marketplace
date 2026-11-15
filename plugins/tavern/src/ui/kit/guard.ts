import type { BoardQuestDetail } from "../../shared/contract";
import { localTime } from "./primitives";

type MemberScope = NonNullable<BoardQuestDetail["scopes"]>[number];
type Violation = NonNullable<BoardQuestDetail["violations"]>[number];
/** `none`: nothing was recorded, drawn with a neutral dash, never the waiting mark, because nothing is pending. */
export type GuardEvidence = { tone: "done" | "warn" | "bad" | "none"; text: string; title: string };
/** A finished member's guardrail, in three parts that never mix: what was asked for, what the run recorded, and the state now. */
export type GuardRecordWords = { declared: string; evidence: GuardEvidence; now: string | null };

const MODE_ASKED = { enforce: "enforce", watch: "watch, recorded only", off: "off" } as const;

/** The command a block names ("Blocked od -c: …"), short enough to sit in parentheses; null when the reason names none. */
export function blockedWhat(reason: string): string | null {
  const m = /Blocked (.+?): /.exec(reason);
  if (!m || /^tool call$/i.test(m[1]!)) return null;
  const what = m[1]!.trim();
  return what.length <= 48 ? what : `${what.slice(0, 47).replace(/\s+\S*$/, "")}…`;
}

const calls = (n: number) => n === 1 ? "1 call" : `${n} calls`;
const at = (list: readonly Violation[], now: number) => `${list.length > 1 ? "last at" : "at"} ${localTime(Math.max(...list.map(v => v.at)), now)}`;

/**
 * Words for one member's guardrail on a finished record. The mode is what was asked for, never proof that it held; evidence is only
 * what the run recorded (a quiet run leaves none, which proves nothing either way); and the state now never promises a guard will arm later.
 */
export function guardRecordWords(scope: MemberScope, violations: readonly Violation[], opts: { archived?: boolean; now: number }): GuardRecordWords {
  const now = opts.now;
  const mode = scope.mode ?? scope.scope?.mode ?? "enforce";
  const s = scope.scope;
  // No-break spaces inside each part and before each "·": a narrow row breaks only after a separator, so "writes worktree" stays whole.
  const join = (parts: string[]) => parts.map(p => p.replace(/ /g, "\u00a0")).join("\u00a0· ");
  const declared = s ? `Scope asked for: ${join([s.preset, `writes ${s.writes.mode}`, `network ${s.network}`, `GitHub ${s.github}`, MODE_ASKED[mode]])}` : join(["No scope recorded", `${MODE_ASKED[mode]} asked for`]);
  const own = violations.filter(v => v.threadId === scope.threadId);
  const watched = own.filter(v => v.mode === "watch");
  const enforced = own.filter(v => v.mode !== "watch");
  const blocked = enforced.filter(v => v.stopped), failed = enforced.filter(v => !v.stopped);
  const parts: string[] = [];
  let tone: GuardEvidence["tone"] = "none";
  if (blocked.length) {
    const what = blockedWhat(blocked.reduce((a, b) => (b.at > a.at ? b : a)).reason);
    parts.push(`Guard blocked ${calls(blocked.length)} ${at(blocked, now)}${what ? ` (${what})` : ""}`);
    tone = "done";
  }
  if (failed.length) { parts.push(`Tripped a rule ${failed.length === 1 ? "once" : `${failed.length} times`} ${at(failed, now)}, and the stop failed`); tone = "bad"; }
  if (watched.length) { parts.push(`Recorded ${watched.length === 1 ? "1 rule break" : `${watched.length} rule breaks`} ${at(watched, now)}, not stopped`); if (tone === "none") tone = "warn"; }
  const evidence: GuardEvidence = parts.length
    ? { tone, text: parts.join("; "), title: "What the guard recorded during the run. Each event is listed below with its rule." }
    : { tone: "none", text: "No guard evidence recorded", title: "Nothing in this run tripped a rule, or nothing was recorded. That is not proof the guard held, or that it failed." };
  const nowWords = scope.armed ? null : `Not armed: the member's thread ${opts.archived ? "is archived" : "has ended"}`;
  return { declared, evidence, now: nowWords };
}
