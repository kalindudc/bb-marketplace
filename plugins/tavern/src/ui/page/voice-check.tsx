import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { rpcContract } from "../../shared/contract";
import type { CharacterDef } from "../../shared/schema";
import { voiceCheckCharged, type VoiceCheck, type VoiceCheckView, type VoiceDraft } from "../../shared/voice-check";
import { clockTime, ExpandsMark, StateMark, timeAgo, useNow } from "../kit";
import "./voice-check.css";

// The rule each failure broke, in the editor's words. Quoted rules show the offending words after a colon.
const RULE: Record<string, { words: string; quoted: boolean; field: boolean }> = {
  missing: { words: "no answer", quoted: false, field: false },
  shape: { words: "not what the tool takes", quoted: false, field: true },
  "missing-fact": { words: "left out a fact", quoted: true, field: true },
  "voice-not-allowed": { words: "voice where it isn't allowed", quoted: true, field: false },
  exclamation: { words: "an exclamation mark", quoted: true, field: true },
  emoji: { words: "an emoji", quoted: true, field: true },
  shouting: { words: "capitals", quoted: true, field: true },
  "style-word": { words: "the style's own words", quoted: true, field: true },
  speaker: { words: "speaks as the character", quoted: true, field: true },
  "too-long": { words: "too long", quoted: false, field: true },
  tone: { words: "not plain and calm", quoted: true, field: false },
};
const failureWords = (f: VoiceCheck["situations"][number]["failures"][number]) => {
  const r = RULE[f.rule] ?? { words: f.rule, quoted: true, field: true };
  return `${r.words}${r.field ? ` in ${f.field}` : ""}${f.quote ? r.quoted ? `: “${f.quote}”` : ` (${f.quote})` : ""}`;
};
const modelName = (r: VoiceCheck) => r.writer?.name ?? r.writer?.model ?? r.writer?.providerId ?? "the character's model";
// The raw ids, for the title: the readable name is what bb's picker shows, the id is what was called.
const rawId = (who: string, m: VoiceCheck["writer"]) => m ? `${who}: ${m.model ?? "the default model"} (${m.providerId})` : undefined;
const costWords = (c: VoiceCheck["cost"]) => {
  if (!c || (c.usd === null && c.tokens === null)) return null;
  const tokens = c.tokens === null ? null : `${c.tokens.toLocaleString("en-US")} tokens`;
  if (c.usd === null) return `${tokens} · cost not recorded`;
  return `Cost $${c.usd < 0.1 ? c.usd.toFixed(3) : c.usd.toFixed(2)}${tokens ? ` · ${tokens}` : ""}`;
};
const isStale = (r: VoiceCheck, draft: Pick<VoiceDraft, "name" | "style">) => r.draft.name !== draft.name || r.draft.style !== draft.style;

/** The headline for a finished check, as the editor and the sheet both say it. */
export function checkHeadline(r: VoiceCheck, now = Date.now()) {
  const when = timeAgo(r.finishedAt ?? r.startedAt, now);
  const passed = r.situations.filter((s) => s.pass).length, total = r.situations.length;
  if (r.state === "passed") return `Voice check passed${r.tone === "not-judged" ? " on rules only: tone not judged" : ""} · ${passed} of ${total} · ${modelName(r)} · ${when}`;
  if (r.state === "failed") return `Voice check failed · ${passed} of ${total} passed · ${modelName(r)} · ${when}`;
  if (r.state === "couldnt-run") return `Couldn't run the check: ${r.reason ?? "no reason was recorded."}`;
  if (r.state === "cancelled") return `Check cancelled · ${when}`;
  return `Checking 5 situations on ${modelName(r)}…`;
}
type Failure = VoiceCheck["situations"][number]["failures"][number];
const LABEL: Record<string, string> = { status: "Status", headline: "Headline", outcome: "Outcome", evidence: "Evidence", artifacts: "Files", voice: "Voice line", question: "Question", why: "Why",
  kind: "Kind", options: "Options", meanwhile: "Meanwhile", holds: "Holds", boardQuestId: "Quest", left: "Left to do", skipped: "Skipped" };
