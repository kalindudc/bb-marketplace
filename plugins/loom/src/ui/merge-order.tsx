import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { MergeEntry, MergeOrderView } from "../contract";
import { BUTTON, HEADING, RepoChip, listText, plural } from "./common";

// The merge order of a pull request project: Steps lists the pull requests by the step they merge in, with what each
// waits on and unblocks; By repo lays them out as one lane per repo and one column per step, with a line from each pull
// request to what waits on it. Both read what Loom stored from its last poll, so the tab never asks the forge.

type Tone = "good" | "warn" | "bad" | "muted";
const TONES: Record<Tone, string> = { good: "text-success", warn: "text-warning-text", bad: "text-destructive-text", muted: "text-muted-foreground" };
const CHIP_TONES: Record<Tone, string> = { good: "border-success/45 text-success", warn: "border-warning/45 text-warning-text", bad: "border-destructive/45 text-destructive-text", muted: "border-border-seam text-muted-foreground" };
const CHIP = "inline-block whitespace-nowrap rounded-full border px-1.5 text-[10.5px] leading-4";
const PR_LINK = "cursor-pointer whitespace-nowrap font-mono text-[11.5px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const finished = (entry: MergeEntry) => entry.state === "done" || entry.verdict === "merged_elsewhere";
const keyOrder = (a: MergeEntry, b: MergeEntry) => a.key.localeCompare(b.key, undefined, { numeric: true });
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

interface Signal {
  tone: Tone;
  text: string;
  title?: string;
}

function signalsOf(entry: MergeEntry): Signal[] {
  const out: Signal[] = [];
  if (entry.checks !== null) {
    const { passed, failed, pending } = entry.checks;
    if (failed === 0 && pending === 0) out.push({ tone: "good", text: `✓ ${plural(passed, "check")}` });
    else if (passed > 0) out.push({ tone: "good", text: `✓ ${passed}` });
    if (pending > 0) out.push({ tone: "warn", text: `◌ ${pending} pending` });
    if (failed > 0) out.push({ tone: "bad", text: `✗ ${failed} failing` });
  }
  if (entry.prUrl === null || finished(entry)) return out;
  if (!entry.reviewRead) return [...out, { tone: "muted", text: "review not read", title: "This forge does not tell Loom whether a pull request is a draft or approved." }];
  if (entry.draft === true) out.push({ tone: "muted", text: "draft" });
  if (entry.review === "APPROVED") out.push({ tone: "good", text: "approved" });
  else if (entry.review === "CHANGES_REQUESTED") out.push({ tone: "bad", text: "changes requested" });
  else if (entry.review === "REVIEW_REQUIRED") out.push({ tone: "warn", text: "needs review" });
  else out.push({ tone: "muted", text: "no review yet" });
  return out;
}

function verdictOf(entry: MergeEntry): { tone: Tone; text: string; short: string } {
  const after = listText(entry.waitsOn.map((wait) => wait.key));
  switch (entry.verdict) {
    case "ready":
      return { tone: "good", text: "✓ Ready to merge", short: "✓ ready" };
    case "checks_pass":
      return { tone: "good", text: "✓ Checks pass", short: "✓ checks pass" };
    case "first":
      return { tone: "muted", text: capital(entry.holds.join(", ")), short: entry.holds[0]! };
    case "after":
      return entry.trap ? { tone: "warn", text: `⚠ After ${after}`, short: `⚠ after ${after}` } : { tone: "muted", text: `After ${after}`, short: `after ${after}` };
    case "moving":
      return { tone: "warn", text: `↻ Loom moves it to ${entry.base}`, short: "↻ moving" };
    case "no_pr":
      return { tone: "muted", text: `No pull request yet`, short: "no pull request" };
    case "blocked":
      return { tone: "bad", text: "Blocked", short: "blocked" };
    case "merged":
      return { tone: "muted", text: "✓ Merged", short: "✓ merged" };
    case "merged_elsewhere":
      if (entry.mergedIntoState === "done") return { tone: "warn", text: `⚠ Merged into ${entry.mergedInto}'s branch, which merged since`, short: `⚠ via ${entry.mergedInto}` };
      return { tone: "bad", text: entry.mergedInto === null ? `! Merged outside ${entry.base}` : `! Merged into ${entry.mergedInto}'s branch`, short: entry.mergedInto === null ? "! wrong branch" : `! into ${entry.mergedInto}` };
  }
}

