import type { ReactNode } from "react";
import type { Spec } from "../spec";
import { BUTTON, CHIP, RepoChip, plural } from "./common";
import { CHANGED_TAG, Commentable, DiffList, Pin, changeAt, changedAt, kept, pinsAt, useReview, type CommentTarget, type ListMark, type SpecValue } from "./spec-review-kit";

const CODE = "rounded bg-surface-recessed px-1 font-mono text-xs [overflow-wrap:anywhere]";
/** A card's labels and values: side by side once the card has room for both, one under the other in a narrow card. */
const ROWS = "grid grid-cols-1 gap-x-3 gap-y-0.5 @min-[17rem]:grid-cols-[7rem_minmax(0,1fr)] @min-[17rem]:gap-y-1.5";
const minutes = (n: number) => (n % 60 === 0 ? `${n / 60} h` : plural(n, "minute"));

/** A choice of the spec as a segmented control: the option in force is raised, and clicking another one suggests it. */
function Choice({ path, label, value, options, names }: { path: string; label: string; value: SpecValue; options: readonly SpecValue[]; names: Readonly<Record<string, string>> }) {
  const review = useReview();
  return (
    <Commentable as="span" className="inline-flex flex-wrap items-center" target={{ paths: [path], label, kind: "enum", value, options, names }}>
      <span role="group" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-md bg-surface-recessed p-0.5">
        {options.map((option) =>
          option === value ? (
            <span key={String(option)} data-option={String(option)} aria-current="true" className="rounded bg-card px-2 py-0.5 text-xs font-semibold text-foreground shadow-sm">
              {names[String(option)] ?? String(option)}
            </span>
          ) : (
            <span
              key={String(option)}
              data-option={String(option)}
              data-preset={review.onComment === undefined ? undefined : String(option)}
              title={review.onComment === undefined ? undefined : `Suggest ${names[String(option)] ?? String(option)}`}
              className={`rounded px-2 py-0.5 text-xs text-muted-foreground ${review.onComment === undefined ? "" : "hover:bg-state-hover hover:text-foreground"}`}
            >
              {names[String(option)] ?? String(option)}
            </span>
          ),
        )}
      </span>
    </Commentable>
  );
}

function Slots({ n, max }: { n: number; max: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-[3px]" aria-label={`${n} of up to ${max}`}>
      {Array.from({ length: max }, (_, index) => (
        <span key={index} aria-hidden className={`size-3 rounded-[3px] border ${index < n ? "border-primary bg-primary" : "border-border-seam bg-card"}`} />
      ))}
      <b className="ml-1.5 text-sm tabular-nums">{n}</b>
    </span>
  );
}

/** "anthropic/claude-sonnet-5-5" may break after its slash before it breaks inside a word. */
function modelParts(model: string): ReactNode {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  return (
    <>
      {model.slice(0, slash + 1)}
      <wbr />
      {model.slice(slash + 1)}
    </>
  );
}

function Model({ agent }: { agent: { provider?: string; model?: string } }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="rounded bg-surface-recessed px-1.5 text-[11px] leading-[18px] text-muted-foreground">{agent.provider ?? "default provider"}</span>
      {agent.model === undefined ? (
        <span className="font-mono text-xs">default model</span>
      ) : (
        <span data-model={agent.model} className="font-mono text-xs [overflow-wrap:anywhere]">
          {modelParts(agent.model)}
        </span>
      )}
    </span>
  );
}

/** A label and its value; faded while only what changed is shown and this row did not. */
function Row({ label, paths, children }: { label: string; paths: readonly string[]; children: ReactNode }) {
  const review = useReview();
  const faded = review.only && !kept(review, paths);
  return (
    <>
      <dt className={`pt-1 text-xs text-muted-foreground ${faded ? "opacity-45" : ""}`}>{label}</dt>
      <dd className={`min-w-0 text-sm ${faded ? "opacity-45" : ""}`}>{children}</dd>
    </>
  );
}

const value = (path: string, label: string, kind: CommentTarget["kind"], current?: SpecValue, extra: Partial<CommentTarget> = {}): CommentTarget => ({ paths: [path], label, kind, ...(current === undefined ? {} : { value: current }), ...extra });

interface SettingsCard {
  id: string;
  title: string;
  note?: string;
  /** The spec paths the card shows. */
  paths: string[];
  wide?: boolean;
  full?: boolean;
  body: ReactNode;
}

