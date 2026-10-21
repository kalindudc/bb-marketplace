import { useState, type ReactNode } from "react";
import type { SpecVersionView } from "../contract";
import { changedAt, dependencyChain, wavesOf } from "../spec-paths";
import { BUTTON, HEADING, plural } from "./common";
import { Noteable, modelLabel } from "./spec-marks";
import { CHIP } from "./spec-tickets";

const Section = ({ children }: { children: ReactNode }) => <h4 className={`${HEADING} pt-2`}>{children}</h4>;
const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-xs [overflow-wrap:anywhere]">{children}</code>;
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The folder a path sits in: everything before its first wildcard segment, or before its file name. */
function splitPath(glob: string): { folder: string; name: string } {
  const parts = glob.replace(/^\.\//, "").split("/");
  const wild = parts.findIndex((part) => /[*?[{]/.test(part));
  const cut = wild === -1 ? parts.length - 1 : wild;
  return { folder: parts.slice(0, cut).join("/"), name: parts.slice(cut).join("/") };
}

function TicketChip({ name, on, onPick }: { name: string; on: boolean; onPick(ref: string): void }) {
  return (
    <button
      type="button"
      data-ticket-chip
      aria-pressed={on}
      onClick={() => onPick(name)}
      className={`cursor-pointer rounded-full border px-2 text-[11px] leading-5 [overflow-wrap:anywhere] ${on ? "border-primary bg-surface-selected text-foreground" : "border-border-seam text-muted-foreground hover:bg-state-hover hover:text-foreground"}`}
    >
      {name}
    </button>
  );
}

interface SharedRow {
  glob: string;
  tickets: string[];
  /** The note's spec paths: the scope entries of the tickets that list this path, then the overlapping entries of the others. */
  paths: string[];
  order: string;
  loose: boolean;
}

/** The paths two or more tickets share, each with whether its tickets run in order or one at a time. */
function sharedRows(view: SpecVersionView, rank: (a: string, b: string) => number): SharedRow[] {
  const { spec } = view;
  const tickets = new Map<string, Set<string>>();
  const add = (glob: string, refs: readonly string[]) => {
    const set = tickets.get(glob) ?? new Set<string>();
    for (const ref of refs) set.add(ref);
    tickets.set(glob, set);
  };
  const listers = new Map<string, string[]>();
  for (const ticket of spec.ticket) for (const glob of new Set(ticket.scope)) listers.set(glob, [...(listers.get(glob) ?? []), ticket.ref]);
  for (const [glob, refs] of listers) if (refs.length > 1) add(glob, refs);
  for (const overlap of view.overlaps) for (const glob of overlap.paths) add(glob, [overlap.a, overlap.b, ...(listers.get(glob) ?? [])]);

  const scopeOf = new Map(spec.ticket.map((ticket) => [ticket.ref, ticket.scope]));
  const upstream = new Map(spec.ticket.map((ticket) => [ticket.ref, new Set(dependencyChain(spec.ticket, ticket.ref).up)]));
  const ordered = (a: string, b: string) => upstream.get(a)!.has(b) || upstream.get(b)!.has(a);
  return [...tickets]
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([glob, set]) => {
      const refs = [...set].sort(rank);
      const entries = (ref: string, keep: (entry: string) => boolean) => scopeOf.get(ref)!.flatMap((entry, index) => (keep(entry) ? [`ticket[${ref}].scope[${index}]`] : []));
      const own = refs.flatMap((ref) => entries(ref, (entry) => entry === glob));
      const related = refs
        .filter((ref) => !scopeOf.get(ref)!.includes(glob))
        .flatMap((ref) => entries(ref, (entry) => view.overlaps.some((overlap) => (overlap.a === ref || overlap.b === ref) && overlap.paths.includes(glob) && overlap.paths.includes(entry))));
      const pairs = refs.flatMap((a, index) => refs.slice(index + 1).map((b) => [a, b] as const));
      const loose = pairs.filter(([a, b]) => !ordered(a, b));
      const named = loose.map(([a, b]) => `${a} and ${b}`);
      const order =
        loose.length === 0
          ? `in order: ${refs.join(", then ")}`
          : loose.length === pairs.length
            ? "no order between them, so they run one at a time"
            : loose.length <= 2
              ? `no order between ${named.join(", or ")}, so those run one at a time`
              : `${loose.length} pairs have no order between them, such as ${named[0]}, so those run one at a time`;
      return { glob, tickets: refs, paths: [...own, ...related], order, loose: loose.length > 0 };
    });
}

/** The files the tickets may change: first the paths tickets share, then every path by folder, then the paths no ticket may change. */
export function FilesPane({ view, highlighted, onPick, onClear }: { view: SpecVersionView; highlighted: string | null; onPick(ref: string): void; onClear(): void }) {
  const { spec } = view;
  const [sharedOnly, setSharedOnly] = useState(false);
  const waves = wavesOf(spec.ticket);
  const position = new Map(spec.ticket.map((ticket, index) => [ticket.ref, index]));
  const rank = (a: string, b: string) => waves[a]! - waves[b]! || position.get(a)! - position.get(b)!;
  const shared = sharedRows(view, rank);
  const sharedAt = new Map(shared.map((row) => [row.glob, row]));

  const files = new Map<string, { tickets: string[]; paths: string[] }>();
  spec.ticket.forEach((ticket) =>
    ticket.scope.forEach((glob, index) => {
      const file = files.get(glob) ?? { tickets: [], paths: [] };
      if (!file.tickets.includes(ticket.ref)) file.tickets.push(ticket.ref);
      file.paths.push(`ticket[${ticket.ref}].scope[${index}]`);
      files.set(glob, file);
    }),
  );
  const folders = new Map<string, Array<{ glob: string; name: string; tickets: string[]; paths: string[] }>>();
  for (const [glob, file] of files) {
    if (sharedOnly && !sharedAt.has(glob)) continue;
    const { folder, name } = splitPath(glob);
    folders.set(folder, [...(folders.get(folder) ?? []), { glob, name, paths: file.paths, tickets: [...file.tickets].sort(rank) }]);
  }
  const shown = [...folders].sort(([a], [b]) => byCodePoint(a, b));
  const lit = (tickets: readonly string[]) => highlighted !== null && tickets.includes(highlighted);
  const chips = (tickets: readonly string[]) => (
    <span className="flex flex-wrap gap-1">
      {tickets.map((ref) => (
        <TicketChip key={ref} name={ref} on={ref === highlighted} onPick={onPick} />
      ))}
    </span>
  );

  return (
    <div className="space-y-4">
      <section className="space-y-1.5">
        <h4 className={HEADING}>Shared files{shared.length > 0 && ` · ${shared.length}`}</h4>
        {shared.length === 0 ? (
          <p className="text-sm text-muted-foreground">No two tickets share a path, so none of them waits for another to finish with a file.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">Tickets that share a path never run at the same time: they run in the order their dependencies set, or one at a time when there is none.</p>
            <ul className="space-y-0.5">
              {shared.map((row) => (
                <li key={row.glob} data-shared={row.glob} data-highlighted={lit(row.tickets) || undefined} className={`rounded-md ${lit(row.tickets) ? "bg-surface-selected" : ""}`}>
                  <Noteable paths={row.paths} label={`shared path ${row.glob}`}>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Code>{row.glob}</Code>
                      {chips(row.tickets)}
                      <span data-order data-unordered={row.loose || undefined} className={`text-xs ${row.loose ? "text-warning-text" : "text-muted-foreground"}`}>
                        {row.order}
                      </span>
                    </span>
                  </Noteable>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="space-y-2">
        <h4 className={HEADING}>All files by folder · {plural(files.size, "path")}</h4>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Which files" className="inline-flex gap-0.5 rounded-md border border-border-seam p-0.5">
            {(
              [
                ["All files", false],
                ["Shared only", true],
              ] as const
            ).map(([label, only]) => (
              <button
                key={label}
                type="button"
                aria-pressed={sharedOnly === only}
                onClick={() => setSharedOnly(only)}
                className={`cursor-pointer rounded px-2 py-0.5 text-xs ${sharedOnly === only ? "bg-surface-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {highlighted === null ? (
            <span className="text-[11px] text-muted-foreground">Click a ticket to highlight the paths it may change.</span>
          ) : (
            <>
              <span className="text-xs">The paths {highlighted} may change are highlighted.</span>
              <button type="button" className={BUTTON} onClick={onClear}>
                Show all
              </button>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Paths per ticket:</span>
          {spec.ticket.map((ticket) => (
            <Noteable key={ticket.ref} paths={[`ticket[${ticket.ref}].scope`]} label={`${ticket.ref} › paths`}>
              <span className="inline-flex flex-wrap items-center gap-1">
                <TicketChip name={ticket.ref} on={ticket.ref === highlighted} onPick={onPick} />
                <span className="text-[11px] text-muted-foreground">{plural(ticket.scope.length, "path")}</span>
              </span>
            </Noteable>
          ))}
        </div>
        {shown.length === 0 && <p className="text-sm text-muted-foreground">No shared paths to show.</p>}
        {shown.map(([folder, rows]) => (
          <div key={folder} data-folder={folder} className="space-y-0.5">
            <h5 className="text-xs font-semibold">
              <span className={folder === "" ? "" : "font-mono [overflow-wrap:anywhere]"}>{folder === "" ? "Top level" : folder}</span> <span className="font-normal text-muted-foreground">· {rows.length}</span>
            </h5>
            <ul className="space-y-0.5 border-l border-border-seam pl-2">
              {rows
                .sort((a, b) => byCodePoint(a.name, b.name))
                .map((row) => {
                  const share = sharedAt.get(row.glob);
                  const changed = view.changes !== null && changedAt(view.changes, row.paths);
                  return (
                    <li
                      key={row.glob}
                      data-file={row.glob}
                      data-highlighted={lit(row.tickets) || undefined}
                      title={row.glob}
                      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-1.5 py-0.5 text-sm ${lit(row.tickets) ? "bg-surface-selected" : ""}`}
                    >
                      <Code>{row.name === "" ? "(the whole folder)" : row.name}</Code>
                      {row.name === "**" && <span className="text-[11px] text-muted-foreground">everything in this folder</span>}
                      {chips(row.tickets)}
                      {share !== undefined && <span className={`${CHIP} ${share.loose ? "text-warning-text" : "text-muted-foreground"}`}>shared</span>}
                      {changed && <span className="text-[11px] text-primary">changed in v{view.version}</span>}
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </section>

      <section className="space-y-1">
        <Noteable paths={["scope.enforce"]} label="scope › enforce">
          <span className={HEADING}>Protected paths · enforce: {spec.scope.enforce}</span>
        </Noteable>
        {spec.scope.protected.length === 0 ? (
          <p className="pl-2 text-sm text-muted-foreground">No protected paths.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {spec.scope.protected.map((glob, index) => (
              <Noteable key={index} paths={[`scope.protected[${index}]`]} label={`scope › protected ${glob}`}>
                <code className="rounded bg-surface-recessed px-1 font-mono text-xs [overflow-wrap:anywhere]">{glob}</code>
              </Noteable>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** The check commands, each ticket's own verify commands and the review rules. */
export function ChecksPane({ view }: { view: SpecVersionView }) {
  const { checks, review, agents } = view.spec;
  return (
    <div className="space-y-1">
      <Noteable paths={["checks.timeout_minutes"]} label="checks › timeout">
        <span className={HEADING}>Run on every submitted ticket · timeout {plural(checks.timeout_minutes, "minute")}</span>
      </Noteable>
      {checks.commands.length === 0 && <p className="pl-2 text-sm text-muted-foreground">No project checks: each ticket runs only its own verify commands.</p>}
      {checks.commands.map((command, index) => (
        <Noteable key={index} paths={[`checks.commands[${index}]`]} label={`checks › ${command}`}>
          <Code>{command}</Code>
        </Noteable>
      ))}
      {checks.after_merge.length > 0 && <Section>Run on the integration branch after each merge</Section>}
      {checks.after_merge.map((command, index) => (
        <Noteable key={index} paths={[`checks.after_merge[${index}]`]} label={`after merge › ${command}`}>
          <Code>{command}</Code>
        </Noteable>
      ))}
      <Section>Each ticket's own verify commands</Section>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-border-seam">
          {view.spec.ticket.map((ticket) => (
            <tr key={ticket.ref}>
              <td className="w-40 py-0.5 pr-3 align-top font-medium">{ticket.ref}</td>
              <td className="py-0.5">
                <Noteable paths={[`ticket[${ticket.ref}].verify`]} label={`${ticket.ref} › verify`}>
                  {ticket.verify.length === 0 ? (
                    <span className="text-muted-foreground">none: only the project checks run</span>
                  ) : (
                    ticket.verify.map((command) => (
                      <span key={command} className="block">
                        <Code>{command}</Code>
                      </span>
                    ))
                  )}
                </Noteable>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Section>Review</Section>
      <Noteable paths={["review.approvals", "review.max_rounds", "agents.reviewer"]} label="review">
        {plural(review.approvals, "approval")} needed, up to {plural(review.max_rounds, "round")}, reviewer {modelLabel(agents.reviewer)}
      </Noteable>
      {review.rubric.map((line, index) => (
        <Noteable key={index} paths={[`review.rubric[${index}]`]} label={`rubric › ${line}`}>
          {line}
        </Noteable>
      ))}
    </div>
  );
}

/** The goal, the merge plan, the agents and the budget. */
export function ProjectPane({ view }: { view: SpecVersionView }) {
  const { project, merge, agents, budget } = view.spec;
  const agentLine = (agent: { reasoning?: string; permission_mode: string }) => `${agent.reasoning === undefined ? "" : `, ${agent.reasoning} reasoning`}, in ${agent.permission_mode} permission mode`;
  return (
    <div className="space-y-1">
      <Section>Project</Section>
      <Noteable paths={["project.name", "project.key", "project.base"]} label="project › name">
        {project.name} · key {project.key} · base <Code>{project.base}</Code>
      </Noteable>
      <Section>Goal</Section>
      <Noteable paths={["project.goal"]} label="project › goal">
        <p className="whitespace-pre-wrap">{project.goal}</p>
      </Noteable>
      {project.non_goals.length > 0 && <Section>Not in this project</Section>}
      {project.non_goals.map((line, index) => (
        <Noteable key={index} paths={[`project.non_goals[${index}]`]} label={`non-goal › ${line}`}>
          {line}
        </Noteable>
      ))}
      <Section>Merge</Section>
      <Noteable paths={["merge", "project.base"]} label="merge">
        {merge.strategy === "integration" ? (
          <>
            Approved work merges into <Code>{merge.branch}</Code> from <Code>{project.base}</Code>; you land it as one pull request with <Code>bb loom land</Code>.
          </>
        ) : (
          <>
            Each approved ticket opens its own pull request against <Code>{project.base}</Code>.
          </>
        )}
      </Noteable>
      <Section>Agents</Section>
      <Noteable paths={["agents.worker", "agents.max_workers", "agents.ticket_timeout_minutes"]} label="agents › worker">
        Workers: {modelLabel(agents.worker)}, up to {agents.max_workers} at a time, {plural(agents.ticket_timeout_minutes, "minute")} per ticket{agentLine(agents.worker)}
      </Noteable>
      <Noteable paths={["agents.reviewer", "agents.max_reviewers"]} label="agents › reviewer">
        Reviewers: {modelLabel(agents.reviewer)}, up to {agents.max_reviewers} at a time{agentLine(agents.reviewer)}
      </Noteable>
      <Noteable paths={["agents.triage"]} label="agents › triage">
        {agents.triage ? "Triage: the planner gets a round of blocked tickets to answer." : "Triage is off: blocked tickets wait for you."}
      </Noteable>
      <Section>Limits</Section>
      {budget.max_tokens !== undefined && (
        <Noteable paths={["budget.max_tokens"]} label="budget › tokens">
          Token budget: {budget.max_tokens.toLocaleString("en-US")} tokens for the whole project; Loom pauses it when they run out.
        </Noteable>
      )}
      {budget.deadline !== undefined && (
        <Noteable paths={["budget.deadline"]} label="budget › deadline">
          Deadline: {budget.deadline}; Loom pauses the project after it.
        </Noteable>
      )}
      <Noteable paths={["budget.max_attempts", "budget.max_check_failures"]} label="budget › attempts">
        A ticket blocks after {plural(budget.max_attempts, "failed attempt")} or {plural(budget.max_check_failures, "failed check run")}.
      </Noteable>
    </div>
  );
}