const prRef = (number: string | null) => (number === null ? "" : ` (#${number})`);
/** "#123", or words for a pull request whose URL ends in no number. */
const prName = (number: string | null) => (number === null ? "its pull request" : `#${number}`);

/** What the pull request waits on, what it unblocks, and anything else a reader needs to act on it, in sentences. */
function relationOf(entry: MergeEntry, byKey: ReadonlyMap<string, MergeEntry>): string {
  const parts: string[] = [];
  if (entry.verdict === "merged_elsewhere") {
    const into = entry.mergedInto === null ? null : byKey.get(entry.mergedInto);
    if (into === undefined || into === null) parts.push(`It merged into a branch other than ${entry.base}, so its change is not on ${entry.base}.`);
    else if (into.state === "done") parts.push(`It merged into ${into.key}'s branch${prRef(into.prNumber)}, which has merged since, so its change may be on ${entry.base} through it. Check ${entry.base}, then cancel or requeue ${entry.key}.`);
    else parts.push(`It merged into ${into.key}'s branch${prRef(into.prNumber)}, which has not merged, so its change is not on ${entry.base}.`);
  }
  if (entry.verdict === "blocked" && entry.blockedReason !== null) parts.push(entry.blockedReason);
  for (const wait of entry.waitsOn) {
    if (wait.why === "stacked") parts.push(`↳ Builds on ${wait.key}'s branch${prRef(wait.prNumber)}. When that merges, Loom moves it to ${entry.base} and runs its checks again.`);
    else if (wait.repo !== entry.repo) parts.push(`Waits on ${wait.key}${prRef(wait.prNumber)} in ${wait.repo ?? "the project's repo"}: another repo, so not stacked. Merge that one first.`);
    else parts.push(`${wait.why === "merge_after" ? "Merges after" : "Waits on"} ${wait.key}${prRef(wait.prNumber)}.`);
  }
  if (entry.verdict === "moving") parts.push(`The pull request it was stacked on merged. Wait for Loom to move it to ${entry.base} and run its checks again.`);
  if (entry.verdict === "checks_pass") parts.push(entry.reviewRead ? "The forge did not say it is approved and not a draft, so Loom can't call it ready; it may need no review." : "Loom can't read its review or draft state through this forge.");
  if (entry.elsewhere !== null && entry.verdict === "first") parts.push(`It targets ${entry.elsewhere}, which is neither ${entry.base} nor another ticket's branch, so merging it would not put it on ${entry.base}.`);
  if (!finished(entry) && entry.unblocks.length > 0) parts.push(`Unblocks ${listText(entry.unblocks)}.`);
  return parts.join(" ");
}