const ORDER = Object.keys(LABEL);
/** One string with the failed words marked and, past a length limit, the rest dimmed. Matching ignores case, as the rules do. */
function Marked({ text, quotes, limit }: { text: string; quotes: string[]; limit: number | null }) {
  const hits: [number, number][] = [];
  for (const q of quotes) { const lower = text.toLowerCase(), needle = q.toLowerCase(); for (let i = lower.indexOf(needle); needle && i >= 0; i = lower.indexOf(needle, i + needle.length)) hits.push([i, i + needle.length]); }
  hits.sort((a, b) => a[0] - b[0]);
  const cuts = [...new Set([0, text.length, ...(limit !== null && limit < text.length ? [limit] : []), ...hits.flat()])].sort((a, b) => a - b);
  const parts: ReactNode[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [a, b] = [cuts[i]!, cuts[i + 1]!], piece = text.slice(a, b), hit = hits.some(([x, y]) => a >= x && b <= y);
    parts.push(hit ? <mark key={a} className="vc-hit">{piece}</mark> : <Fragment key={a}>{piece}</Fragment>);
  }
  if (limit === null || limit >= text.length) return <>{parts}</>;
  const before: ReactNode[] = [], after: ReactNode[] = [];
  for (let i = 0; i < cuts.length - 1; i++) (cuts[i]! < limit ? before : after).push(parts[i]);
  return <>{before}<span className="vc-over" title={`Past the ${limit}-character limit`}>{after}</span></>;
}
/** A field's value as a line a person reads: lists of evidence, options and skipped steps get their own short forms. */
function lines(key: string, value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value !== "object") return [String(value)];
  if (!Array.isArray(value)) return [JSON.stringify(value)];
  return value.flatMap((v) => {
    if (typeof v !== "object" || v === null) return [String(v)];
    const o = v as Record<string, unknown>;
    if (key === "evidence") return [[o.ref, o.detail, typeof o.exitCode === "number" ? `exit ${o.exitCode}` : null].filter((x) => x !== null && x !== undefined && x !== "").join(" · ")];
    if (key === "options") return [[o.label, o.detail].filter(Boolean).join(": ")];
    if (key === "skipped") return [`${o.waypointId}: ${o.reason}`];
    return [JSON.stringify(v)];
  });
}
/** The answer as labelled lines with the failure marked where it is, and the JSON as sent one fold away. */
function Answer({ answer, failures }: { answer: string | null; failures: Failure[] }) {
  const [raw, setRaw] = useState(false);
  let parsed: Record<string, unknown> | null = null;
  try { const v = answer === null ? null : JSON.parse(answer); parsed = v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { parsed = null; }
  if (answer === null) return <div className="vc-ans"><p className="vc-note">The model gave no answer for this situation.</p></div>;
  const keys = parsed ? [...ORDER.filter((k) => k in parsed!), ...Object.keys(parsed).filter((k) => !ORDER.includes(k))] : [];
  const top = (f: Failure) => f.field.split(".")[0]!;
  return <div className="vc-ans">
    {parsed && <dl className="vc-dl">{keys.map((k) => {
      const shown = lines(k, parsed![k]);
      if (!shown.length) return null;
      const here = failures.filter((f) => top(f) === k || (f.rule === "tone" && f.quote));
      const quotes = here.filter((f) => RULE[f.rule]?.quoted && f.quote).map((f) => f.quote);
      const long = here.find((f) => f.rule === "too-long" && top(f) === k), limit = long ? Number(/of (\d+)/.exec(long.quote)?.[1] ?? NaN) : NaN;
      return <Fragment key={k}><dt>{LABEL[k] ?? k}</dt><dd>{shown.map((t, i) => <span key={i} className="vc-dd-l"><Marked text={t} quotes={quotes} limit={Number.isFinite(limit) && shown.length === 1 ? limit : null} /></span>)}</dd></Fragment>;
    })}</dl>}
    <button type="button" className="lnk-btn act" aria-expanded={raw || !parsed} onClick={() => setRaw(!raw)} disabled={!parsed}><ExpandsMark open={raw || !parsed} /><span>As sent</span></button>
    {(raw || !parsed) && <pre className="tv-code vc-answer">{answer}</pre>}
  </div>;
}
const TONE = { passed: "done", failed: "fail", "couldnt-run": "warn", cancelled: "plain", running: "work" } as const;

/** What a couldn't-run cost, and so whether it counts toward the hourly limit, which guards the user's money. */
function chargeWords(r: VoiceCheck) {
  if (!voiceCheckCharged(r)) return "This run cost nothing and doesn't count toward the hourly limit.";
  const usd = r.cost?.usd;
  return `This run cost ${typeof usd === "number" && usd > 0 ? `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}` : `${(r.cost?.tokens ?? 0).toLocaleString("en-US")} tokens`} and counts toward the hourly limit.`;
}

