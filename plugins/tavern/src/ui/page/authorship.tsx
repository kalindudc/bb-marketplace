import { experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import { CHARACTER_PRESENTATION_PROBLEM_PREFIX, type CharacterAuthorship, type CharacterReportVoices } from "../../shared/character-presentation";
import type { CharacterDef } from "../../shared/schema";
import type { VoiceCheck } from "../../shared/voice-check";
import { Glyph, useToday } from "../kit";
import { InlineLink } from "./common";
import { reportsTitle, useOpenReports } from "./reports";
import { recordDate } from "./service-record";

/**
 * The seal a voice keeps from its latest finished check, when that check passed the saved voice. A pass whose tone no model
 * judged rests on rules only, so it says so and carries no seal mark. A failed, cancelled or older-draft check leaves no seal.
 */
export function sealOf(history: readonly VoiceCheck[], character: Pick<CharacterDef, "name" | "style">): { full: boolean; at: number; passed: number; total: number } | null {
  const latest = history.find((h) => h.state !== "running");
  if (!latest || latest.state !== "passed" || latest.finishedAt === null) return null;
  if (latest.draft.name !== character.name || latest.draft.style !== character.style) return null;
  return { full: latest.tone === "judged", at: latest.finishedAt, passed: latest.situations.filter((s) => s.pass).length, total: latest.situations.length };
}

export function VoiceSeal({ character }: { character: CharacterDef }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "voiceCheck", input: { characterId: character.id } });
  const today = useToday();
  const seal = query.data ? sealOf(query.data.history, character) : null;
  if (!seal) return null;
  const when = recordDate(seal.at, today);
  return seal.full
    ? <span className="tv-seal" data-seal="full" title="The latest voice check passed, with its tone judged by a model from another family"><Glyph name="wax-seal" size={14} /><span>Voice checked {when}, {seal.passed} of {seal.total}</span></span>
    : <span className="tv-seal" data-seal="rules" title="The latest voice check passed on rules only: no model judged its tone"><span>Rules checked {when}, {seal.passed} of {seal.total} · tone not judged</span></span>;
}

/**
 * "Your character" for a file that isn't shipped with Tavern. The date is the file's change time, which measures the file, not who
 * edited it, so it says "file changed" and never "you edited". A shipped character, or one with no entry, says nothing.
 */
type Problem = { path: string; message: string };
/** A registry problem about how a character is presented (its file's date, its report lines), not about loading it. */
export const isPresentationProblem = (p: Problem) => p.message.startsWith(CHARACTER_PRESENTATION_PROBLEM_PREFIX);
const REPORTS_PATH = "reports";

/**
 * What couldn't be read, said quietly where it is missing rather than as a page alert: the rest of the registry is fine. On a
 * sheet only that character's own problems and the report lines; on the sheets page each once, naming whose file.
 */
export function PresentationProblems({ problems, characters, only }: { problems: readonly Problem[]; characters: readonly Pick<CharacterDef, "source" | "name">[]; only?: Pick<CharacterDef, "source"> }) {
  const mine = problems.filter(isPresentationProblem).filter((p) => !only || p.path === only.source || p.path === REPORTS_PATH);
  if (!mine.length) return null;
  const what = (p: Problem) => {
    if (p.path === REPORTS_PATH) return "the lines said in reports";
    if (only) return "when this file last changed";
    const who = characters.find((c) => c.source === p.path);
    return who ? `when ${who.name}'s file last changed` : "when a character's file last changed";
  };
  // The raw error (an errno, a home path) is one step away, in the title: noise on the sheet, and it would leak into screenshots.
  return <>{mine.map((p, i) => <p key={`${p.path}:${i}`} className="m small tv-presprob" data-presentation-problem title={p.message.slice(CHARACTER_PRESENTATION_PROBLEM_PREFIX.length)}>Couldn’t read {what(p)}.</p>)}</>;
}

export function YourCharacter({ authorship }: { authorship: CharacterAuthorship | undefined }) {
  const today = useToday();
  if (!authorship || authorship.source === "shipped") return null;
  const where = authorship.source === "project" ? "this project's file" : "file";
  return <span className="tv-yours" data-yours={authorship.source}><b>Your character</b>{authorship.changedAt !== null && <> · {where} changed {recordDate(authorship.changedAt, today)}</>}{authorship.changedAt === null && authorship.source === "project" && <> · this project's file</>}</span>;
}

export type ReportVoice = CharacterReportVoices["voices"][number];
/**
 * The last lines the agent wrote in this character's voice with a done report, newest first: never a stock line. Each opens its
 * report in the side panel, or the quest's page when bb declines the panel; a deleted thread keeps its line and date with no link.
 */
export function ReportVoices({ voices, name, questShort }: { voices: readonly ReportVoice[]; name: string; questShort: (questId: string) => string }) {
  const today = useToday();
  const openReports = useOpenReports();
  const navigate = useBbNavigate();
  if (!voices.length) return null;
  return <section className="tv-saidin" aria-labelledby="tv-saidin-h">
    <div className="lbl" id="tv-saidin-h" title="Written by the agent in this character's voice, with its done report">Said in a report</div>
    <ul className="tv-saidin-l">{voices.slice(0, 3).map((v) => {
      const when = recordDate(v.at, today);
      const open = v.threadId && v.questId ? () => { if (!openReports({ questId: v.questId!, memberThreadId: v.threadId!, reportId: v.reportId }, reportsTitle(name, questShort(v.questId!)))) navigate.toPluginPanel("tavern", { subPath: `quest/${encodeURIComponent(v.questId!)}` }); } : null;
      return <li key={v.reportId} data-report={v.reportId}>
        <span className="tv-voice" data-content>{v.line}</span>
        {open ? <InlineLink onClick={open} title={`Open the report from ${when}`}>{when}</InlineLink> : <span className="m" title="Its thread was deleted, so the report can't open">{when}</span>}
      </li>;
    })}</ul>
  </section>;
}