/** The tab's opening sentence: how much is open, how many steps, and what holds the first step. */
export function mergeLead(order: MergeOrderView): string {
  const open = order.entries.filter((entry) => entry.prOpen);
  const noPr = order.entries.filter((entry) => entry.prUrl === null && !finished(entry) && entry.state !== "blocked");
  if (open.length === 0) return noPr.length === 0 ? "No pull request is open." : `No pull request is open yet; ${plural(noPr.length, "ticket")} ${noPr.length === 1 ? "has" : "have"} none.`;
  const repos = new Set(open.map((entry) => entry.repo));
  const first = open.filter((entry) => entry.step === 1 && entry.verdict !== "blocked");
  const count = (test: (entry: MergeEntry) => boolean) => first.filter(test).length;
  const holding = (test: (hold: string) => boolean) => count((entry) => entry.verdict === "first" && entry.holds.some(test));
  const its = (n: number) => (n === 1 ? "its" : "their");
  const reasons = (
    [
      [holding((hold) => hold.startsWith("targets ")), (n: number) => `${n} ${n === 1 ? "targets" : "target"} a branch other than ${its(n)} base`],
      [holding((hold) => hold === "needs review" || hold === "changes requested"), (n: number) => `${n} need${n === 1 ? "s" : ""} a review`],
      [holding((hold) => hold === "draft"), (n: number) => `${n} ${n === 1 ? "is a draft" : "are drafts"}`],
      [holding((hold) => hold.endsWith("pending")), (n: number) => `${n} wait${n === 1 ? "s" : ""} on checks`],
      [holding((hold) => hold.endsWith("failing")), (n: number) => `${n} ${n === 1 ? "has" : "have"} failing checks`],
      [holding((hold) => hold === "checks not read"), (n: number) => `${n} ${n === 1 ? "has" : "have"} checks Loom does not read`],
      [holding((hold) => hold === "Loom is pushing a fix"), (n: number) => `${n} ${n === 1 ? "gets" : "get"} a fix from Loom`],
      [count((entry) => entry.verdict === "moving"), (n: number) => `Loom is moving ${n} to ${its(n)} base`],
      [count((entry) => entry.verdict === "checks_pass"), (n: number) => `${n} pass${n === 1 ? "es" : ""} ${its(n)} checks with no approval Loom can read`],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, text]) => text(n));
  const ready = first.filter((entry) => entry.verdict === "ready").length;
  const where = repos.size > 1 ? ` in ${repos.size} repos` : "";
  const firstText = `${first.length} ${first.length === 1 ? "has" : "have"} nothing before ${first.length === 1 ? "it" : "them"}`;
  const rest = ready > 0 ? `, and ${ready} ${ready === 1 ? "is" : "are"} ready to merge now.` : reasons.length > 0 ? `; none is ready yet: ${listText(reasons)}.` : ".";
  const tail = noPr.length > 0 ? ` ${plural(noPr.length, "ticket")} ${noPr.length === 1 ? "has" : "have"} no pull request yet.` : "";
  return `${plural(open.length, "open pull request")}${where} merge${open.length === 1 ? "s" : ""} in ${plural(order.steps, "step")}. ${firstText}${rest}${tail}`;
}