function Card({ card }: { card: SettingsCard }) {
  const review = useReview();
  const changed = card.paths.some((path) => changedAt(review, path));
  const pins = pinsAt(review, card.paths[0]!);
  return (
    <section
      data-settings-card={card.id}
      data-anchor={card.paths.join(" ")}
      data-changed={changed || undefined}
      aria-label={card.title}
      className={`@container min-w-0 rounded-lg border bg-card p-3 ${changed ? "border-primary ring-1 ring-primary ring-inset" : "border-border-seam"} ${card.full ? "@xl:col-span-2 @5xl:col-span-3" : card.wide ? "@xl:col-span-2" : ""}`}
    >
      <header className="mb-2.5 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{card.title}</h3>
        {card.note !== undefined && (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={card.note}>
            {card.note}
          </span>
        )}
        {changed && <span className={CHANGED_TAG}>changed</span>}
        {pins.map((n) => (
          <Pin key={n} n={n} />
        ))}
        {review.onComment !== undefined && (
          <button type="button" className={`${CHIP} ml-auto cursor-pointer px-2 text-muted-foreground hover:text-foreground`} onClick={(event) => review.onComment!({ paths: card.paths, label: card.title, kind: "text" }, event.currentTarget)}>
            Comment
          </button>
        )}
      </header>
      {card.body}
    </section>
  );
}