// Each result keeps its age on its own minute clock: the character page is memoized, so nothing else re-renders it between fetches.
const VOICE_WORD = { light: "Light", off: "Off" } as const;
function Result({ r, voice }: { r: VoiceCheck; voice?: "full" | "light" | "off" }) {
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const cost = r.state === "couldnt-run" ? chargeWords(r) : costWords(r.cost);
  return <>
    <p className="vc-line"><StateMark tone={TONE[r.state]} /><span title={rawId("Writer", r.writer)}>{checkHeadline(r, now)}</span></p>
    {r.state === "failed" && <ul className="vc-fails">{r.situations.filter((s) => !s.pass).map((s) => <li key={s.id} className="vc-fail">
      <button type="button" className="act vc-row" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}><ExpandsMark open={open === s.id} /><span>{s.title}: {s.failures.map(failureWords).join("; ")}</span></button>
      {open === s.id && <Answer answer={s.answer} failures={s.failures} />}
    </li>)}</ul>}
    {(r.state === "passed" || r.state === "failed") && (r.judgeNote ? <p className="vc-note" title={rawId("Judge", r.judge)}>{r.judgeNote}</p> : r.judge && <p className="vc-note" title={rawId("Judge", r.judge)}>Tone judged by {r.judge.name ?? r.judge.model ?? r.judge.providerId}.</p>)}
    {/* The check always tests the full allowance, so a stricter setting says so beside the result. */}
    {(r.state === "passed" || r.state === "failed") && (voice === "light" || voice === "off") && <p className="vc-note" data-full-voice>Checked in full voice, the strictest case; your setting is {VOICE_WORD[voice]}.</p>}
    {cost && <p className="vc-note">{cost}</p>}
    {r.state === "couldnt-run" && r.detail && <>
      <button type="button" className="lnk-btn act" aria-expanded={raw} onClick={() => setRaw(!raw)}><ExpandsMark open={raw} /><span>Error details</span></button>
      {raw && <pre className="tv-code vc-answer">{r.detail}</pre>}
    </>}
  </>;
}