function Callouts({ order, onOpen }: { order: MergeOrderView; onOpen(url: string): void }) {
  const byKey = new Map(order.entries.map((entry) => [entry.key, entry]));
  const wrong = order.entries.filter((entry) => entry.verdict === "merged_elsewhere");
  const traps = order.entries.filter((entry) => entry.trap);
  const named = wrong[0]?.key;
  const trapLine = (entry: MergeEntry) => {
    const parent = byKey.get(entry.stackedOn!);
    return `${capital(prName(entry.prNumber))} (${entry.key}) targets ${entry.stackedOn}'s branch. Merge${parent?.prNumber == null ? "" : ` #${parent.prNumber}`} (${entry.stackedOn}) first.`;
  };
  return (
    <>
      {wrong.map((entry) => {
        const into = entry.mergedInto === null ? null : (byKey.get(entry.mergedInto) ?? null);
        // Once the ticket whose branch it went into merged too, the change may be on the base through it.
        const since = into !== null && into.state === "done";
        const tone = since ? "bg-warning/10 text-warning-text shadow-[inset_3px_0_0_var(--warning)]" : "bg-destructive/10 text-destructive-text shadow-[inset_3px_0_0_var(--destructive-text)]";
        const how = entry.state === "done" ? `Loom counted ${entry.key} as done before it checked where a pull request merged.` : `Loom blocked ${entry.key}.`;
        return (
          <div key={entry.key} role={since ? "note" : "alert"} data-merged-elsewhere={entry.key} className={`mt-2.5 flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-xs ${tone}`}>
            <span aria-hidden>{since ? "⚠" : "!"}</span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {entry.key}'s pull request{entry.prNumber === null ? "" : ` #${entry.prNumber}`} merged into {into === null ? "another branch" : `${into.key}'s branch`}, not {entry.base}.
              </p>
              <p>
                {since
                  ? `${into.key}${prRef(into.prNumber)} has merged since, so the change may be on ${entry.base} through it, unless its branch dropped it first. ${how} Check ${entry.base}, then cancel or requeue ${entry.key}.`
                  : `${into === null ? "" : `${into.key}${prRef(into.prNumber)} has not merged, so the change is not on ${entry.base}. `}${how} Put the change on ${entry.base} again, for example in a new ticket.`}
              </p>
            </div>
            {entry.prUrl !== null && (
              <button type="button" className={BUTTON} onClick={() => onOpen(entry.prUrl!)}>
                Open {prName(entry.prNumber)}
              </button>
            )}
          </div>
        );
      })}
      {traps.length > 0 && (
        <div role="alert" data-merge-trap className="mt-2.5 flex items-start gap-2.5 rounded-lg bg-warning/10 px-3 py-2.5 text-xs text-warning-text shadow-[inset_3px_0_0_var(--warning)]">
          <span aria-hidden>⚠</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              The forge shows {traps.length === 1 ? `${prName(traps[0]!.prNumber)} (${traps[0]!.key})` : `${traps.length} stacked pull requests`} as approved. Don't merge {traps.length === 1 ? "it" : "them"} yet.
            </p>
            {traps.length === 1 ? (
              <p>
                {trapLine(traps[0]!)} Merging it now puts it into that branch, not {traps[0]!.base}
                {named === undefined ? "" : `, the way ${named} went`}.
              </p>
            ) : (
              <>
                <p>Merging one now puts it into the branch it builds on, not {traps[0]!.base}.</p>
                <ul className="mt-1 list-disc pl-4">
                  {traps.map((entry) => (
                    <li key={entry.key}>{trapLine(entry)}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Chips({ entry }: { entry: MergeEntry }) {
  return (
    <>
      {signalsOf(entry).map((signal) => (
        <span key={signal.text} title={signal.title} className={`${CHIP} ${CHIP_TONES[signal.tone]}`}>
          {signal.text}
        </span>
      ))}
    </>
  );
}

interface Actions {
  onTicket(key: string): void;
  onOpen(url: string): void;
}

function StepRow({ entry, byKey, onTicket, onOpen }: { entry: MergeEntry; byKey: ReadonlyMap<string, MergeEntry> } & Actions) {
  const verdict = verdictOf(entry);
  const relation = relationOf(entry, byKey);
  return (
    <div data-merge-row={entry.key} className="flex flex-col gap-1 border-b border-border-seam px-1.5 py-2 text-xs hover:bg-state-hover @3xl:grid @3xl:grid-cols-[15rem_minmax(0,1fr)_auto_12.5rem] @3xl:items-baseline @3xl:gap-x-3 @3xl:gap-y-0.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
        {entry.stackedOn !== null && (
          <span aria-hidden className="w-3 font-mono text-subtle-foreground">
            ↳
          </span>
        )}
        <button type="button" onClick={() => onTicket(entry.key)} className="cursor-pointer font-semibold hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {entry.key}
        </button>
        {entry.repo !== null && <RepoChip name={entry.repo} />}
        {entry.prUrl !== null && (
          <button type="button" aria-label={`Open ${entry.key}'s pull request`} className={PR_LINK} onClick={() => onOpen(entry.prUrl!)}>
            #{entry.prNumber ?? "PR"}
          </button>
        )}
      </div>
      <span title={entry.title} className="min-w-0 @3xl:truncate">
        {entry.title}
      </span>
      <span className="flex flex-wrap gap-1 @3xl:justify-end">
        <Chips entry={entry} />
      </span>
      <span data-merge-verdict={entry.verdict} className={`font-medium ${TONES[verdict.tone]}`}>
        {verdict.text}
      </span>
      {relation !== "" && <p className="text-[11.5px] text-muted-foreground @3xl:col-start-2 @3xl:col-end-5">{relation}</p>}
    </div>
  );
}

/** "3 pull requests", or "2 pull requests, 1 ticket without one yet" when some ticket has none. */
function countLabel(entries: readonly MergeEntry[]): string {
  const prs = entries.filter((entry) => entry.prUrl !== null).length;
  const without = entries.length - prs;
  if (without === 0) return plural(prs, "pull request");
  return prs === 0 ? `${plural(without, "ticket")} without a pull request yet` : `${plural(prs, "pull request")}, ${plural(without, "ticket")} without one yet`;
}

function StepsView({ order, ...actions }: { order: MergeOrderView } & Actions) {
  const byKey = new Map(order.entries.map((entry) => [entry.key, entry]));
  const lane = (entry: MergeEntry) => order.repos.indexOf(entry.repo);
  const sorted = (entries: MergeEntry[]) => entries.sort((a, b) => lane(a) - lane(b) || keyOrder(a, b));
  const open = order.entries.filter((entry) => !finished(entry));
  const groups = [
    ...Array.from({ length: order.steps }, (_, index) => ({
      id: `step-${index + 1}`,
      title: index === 0 ? "Step 1 · merge first" : `Step ${index + 1}`,
      hint: index === 0 ? "nothing before them" : "each after the pull requests it names",
      entries: sorted(open.filter((entry) => entry.step === index + 1)),
    })),
    { id: "merged", title: "Merged", hint: "", entries: sorted(order.entries.filter(finished)) },
  ].filter((group) => group.entries.length > 0);
  return (
    <div data-merge-steps>
      {groups.map((group) => (
        <section key={group.id} data-merge-step={group.id} aria-label={group.title} className="mt-4">
          <div className="flex items-baseline gap-2 border-b border-border-seam pb-1">
            <h3 className={HEADING}>{group.title}</h3>
            {group.hint !== "" && <span className="text-[11px] text-subtle-foreground">{group.hint}</span>}
            <span className="ml-auto text-[11px] text-subtle-foreground">{countLabel(group.entries)}</span>
          </div>
          {group.entries.map((entry) => (
            <StepRow key={entry.key} entry={entry} byKey={byKey} {...actions} />
          ))}
        </section>
      ))}
    </div>
  );
}

interface Edge {
  from: string;
  to: string;
  kind: "stacked" | "order" | "wrong";
  d: string;
}

/** Everything a pull request waits on and everything that waits on it, itself included. */
function chainOf(byKey: ReadonlyMap<string, MergeEntry>, key: string): Set<string> {
  const out = new Set([key]);
  const walk = (next: (entry: MergeEntry) => string[], at: string) => {
    for (const other of next(byKey.get(at)!)) {
      if (out.has(other) || !byKey.has(other)) continue;
      out.add(other);
      walk(next, other);
    }
  };
  walk((entry) => entry.waitsOn.map((wait) => wait.key).concat(entry.mergedInto === null ? [] : [entry.mergedInto]), key);
  walk((entry) => entry.unblocks, key);
  return out;
}

function GraphView({ order, onTicket, onOpen }: { order: MergeOrderView } & Actions) {
  const byKey = new Map(order.entries.map((entry) => [entry.key, entry]));
  const [hover, setHover] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [edges, setEdges] = useState<Edge[]>([]);
  const grid = useRef<HTMLDivElement>(null);
  const columns = [...(order.entries.some(finished) ? [0] : []), ...Array.from({ length: Math.max(1, order.steps) }, (_, index) => index + 1)];
  const lanes = order.repos.filter((repo) => order.entries.some((entry) => entry.repo === repo));
  const columnOf = (entry: MergeEntry) => (finished(entry) ? 0 : entry.step);

  const measure = useCallback(() => {
    const root = grid.current;
    if (root === null) return;
    const box = root.getBoundingClientRect();
    const cards = new Map([...root.querySelectorAll<HTMLElement>("[data-merge-card]")].map((card) => [card.dataset.mergeCard!, card]));
    const at = (key: string) => {
      const card = cards.get(key);
      if (card === undefined) return null;
      const rect = card.getBoundingClientRect();
      return { left: rect.left - box.left, right: rect.right - box.left, y: rect.top - box.top + 16 };
    };
    const path = (a: { right: number; y: number }, b: { left: number; y: number }) => {
      const dx = Math.max(24, (b.left - a.right) / 2);
      return `M${a.right} ${a.y} C${a.right + dx} ${a.y}, ${b.left - dx} ${b.y}, ${b.left} ${b.y}`;
    };
    const next: Edge[] = [];
    for (const entry of order.entries) {
      for (const wait of entry.waitsOn) {
        const a = at(wait.key);
        const b = at(entry.key);
        if (a !== null && b !== null) next.push({ from: wait.key, to: entry.key, kind: wait.why === "stacked" ? "stacked" : "order", d: path(a, b) });
      }
      // A merge into another ticket's branch points from the merged one into that branch, which sits to its right.
      if (entry.mergedInto !== null) {
        const a = at(entry.key);
        const b = at(entry.mergedInto);
        if (a !== null && b !== null) next.push({ from: entry.mergedInto, to: entry.key, kind: "wrong", d: path(a, b) });
      }
    }
    setEdges(next);
  }, [order]);

  useLayoutEffect(() => {
    measure();
    const root = grid.current;
    if (root === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure]);

  const focus = hover ?? chosen;
  const chain = focus === null || !byKey.has(focus) ? null : chainOf(byKey, focus);
  const picked = chosen === null ? undefined : byKey.get(chosen);
  const STROKES = { stacked: "stroke-subtle-foreground", order: "stroke-primary [stroke-dasharray:4_4]", wrong: "stroke-destructive" };
  return (
    <div data-merge-graph>
      <div className="mt-3.5 overflow-x-auto">
        <div ref={grid} className="relative grid min-w-max" style={{ gridTemplateColumns: `7.5rem repeat(${columns.length}, max-content)` }}>
          <div />
          {columns.map((column) => (
            <div key={column} className={`${HEADING} px-2 pb-1.5`}>
              {column === 0 ? "Merged" : column === 1 ? "Step 1 · first" : `Step ${column}`}
            </div>
          ))}
          {lanes.map((lane) => (
            <div key={lane ?? "repo"} className="contents">
              <div className="border-t border-border-seam py-2.5 pr-2">{lane !== null && <RepoChip name={lane} />}</div>
              {columns.map((column) => (
                <div key={column} className="flex flex-col gap-2 border-t border-border-seam p-2">
                  {order.entries
                    .filter((entry) => entry.repo === lane && columnOf(entry) === column)
                    .sort(keyOrder)
                    .map((entry) => {
                      const verdict = verdictOf(entry);
                      const dim = chain !== null && !chain.has(entry.key);
                      return (
                        <button
                          type="button"
                          key={entry.key}
                          data-merge-card={entry.key}
                          aria-pressed={chosen === entry.key}
                          onMouseEnter={() => setHover(entry.key)}
                          onMouseLeave={() => setHover(null)}
                          onFocus={() => setHover(entry.key)}
                          onBlur={() => setHover(null)}
                          onClick={() => setChosen((before) => (before === entry.key ? null : entry.key))}
                          className={`relative z-[1] w-[11.5rem] cursor-pointer rounded-lg border px-2.5 py-1.5 text-left text-xs transition-opacity hover:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                            entry.verdict === "merged_elsewhere" && entry.mergedIntoState !== "done" ? "border-destructive" : chosen === entry.key ? "border-primary" : "border-border-seam"
                          } ${finished(entry) ? "border-dashed bg-transparent" : "bg-card"} ${dim ? "opacity-30" : ""}`}
                        >
                          <span className="flex items-baseline gap-1.5">
                            <b className="font-semibold whitespace-nowrap">{entry.key}</b>
                            {entry.prNumber !== null && <span className="font-mono text-[11px] text-primary">#{entry.prNumber}</span>}
                          </span>
                          <span className={`mt-px block text-[11px] font-semibold [overflow-wrap:anywhere] ${TONES[verdict.tone]}`}>{verdict.short}</span>
                          <span className="mt-0.5 line-clamp-2 text-[11.5px] text-muted-foreground">{entry.title}</span>
                          <span className="mt-1 flex flex-wrap gap-0.5">
                            <Chips entry={entry} />
                          </span>
                        </button>
                      );
                    })}
                </div>
              ))}
            </div>
          ))}
          <svg aria-hidden className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible">
            {edges.map((edge) => {
              const on = chain !== null && chain.has(edge.from) && chain.has(edge.to);
              return <path key={`${edge.from}-${edge.to}-${edge.kind}`} d={edge.d} fill="none" strokeWidth={on ? 2.25 : 1.5} className={`${STROKES[edge.kind]} ${chain !== null && !on ? "opacity-15" : ""}`} />;
            })}
          </svg>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
        <span>
          <svg aria-hidden width="28" height="8" className="mr-1 inline align-middle">
            <path d="M0 4H28" className="stroke-subtle-foreground" strokeWidth="1.5" />
          </svg>
          stacked: builds on that pull request's branch
        </span>
        <span>
          <svg aria-hidden width="28" height="8" className="mr-1 inline align-middle">
            <path d="M0 4H28" className="stroke-primary [stroke-dasharray:4_4]" strokeWidth="1.5" />
          </svg>
          waits on it, not stacked on its branch
        </span>
        <span>
          <svg aria-hidden width="28" height="8" className="mr-1 inline align-middle">
            <path d="M0 4H28" className="stroke-destructive" strokeWidth="1.5" />
          </svg>
          merged into that branch instead of its base
        </span>
      </div>
      {picked === undefined ? (
        <p className="mt-2.5 text-xs text-muted-foreground">Hover a pull request to see what it waits on and what waits on it; click one for what to do with it.</p>
      ) : (
        <div data-merge-detail={picked.key} className="mt-3 rounded-lg border border-border-seam px-3 py-2.5 text-xs">
          <p className="flex flex-wrap items-baseline gap-1.5">
            <b className="font-semibold">{picked.key}</b>
            {picked.repo !== null && <RepoChip name={picked.repo} />}
            <span>{picked.title}</span>
          </p>
          <p className={`mt-1.5 font-medium ${TONES[verdictOf(picked).tone]}`}>{verdictOf(picked).text}</p>
          {relationOf(picked, byKey) !== "" && <p className="mt-0.5 text-muted-foreground">{relationOf(picked, byKey)}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {picked.prUrl !== null && (
              <button type="button" className={BUTTON} onClick={() => onOpen(picked.prUrl!)}>
                Open pull request
              </button>
            )}
            <button type="button" className={BUTTON} onClick={() => onTicket(picked.key)}>
              Open ticket
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MergeOrderTab({ order, onTicket }: { order: MergeOrderView | null; onTicket(key: string): void }) {
  const navigate = useBbNavigate();
  const [layout, setLayout] = useState<"steps" | "graph">("steps");
  if (order === null) return <p className="p-4 text-sm text-muted-foreground">The merge order shows the project as it is now. Go back to now to read it.</p>;
  const onOpen = (url: string) => navigate.openUrl(url);
  return (
    <div data-merge-order className="@container px-4 pt-3.5 pb-5">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-64 flex-1">
          <h2 className="text-sm font-semibold">Merge order</h2>
          <p data-merge-lead className="mt-0.5 max-w-[70rem] text-xs text-muted-foreground">
            {mergeLead(order)}
          </p>
        </div>
        <span role="group" aria-label="Merge order layout" className="inline-flex overflow-hidden rounded-md border border-border-seam text-xs">
          {(
            [
              ["steps", "Steps"],
              ["graph", "By repo"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={layout === value} onClick={() => setLayout(value)} className={`cursor-pointer px-2.5 py-1 ${layout === value ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
              {label}
            </button>
          ))}
        </span>
      </div>
      <Callouts order={order} onOpen={onOpen} />
      {layout === "steps" ? <StepsView order={order} onTicket={onTicket} onOpen={onOpen} /> : <GraphView order={order} onTicket={onTicket} onOpen={onOpen} />}
    </div>
  );
}
