import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { rpcContract } from "../../shared/contract";
import type { CharacterServiceRecord } from "../../shared/service-record";
import { Glyph, OpensMark, plural, useToday, verifiedWords } from "../kit";
import { recordDate } from "./service-record";

type Row = CharacterServiceRecord["records"][number];
/** One quest's tale on a character's sheet: its rows for each role the character held there, merged. */
export type TaleRow = {
  questId: string; title: string; short: string; endedAt: number | null; kept: boolean; available: boolean;
  waypoints: { verified: number; total: number; skipped?: number } | null;
  checks: { checks: number; independent: number; sameFamily: number } | null;
};

/**
 * The tales a character came back with: returned quests whose tale was told, one row per quest however many roles it held there.
 * Kept tales first, then newest first, with undated rows after dated ones. Stopped quests never list: they have no tale.
 */
export function talesOf(record: CharacterServiceRecord | null): TaleRow[] {
  const byQuest = new Map<string, TaleRow>();
  for (const r of record?.records ?? []) {
    if (r.phase !== "done" || r.told !== true) continue;
    const row = byQuest.get(r.questId) ?? { questId: r.questId, title: r.title, short: r.short, endedAt: r.endedAt, kept: false, available: true, waypoints: null, checks: null };
    row.kept ||= r.kept === true;
    row.available &&= r.available !== false;
    row.waypoints ??= r.waypoints ?? null;
    if (r.role === "warden" && r.checks) row.checks = { checks: r.checks, independent: r.independentChecks ?? 0, sameFamily: r.sameFamilyChecks ?? 0 };
    byQuest.set(r.questId, row);
  }
  return [...byQuest.values()].sort((a, b) => Number(b.kept) - Number(a.kept) || (b.endedAt ?? -1) - (a.endedAt ?? -1) || a.questId.localeCompare(b.questId));
}

/** Between facts on a row: the no-break space keeps "·" off the start of a wrapped line. */
const SEP = "\u00a0· ";

/** A row's figures, every zero left out: the path, then the character's checks there and their independence. */
export function taleFigures(row: TaleRow): string[] {
  const out: string[] = [];
  const w = row.waypoints;
  // An older record has no skipped count: unknown, never zero, so it adds no skipped clause.
  if (w && w.total > 0) out.push(w.skipped === undefined ? `${w.verified} of ${w.total} verified` : verifiedWords({ verified: w.verified, skipped: w.skipped, total: w.total }));
  const c = row.checks;
  if (c) out.push(c.sameFamily === c.checks ? plural(c.checks, "same-family check") : [plural(c.checks, "check"), c.independent > 0 ? `${c.independent} independent` : null, c.sameFamily > 0 ? `${c.sameFamily} same-family` : null].filter(Boolean).join(", "));
  return out;
}

/**
 * Keep: the user's own choice of what to remember, a control inside a row that opens the tale. It has its own hover, so the row
 * stays unlit while it is hovered. The server's answer is the state; a refusal is said in words.
 */
function KeepButton({ row, characterId, name }: { row: TaleRow; characterId: string; name: string }) {
  const keep = experimental_useRpcMutation({ contract: rpcContract, method: "setTaleKept" });
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = async () => {
    setProblem(null);
    try { await keep.mutate({ questId: row.questId, characterId, kept: !row.kept }); } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
  };
  return <>
    <button type="button" className="tv-keep act" aria-pressed={row.kept} disabled={keep.isPending} onClick={() => void toggle()}
      title={row.kept ? `Kept at the top of ${name}'s tales. Press to let it go back to its date.` : `Keep this tale at the top of ${name}'s tales`}>
      {row.kept && <Glyph name="wax-seal" size={13} />}<span>{row.kept ? "Kept" : "Keep"}</span>
    </button>
    {problem && <span className="tv-problem" role="alert">Couldn’t {row.kept ? "let it go" : "keep it"}: {problem}</span>}
  </>;
}

export function TaleList({ record, characterId, name }: { record: CharacterServiceRecord | null; characterId: string; name: string }) {
  const navigate = useBbNavigate();
  const today = useToday();
  const rows = talesOf(record);
  if (!rows.length) return null;
  const capped = (record?.recordsTotal ?? 0) > (record?.records.length ?? 0);
  return <section className="tv-card tv-tales" aria-labelledby="tv-tales-h">
    <header className="tv-colh"><h2 id="tv-tales-h">Tales</h2><span className="tv-count">{plural(rows.length, "tale")}{capped && " · the newest, and every kept one"}</span></header>
    <ul className="tv-tales-l">{rows.map((row) => {
      const when = row.endedAt === null ? "date not recorded" : recordDate(row.endedAt, today);
      const figures = taleFigures(row);
      const body = (gone: boolean) => <>
        <Glyph name="verified" size={13} className="tv-tale-g" />
        <b className="tv-tale-n" data-content>{row.short}</b>
        <span className="tv-tale-m">
          {figures.length > 0 && <><span className="tv-tale-f num">{figures.join(SEP)}</span><span className="tv-tale-sep" aria-hidden="true">{SEP}</span></>}
          <span className="tv-tale-d tv-tale-when">{when}{gone && `${SEP}tale not available`}</span>
        </span>
      </>;
      return <li key={row.questId} className={`tv-tale-row ${row.kept ? "kept" : ""}`} data-quest={row.questId} data-kept={row.kept || undefined}>
        {row.available
          ? <button type="button" className="tv-tale-open act" onClick={() => navigate.toPluginPanel("tavern", { subPath: `tale/${encodeURIComponent(row.questId)}` })} title={`Open the tale: ${row.title}`}>{body(false)}<OpensMark /></button>
          : <span className="tv-tale-open gone" title={`${row.title}: its quest is gone, so the tale can't open. The counts stay on the record.`}>{body(true)}</span>}
        <KeepButton row={row} characterId={characterId} name={name} />
      </li>;
    })}</ul>
  </section>;
}