/** In the voice editor beside Save: run the draft as edited, see the latest result, never a gate on Save. */
export function VoiceCheckBox({ characterId, draft, voice }: { characterId: string; draft: VoiceDraft; voice?: "full" | "light" | "off" }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "voiceCheck", input: { characterId } });
  const start = experimental_useRpcMutation({ contract: rpcContract, method: "voiceCheckStart" });
  const cancel = experimental_useRpcMutation({ contract: rpcContract, method: "voiceCheckCancel" });
  const [fresh, setFresh] = useState<VoiceCheckView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => setFresh(null), [query.data]);
  const v = fresh ?? query.data;
  const mine = v?.running?.characterId === characterId ? v.running : null;
  const other = v?.running && !mine ? v.running : null;
  const { refetch } = query;
  useEffect(() => {
    if (!v?.running) return;
    const tick = setInterval(() => setNow(Date.now()), 1000), poll = setInterval(() => void refetch(), 3000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [v?.running, refetch]);
  const latest = v?.history.find((h) => h.state !== "running") ?? null;
  const capped = !!v && v.cap.used >= v.cap.max;
  const run = async () => {
    setProblem(null);
    try { setFresh(await start.mutate({ characterId, draft })); setNow(Date.now()); }
    catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
  };
  // "Try again" only where trying again can help: a model or provider failure. Tavern's own error offers a plain Run check.
  const label = latest?.state === "couldnt-run" && latest.fault !== "tavern" && !isStale(latest, draft) ? "Try again" : "Run check";
  return <section className="tv-grpbox vc" aria-label="Voice check">
    <div className="vc-body" aria-live="polite">
      {mine ? <p className="vc-line"><StateMark tone="work" /><span title={rawId("Writer", mine.writer)}>{checkHeadline(mine)}{"\u00a0"}<span className="vc-nowrap">{Math.max(0, Math.round((now - mine.startedAt) / 1000))}{"\u00a0"}s</span></span></p>
        : latest ? <div className={isStale(latest, draft) ? "vc-stale" : undefined}>{isStale(latest, draft) && <p className="vc-note">Checked an earlier draft.</p>}<Result r={latest} voice={voice} /></div>
        : v ? <p className="vc-line">Not checked yet. Run the check to try this voice on five situations.</p> : null}
      {other && <p className="vc-note">Another voice check is running, for {other.draft.name}.</p>}
      {capped && v.cap.nextAt !== null && <p className="vc-note">{v.cap.max} checks this hour; next at {clockTime(v.cap.nextAt)}.</p>}
    </div>
    <div className="vc-acts">
      {mine ? <button type="button" className="btn" disabled={cancel.isPending} onClick={() => void cancel.mutate({ characterId, runId: mine.id }).then(setFresh).catch((e) => setProblem(String(e)))}><span>Cancel check</span></button>
        : <button type="button" className="btn" disabled={!v || !!other || capped || start.isPending || !draft.name.trim()} onClick={() => void run()}><span>{label}</span></button>}
      <span className="vc-note">Five situations on the model {draft.name || "this character"} works on. Saving never waits for it.</span>
    </div>
    {problem && <p className="tv-problem" role="alert">{problem}</p>}
    {query.error && !v && <p className="tv-problem" role="alert">The voice check's state couldn't be read: {query.error.message}</p>}
  </section>;
}

/** On the character sheet: the latest result for the saved voice, and every check in a fold. */
export function VoiceCheckSummary({ character }: { character: CharacterDef }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "voiceCheck", input: { characterId: character.id } });
  const [open, setOpen] = useState(false);
  const now = useNow();
  const all = query.data?.history.filter((h) => h.state !== "running") ?? [];
  const latest = all[0];
  if (!query.data) return null;
  return <div className="vc-sum">
    <p className="vc-line">{latest ? <><StateMark tone={TONE[latest.state]} /><span>{checkHeadline(latest, now)}{isStale(latest, character) ? " · for an earlier draft" : ""}</span></> : <span>Not checked yet: run the check from Edit voice.</span>}</p>
    {all.length > 1 && <>
      <button type="button" className="lnk-btn act" aria-expanded={open} onClick={() => setOpen(!open)}><ExpandsMark open={open} /><span>All {all.length} checks</span></button>
      {open && <ul className="vc-hist">{all.map((h) => <li key={h.id}><StateMark tone={TONE[h.state]} /><span>{checkHeadline(h, now)}</span></li>)}</ul>}
    </>}
  </div>;
}