/** The commands of a list as numbered steps, with what changed marked. */
function Steps({ path, label, commands, missing }: { path: string; label: string; commands: readonly string[]; missing?: readonly string[] }) {
  const step = (command: string, mark: ListMark, index: number) =>
    mark === "removed" ? (
      <span data-removed className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-destructive-text/40 bg-destructive-text/5 px-2 py-0.5 font-mono text-[11.5px] text-destructive-text line-through">
        {command}
      </span>
    ) : (
      <Commentable as="span" target={value(`${path}[${index}]`, `${label} ${index + 1}`, "command")} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11.5px] ${mark === "added" ? "border-success bg-success/15" : "border-border-seam bg-surface-recessed/50"}`}>
        <span className="font-sans text-[10px] text-subtle-foreground">{index + 1}</span>
        <span className="[overflow-wrap:anywhere]">{command}</span>
        {mark === "added" && <span className="font-sans text-[10px] font-semibold text-success">new</span>}
      </Commentable>
    );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DiffList path={path} items={commands} render={step} compact={false} />
      {missing?.map((command) => (
        <span key={command} data-skipped title="Runs on every ticket, but not after a merge" className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border-seam px-2 py-0.5 font-mono text-[11.5px] text-subtle-foreground">
          {command}
          <span className="font-sans text-[10px]">tickets only</span>
        </span>
      ))}
    </div>
  );
}

/** How Loom runs the project: merging, workers, reviewers, checks, the scope guard, repos, and limits and triage. */
export function SettingsSection({ spec, bbProjectNames, onShowAll, onJump }: { spec: Spec; bbProjectNames: Readonly<Record<string, string>>; onShowAll(): void; onJump(section: "tickets" | "guardrails"): void }) {
  const review = useReview();
  const { merge, agents, review: rules, checks, scope, budget, project } = spec;
  const repos = spec.repo ?? [];
  const integration = merge.strategy === "integration";
  const worker = agents.worker;
  const reviewer = agents.reviewer;
  const ownVerify = spec.ticket.filter((ticket) => ticket.verify.length > 0).length;
  const skipped = integration ? checks.commands.filter((command) => !checks.after_merge.includes(command)) : [];
  const permission = { "accept-edits": "edits only", auto: "auto", full: "full" };

  const cards: SettingsCard[] = [
    {
      id: "merge",
      title: "Merging",
      paths: ["merge", "project.base"],
      body: (
        <>
          <p className="mb-2.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-md border border-border-seam px-2 py-1">{spec.ticket.length} ticket {spec.ticket.length === 1 ? "branch" : "branches"}</span>
            <span aria-hidden className="text-subtle-foreground">→</span>
            {integration ? (
              <>
                <Commentable as="span" target={value("merge.branch", "Integration branch", "text", merge.branch)} className="rounded-md border border-primary px-2 py-1 font-mono">
                  {merge.branch}
                </Commentable>
                <span aria-hidden className="text-subtle-foreground">→</span>
              </>
            ) : (
              <>
                <span className="rounded-md border border-primary px-2 py-1">a pull request each</span>
                <span aria-hidden className="text-subtle-foreground">→</span>
              </>
            )}
            <Commentable as="span" target={value("project.base", "Base branch", "text", project.base)} className="rounded-md border border-border-seam px-2 py-1 font-mono">
              {project.base}
            </Commentable>
          </p>
          <dl className={ROWS}>
            <Row label="Strategy" paths={["merge.strategy"]}>
              <Choice path="merge.strategy" label="Merge strategy" value={merge.strategy} options={["integration", "pr"]} names={{ integration: "Integration branch", pr: "Pull request per ticket" }} />
            </Row>
            {integration ? (
              <Row label="Landing" paths={["merge.strategy"]}>
                <span className="text-xs text-muted-foreground">
                  You land it with <code className={`${CODE} whitespace-nowrap`}>bb loom land</code>: {repos.length > 0 ? "one pull request per repo" : "one pull request"}, or onto {repos.length > 0 ? "each base" : project.base} with <code className={`${CODE} whitespace-nowrap`}>--direct</code>.
                </span>
              </Row>
            ) : (
              <>
                <Row label="Written by" paths={["merge.describe"]}>
                  <Choice path="merge.describe" label="Who writes the pull request" value={merge.describe ?? "worker"} options={["worker", "loom"]} names={{ worker: "The worker", loom: "Loom's template" }} />
                </Row>
                <Row label="Drafts" paths={["merge.draft"]}>
                  <Commentable as="span" target={value("merge.draft", "Draft pull requests", "bool", merge.draft)}>
                    {merge.draft ? "Opened as drafts" : "Opened ready for review"}
                  </Commentable>
                </Row>
                <Row label="Commits" paths={["merge.squash"]}>
                  <Commentable as="span" target={value("merge.squash", "One commit per pull request", "bool", merge.squash ?? true)}>
                    {(merge.squash ?? true) ? "One commit per pull request" : "The branch as it is"}
                  </Commentable>
                </Row>
                <Row label="Fix rounds" paths={["merge.max_fix_rounds"]}>
                  <Commentable as="span" target={value("merge.max_fix_rounds", "Fix rounds", "number", merge.max_fix_rounds ?? 5, { min: 0, max: 20 })}>
                    <b className="tabular-nums">{merge.max_fix_rounds ?? 5}</b> <span className="text-xs text-muted-foreground">then the ticket blocks</span>
                  </Commentable>
                </Row>
              </>
            )}
            {merge.remote !== "origin" && (
              <Row label="Remote" paths={["merge.remote"]}>
                <Commentable as="span" target={value("merge.remote", "Remote", "text", merge.remote)} className="font-mono text-xs">
                  {merge.remote}
                </Commentable>
              </Row>
            )}
            {merge.worktree !== undefined && (
              <Row label="Worktree" paths={["merge.worktree"]}>
                <Commentable as="span" target={value("merge.worktree", "Integration worktree", "text")} className="font-mono text-xs [overflow-wrap:anywhere]">
                  {merge.worktree.plugin === undefined ? merge.worktree.command : `${merge.worktree.plugin}: ${merge.worktree.command}`}
                </Commentable>
              </Row>
            )}
            {merge.forge !== undefined && (
              <Row label="Server" paths={["merge.forge"]}>
                <Commentable as="span" target={value("merge.forge", "Pull request server", "text")}>
                  {merge.forge.kind === "gh" ? "GitHub through gh" : merge.forge.kind === "command" ? "the spec's own commands" : "none: Loom only pushes the branch"}
                </Commentable>
              </Row>
            )}
          </dl>
        </>
      ),
    },
    {
      id: "workers",
      title: "Workers",
      note: "write the code",
      paths: ["agents.worker", "agents.max_workers", "agents.ticket_timeout_minutes", "environment"],
      body: (
        <dl className={ROWS}>
          <Row label="Model" paths={["agents.worker.model", "agents.worker.provider"]}>
            <Commentable as="span" target={{ paths: ["agents.worker.model", "agents.worker.provider"], label: "Worker model", kind: "text" }}>
              <Model agent={worker} />
            </Commentable>
          </Row>
          <Row label="Reasoning" paths={["agents.worker.reasoning"]}>
            <Commentable as="span" target={value("agents.worker.reasoning", "Worker reasoning", "text", worker.reasoning)}>
              {worker.reasoning ?? <span className="text-muted-foreground">the model's default</span>}
            </Commentable>
          </Row>
          <Row label="At the same time" paths={["agents.max_workers"]}>
            <Commentable as="span" target={value("agents.max_workers", "Workers at the same time", "number", agents.max_workers, { min: 1, max: 8 })}>
              <Slots n={agents.max_workers} max={8} />
            </Commentable>
          </Row>
          <Row label="Time per ticket" paths={["agents.ticket_timeout_minutes"]}>
            <Commentable as="span" target={value("agents.ticket_timeout_minutes", "Time per ticket", "number", agents.ticket_timeout_minutes, { min: 10, max: 1440, step: 30, unit: "min" })}>
              <b>{minutes(agents.ticket_timeout_minutes)}</b>
            </Commentable>
          </Row>
          <Row label="Permissions" paths={["agents.worker.permission_mode"]}>
            <Choice path="agents.worker.permission_mode" label="Worker permissions" value={worker.permission_mode} options={["accept-edits", "auto", "full"]} names={permission} />
          </Row>
          {spec.environment !== undefined && (
            <Row label="Environment" paths={["environment"]}>
              <Commentable as="span" target={value("environment", "Environment", "text")} className="font-mono text-xs">
                {spec.environment.provider}
              </Commentable>
            </Row>
          )}
        </dl>
      ),
    },
    {
      id: "reviewers",
      title: "Reviewers",
      note: "approve each ticket",
      paths: ["agents.reviewer", "agents.max_reviewers", "review.approvals", "review.max_rounds"],
      body: (
        <dl className={ROWS}>
          <Row label="Model" paths={["agents.reviewer.model", "agents.reviewer.provider"]}>
            <Commentable as="span" target={{ paths: ["agents.reviewer.model", "agents.reviewer.provider"], label: "Reviewer model", kind: "text" }}>
              <Model agent={reviewer} />
            </Commentable>
          </Row>
          <Row label="Reasoning" paths={["agents.reviewer.reasoning"]}>
            <Commentable as="span" target={value("agents.reviewer.reasoning", "Reviewer reasoning", "text", reviewer.reasoning)}>
              {reviewer.reasoning ?? <span className="text-muted-foreground">the model's default</span>}
            </Commentable>
          </Row>
          <Row label="At the same time" paths={["agents.max_reviewers"]}>
            <Commentable as="span" target={value("agents.max_reviewers", "Reviewers at the same time", "number", agents.max_reviewers, { min: 1, max: 8 })}>
              <Slots n={agents.max_reviewers} max={8} />
            </Commentable>
          </Row>
          <Row label="Approvals needed" paths={["review.approvals"]}>
            <Commentable as="span" target={value("review.approvals", "Approvals needed", "number", rules.approvals, { min: 1, max: 3 })}>
              <b className="tabular-nums">{rules.approvals}</b> <span className="text-xs text-muted-foreground">of up to 3</span>
            </Commentable>
          </Row>
          <Row label="Review rounds" paths={["review.max_rounds"]}>
            <Commentable as="span" target={value("review.max_rounds", "Review rounds", "number", rules.max_rounds, { min: 1, max: 10 })}>
              <b className="tabular-nums">up to {rules.max_rounds}</b> <span className="text-xs text-muted-foreground">then the ticket blocks</span>
            </Commentable>
          </Row>
          <Row label="Permissions" paths={["agents.reviewer.permission_mode"]}>
            <Choice path="agents.reviewer.permission_mode" label="Reviewer permissions" value={reviewer.permission_mode} options={["accept-edits", "auto", "full"]} names={permission} />
          </Row>
          <Row label="What they check" paths={["review.rubric"]}>
            <button type="button" className="cursor-pointer text-xs text-primary underline-offset-2 hover:underline" onClick={() => onJump("guardrails")}>
              {rules.rubric.length === 0 ? "no rubric: the ticket's criteria only" : `${plural(rules.rubric.length, "rubric line")} ↓`}
            </button>
          </Row>
        </dl>
      ),
    },
    {
      id: "checks",
      title: "Checks",
      note: "commands that must pass",
      paths: ["checks"],
      wide: true,
      body: (
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            On every ticket{repos.length > 0 ? " in a repo without checks of its own" : ""}, before review
            <Commentable as="span" target={value("checks.timeout_minutes", "Check time limit", "number", checks.timeout_minutes, { min: 1, max: 29, unit: "min" })} className={`${CHIP} px-2 text-foreground`}>
              {checks.timeout_minutes} min limit
            </Commentable>
          </p>
          {checks.commands.length === 0 && changeAt(review, "checks.commands") === undefined ? (
            <Commentable target={value("checks.commands", "Ticket checks", "command")} className="text-sm text-muted-foreground">
              No project checks: each ticket runs only its own verify commands.
            </Commentable>
          ) : (
            <Steps path="checks.commands" label="Ticket check" commands={checks.commands} />
          )}
          {(integration || checks.after_merge.length > 0) && (
            <>
              <p className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                On the integration branch after each merge
                {skipped.length > 0 && checks.after_merge.length > 0 && <span className={`${CHIP} px-2`}>skips {skipped.length === 1 ? "1 ticket check" : `${skipped.length} ticket checks`}</span>}
              </p>
              {checks.after_merge.length === 0 && changeAt(review, "checks.after_merge") === undefined ? (
                <Commentable target={value("checks.after_merge", "After-merge checks", "command")} className="text-sm text-muted-foreground">
                  Nothing runs after a merge.
                </Commentable>
              ) : (
                <Steps path="checks.after_merge" label="After-merge check" commands={checks.after_merge} missing={skipped} />
              )}
            </>
          )}
          <p className="pt-1 text-xs text-muted-foreground">
            Plus each ticket's own verify commands: <b className="text-foreground">{ownVerify === spec.ticket.length ? "every ticket" : `${ownVerify} of ${spec.ticket.length} tickets`}</b> {ownVerify === 1 ? "has" : "have"} some.{" "}
            <button type="button" className="cursor-pointer text-primary underline-offset-2 hover:underline" onClick={() => onJump("tickets")}>
              See the tickets ↓
            </button>
          </p>
        </div>
      ),
    },
    {
      id: "scope",
      title: "Scope guard",
      paths: ["scope"],
      body: (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">When a worker changes a file outside its ticket's scope</p>
          <Choice path="scope.enforce" label="Scope enforcement" value={scope.enforce} options={["warn", "reject"]} names={{ warn: "Warn the reviewer", reject: "Reject the work" }} />
          <p className="pt-1 text-xs text-muted-foreground">No ticket may change{repos.length > 0 ? ", in any repo" : ""}</p>
          <div className="flex flex-wrap gap-1">
            {scope.protected.length === 0 && changeAt(review, "scope.protected") === undefined ? (
              <Commentable as="span" target={value("scope.protected", "Protected paths", "file")} className="text-sm text-muted-foreground">
                No protected paths.
              </Commentable>
            ) : (
              <DiffList
                path="scope.protected"
                items={scope.protected}
                compact={false}
                render={(glob, mark, index) =>
                  mark === "removed" ? (
                    <span data-removed className="rounded bg-destructive-text/10 px-1.5 font-mono text-xs text-destructive-text line-through">
                      {glob}
                    </span>
                  ) : (
                    <Commentable as="span" target={value(`scope.protected[${index}]`, `Protected path ${glob}`, "file")} className={`rounded px-1.5 font-mono text-xs [overflow-wrap:anywhere] ${mark === "added" ? "bg-success/15 ring-1 ring-success" : "bg-surface-recessed"}`}>
                      {glob}
                    </Commentable>
                  )
                }
              />
            )}
          </div>
        </div>
      ),
    },
    ...(repos.length === 0
      ? []
      : [
          {
            id: "repos",
            title: `Repos · ${repos.length}`,
            paths: ["repo"],
            full: true,
            body: (
              <ul className="space-y-1.5">
                {repos.map((repo, index) => (
                  <li key={repo.name} data-repo={repo.name}>
                    <Commentable target={value(`repo[${index}]`, `Repo ${repo.name}`, "text")} className="space-y-1 p-1.5 text-sm">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <RepoChip name={repo.name} />
                        <span data-repo-project>bb project {bbProjectNames[repo.project] ?? <code className={CODE}>{repo.project}</code>}</span>
                        <span className="text-muted-foreground">
                          base <code className={CODE}>{repo.base ?? project.base}</code>
                        </span>
                        {repo.remote !== undefined && (
                          <span className="text-muted-foreground">
                            remote <code className={CODE}>{repo.remote}</code>
                          </span>
                        )}
                      </span>
                      <span data-repo-checks={repo.name} className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        checks:{" "}
                        {repo.checks === undefined ? "the project checks" : repo.checks.length === 0 ? "none: its tickets run only their own verify commands" : repo.checks.map((command) => <code key={command} className={CODE}>{command}</code>)}
                        {integration && (
                          <>
                            {" "}
                            · after each merge:{" "}
                            {repo.after_merge === undefined
                              ? checks.after_merge.length === 0
                                ? "nothing"
                                : "the project's after-merge checks"
                              : repo.after_merge.length === 0
                                ? "nothing"
                                : repo.after_merge.map((command) => <code key={command} className={CODE}>{command}</code>)}
                          </>
                        )}
                      </span>
                      {repo.protected !== undefined && repo.protected.length > 0 && (
                        <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          also protected:
                          {repo.protected.map((glob) => (
                            <code key={glob} className={CODE}>
                              {glob}
                            </code>
                          ))}
                        </span>
                      )}
                    </Commentable>
                  </li>
                ))}
              </ul>
            ),
          },
        ]),
    {
      id: "limits",
      title: "Limits and triage",
      note: "when Loom stops and asks",
      paths: ["budget", "agents.triage"],
      full: true,
      body: (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2">
          {(
            [
              ["budget.max_attempts", "Attempts per ticket", String(budget.max_attempts), "then it blocks", { kind: "number", value: budget.max_attempts, min: 1, max: 10 }],
              ["budget.max_check_failures", "Failed check runs", String(budget.max_check_failures), "per ticket, then it blocks", { kind: "number", value: budget.max_check_failures, min: 1, max: 20 }],
              ["budget.max_tokens", "Token budget", budget.max_tokens === undefined ? "No limit" : budget.max_tokens.toLocaleString("en-US"), "for the whole project", { kind: "text" }],
              ["budget.deadline", "Deadline", budget.deadline ?? "None", "Loom pauses the project after it", { kind: "text" }],
              ["agents.triage", "Triage", agents.triage ? "On" : "Off", agents.triage ? "the planner answers blocked tickets" : "blocked tickets wait for you", { kind: "bool", value: agents.triage }],
            ] as const
          ).map(([path, label, shown, note, target]) => {
            const faded = review.only && !kept(review, [path]);
            return (
              <Commentable key={path} target={{ paths: [path], label, ...target }} className={`rounded-md border border-border-seam bg-surface-recessed/40 px-2.5 py-2 ${faded ? "opacity-45" : ""}`}>
                <span className="block text-[11px] text-muted-foreground">{label}</span>
                <span className={`block text-base font-semibold tabular-nums ${shown === "No limit" || shown === "None" ? "text-sm font-medium text-subtle-foreground" : ""}`}>{shown}</span>
                <span className="block text-[11px] text-subtle-foreground">{note}</span>
              </Commentable>
            );
          })}
        </div>
      ),
    },
  ];

  const shown = cards.filter((card) => kept(review, card.paths));
  const hidden = cards.length - shown.length;
  return (
    <>
      {shown.length > 0 && (
        // Its own container: beside the review panel, the spec page is much wider than this column.
        <div className="@container">
          <div data-settings-grid className="grid grid-flow-row-dense gap-3 @xl:grid-cols-2 @5xl:grid-cols-3">
            {shown.map((card) => (
              <Card key={card.id} card={card} />
            ))}
          </div>
        </div>
      )}
      {hidden > 0 && (
        <p data-hidden-line className="mt-3 flex items-center gap-2 rounded-md border border-dashed border-border-seam px-3 py-2 text-xs text-muted-foreground">
          {hidden === cards.length ? "No setting changed." : `${plural(hidden, "group")} of settings did not change.`}
          <button type="button" className={`${BUTTON} ml-auto`} onClick={onShowAll}>
            Show {hidden === 1 ? "it" : "them"}
          </button>
        </p>
      )}
    </>
  );
}

