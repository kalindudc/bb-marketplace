import { experimental_Icon as Icon, Markdown } from "@get-bb/plugin-sdk/app";
import {
  AUTO_POST_MODES, AUTO_POST_SEVERITIES, CONCERN_KINDS, DEFAULT_DISCLOSURE, DEFAULT_VERIFIER_COMMAND, POSTING_MODES, type AutoPost, type AutoPostMode, type AutoPostRepo, type ConcernKind,
} from "../../config";
import type { AutoPostInsights } from "../../contract";
import { TripNote } from "../auto-post";
import { BUTTON, BUTTON_GHOST_SMALL, CARD, Checkbox, FIELD, FIELD_CODE } from "../common";
import { useShuttleQuery } from "../data";
import { percent, plural } from "../format";

/** A repository row as edited: its held paths, allowed authors and approval paths as lines of globs until it is saved. */
export type AutoPostRepoDraft = AutoPostRepo & { paths: string; authors: string; approvalPaths: string };
export type AutoPostDraft = Omit<AutoPost, "repos"> & { repos: AutoPostRepoDraft[] };

/** Globs are separated by commas or new lines; spaces stay, since paths may hold them. */
const splitGlobs = (text: string) => text.split(/[,\n]+/u).map((glob) => glob.trim()).filter((glob) => glob !== "");
const GLUE = ", ";
/** A list the user did not edit is kept exactly as it was, so a save never rewrites globs it cannot show apart. */
const globsOf = (text: string, before: readonly string[]) => (text === before.join(GLUE) ? [...before] : splitGlobs(text));

export const toAutoPostDraft = (value: AutoPost): AutoPostDraft => ({
  ...value,
  repos: value.repos.map((repo) => ({ ...repo, paths: repo.holdPaths.join(GLUE), authors: repo.allowAuthors.join(GLUE), approvalPaths: repo.approvePaths.join(GLUE) })),
});

/** Rows without a repository are dropped; held, approval paths and authors are split into globs. Every other field is kept as it came. */
export const fromAutoPostDraft = (draft: AutoPostDraft): AutoPost => ({
  ...draft,
  repos: draft.repos
    .filter((repo) => repo.repo.trim() !== "")
    .map(({ paths, authors, approvalPaths, ...repo }) => ({
      ...repo, repo: repo.repo.trim(),
      holdPaths: globsOf(paths, repo.holdPaths), allowAuthors: globsOf(authors, repo.allowAuthors), approvePaths: globsOf(approvalPaths, repo.approvePaths),
    })),
});

const MODE_LABELS: Record<AutoPostMode, string> = {
  off: "Off",
  shadow: "Shadow: decide, never post",
  countdown: "Countdown: post after a delay unless you stop it",
  auto: "Auto: post at once",
};
const SEVERITY_LABELS: Record<(typeof AUTO_POST_SEVERITIES)[number], string> = { low: "Low and above", medium: "Medium and above", high: "High only" };

const CONCERN_LABELS: Record<ConcernKind, string> = {
  description: "The description does not match the diff",
  scope: "Changes outside the PR's purpose, such as unrelated files or tests changed to pass",
  unverified: "Something the reviewer could not verify or run",
  process: "CI, approvals, conflicts or merge state",
  design: "A design or behaviour point",
  other: "A concern without a kind, from older reviews",
};

const oneIn = (precision: number) => (precision >= 1 ? "none" : `about 1 in ${Math.round(1 / (1 - precision))}`);
const posts = (mode: AutoPostMode) => POSTING_MODES.includes(mode);
const ratio = (value: number | null) => (value === null ? "\u2014" : percent(value));

type InsightsRepo = AutoPostInsights["repos"][number];
type ShadowRecord = InsightsRepo["findings"] | InsightsRepo["approvals"];

/**
 * The shadow record behind a mode that posts: precision, what it proves, and what would prove the target. A record
 * short of the target only warns: Shuttle posts all the same, since you chose the mode.
 */
function RecordNote({ kind, record, target }: { kind: "comments" | "approvals"; record: ShadowRecord | null; target: number }) {
  const noun = kind === "comments" ? "finding" : "approval";
  const decided = record === null ? 0 : record.agreed + record.against;
  const proven = record !== null && record.lowerBound !== null && record.lowerBound >= target;
  return (
    <div data-auto-post-record={kind} className="mt-1.5 text-xs text-muted-foreground">
      {record === null || decided === 0 ? (
        <div>No decided {noun}s in the last 90 days: the record says nothing about {kind} here yet.</div>
      ) : (
        <div>
          Last 90 days: precision {ratio(record.precision)} ({record.agreed} of {decided} decided {noun}s), proven at least {ratio(record.lowerBound)} against a {percent(target)} target
          {proven ? "." : record.needed === null ? "; out of reach at this record." : `; ${plural(record.needed, `more agreeing ${noun}`)} in a row would prove it.`}
        </div>
      )}
      {!proven && (
        <div role="note" data-auto-post-unproven={kind} className="mt-1 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-warning-text">
          <Icon name="TriangleAlert" fallback="AlertTriangle" className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>The record has not proven the {percent(target)} target for {kind} here. Shuttle will still post them; shadow mode keeps the record without posting.</span>
        </div>
      )}
    </div>
  );
}

/** Auto post: which repositories it watches, how each posts, the verifier it asks, and the bar a finding must clear. */
export function AutoPostCard({ value, onChange }: { value: AutoPostDraft; onChange(next: AutoPostDraft): void }) {
  const insights = useShuttleQuery("autoPostInsights", { range: "90d" }, value.repos.length > 0).data;
  const set = (patch: Partial<AutoPostDraft>) => onChange({ ...value, ...patch });
  const setRepo = (index: number, patch: Partial<AutoPostRepoDraft>) => set({ repos: value.repos.map((repo, i) => (i === index ? { ...repo, ...patch } : repo)) });
  const number = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));
  const row = "grid grid-cols-1 items-center gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3";
  const label = "text-xs text-muted-foreground";
  const shown = (n: number) => (Number.isNaN(n) ? "" : n);
  const footer = value.disclosure.trim() === "" ? DEFAULT_DISCLOSURE : value.disclosure;
  const recordOf = (repo: AutoPostRepoDraft) => insights?.repos.find((item) => item.repo === repo.repo.trim()) ?? null;
  return (
    <div className={CARD} data-auto-post-settings>
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <Icon name="Eye" className="size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Auto post</div>
          <div className="text-xs text-muted-foreground">
            Check each AI review draft against the review's critic votes, the code it quotes and a fast verifier. Shadow mode records what Shuttle would post and never posts; countdown and auto post it as Shuttle, with a footer that says so. Insights › Auto post compares the record with what you post.
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 pb-3.5 text-sm">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Repositories</div>
        {value.repos.length === 0 && <div className="text-xs text-muted-foreground">Off everywhere. Add a repository to start shadow mode there.</div>}
        {value.repos.map((repo, index) => {
          const record = recordOf(repo);
          const approvalsPost = posts(repo.approve);
          return (
            <div key={index} data-auto-post-repo={index} className="rounded-md border border-border px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label={`Repository ${index + 1}`} className={`${FIELD} min-w-0 flex-1 font-mono`} placeholder="acme/app, or a glob such as acme/*" value={repo.repo}
                  onChange={(event) => setRepo(index, { repo: event.target.value })} />
                <button type="button" className={BUTTON_GHOST_SMALL} aria-label={`Remove repository ${index + 1}`} onClick={() => set({ repos: value.repos.filter((_, i) => i !== index) })}>
                  <Icon name="X" className="size-3.5" aria-hidden />
                </button>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 @2xl:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className={label}>Comments</span>
                  <select aria-label={`Mode for repository ${index + 1}`} className={FIELD} value={repo.mode} onChange={(event) => setRepo(index, { mode: event.target.value as AutoPostMode })}>
                    {AUTO_POST_MODES.map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className={label}>Approvals</span>
                  <select aria-label={`Approvals mode for repository ${index + 1}`} className={FIELD} value={repo.approve} onChange={(event) => setRepo(index, { approve: event.target.value as AutoPostMode })}>
                    {AUTO_POST_MODES.map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
                  </select>
                </label>
              </div>
              {posts(repo.mode) && <RecordNote kind="comments" record={record?.findings ?? null} target={insights?.target ?? value.targetPrecision} />}
              {approvalsPost && <RecordNote kind="approvals" record={record?.approvals ?? null} target={insights?.approvalTarget ?? value.approvals.target} />}
              {record !== null && record.trips.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">{record.trips.map((trip) => <TripNote key={trip.kind} repo={record.repo} trip={trip} />)}</div>
              )}
              <label className="mt-2 flex flex-col gap-1">
                <span className={label}>Paths approvals may cover</span>
                <input aria-label={`Approval paths for repository ${index + 1}`} className={`${FIELD} font-mono`} placeholder="Globs such as docs/*, locales/*.yml, separated by commas; case matters and * crosses folders" value={repo.approvalPaths}
                  onChange={(event) => setRepo(index, { approvalPaths: event.target.value })} />
              </label>
              {approvalsPost && splitGlobs(repo.approvalPaths).length === 0 && (
                <div role="note" data-approve-paths-missing className="mt-1 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-xs text-warning-text">
                  <Icon name="TriangleAlert" fallback="AlertTriangle" className="mt-px size-3.5 shrink-0" aria-hidden />
                  <span>Approvals never post until you list the paths they may cover.</span>
                </div>
              )}
              <label className="mt-2 flex flex-col gap-1">
                <span className={label}>Review guidelines the verifier reads</span>
                <textarea aria-label={`Guidelines for repository ${index + 1}`} rows={2} className={FIELD} placeholder="What matters in this repository, and what does not, in a few lines" value={repo.guidelines}
                  onChange={(event) => setRepo(index, { guidelines: event.target.value })} />
              </label>
              <label className="mt-2 flex flex-col gap-1">
                <span className={label}>Judge these authors like people, although they count as bots</span>
                <input aria-label={`Allowed authors for repository ${index + 1}`} className={`${FIELD} font-mono`} placeholder="Logins or globs, such as an agent account that opens PRs for someone" value={repo.authors}
                  onChange={(event) => setRepo(index, { authors: event.target.value })} />
              </label>
              <label className="mt-2 flex flex-col gap-1">
                <span className={label}>Hold for me when the PR changes</span>
                <input aria-label={`Held paths for repository ${index + 1}`} className={`${FIELD} font-mono`} placeholder="Path globs such as terraform/*/iam/*, *.sql" value={repo.paths}
                  onChange={(event) => setRepo(index, { paths: event.target.value })} />
              </label>
              <label className="mt-2 flex flex-col gap-1">
                <span className={label}>Footer of reviews Shuttle posts here, instead of the one below</span>
                <textarea aria-label={`Footer for repository ${index + 1}`} rows={2} className={FIELD} placeholder={footer} value={repo.disclosure}
                  onChange={(event) => setRepo(index, { disclosure: event.target.value })} />
              </label>
            </div>
          );
        })}
        <div>
          <button type="button" className={BUTTON}
            onClick={() => set({ repos: [...value.repos, { repo: "", mode: "shadow", approve: "shadow", guidelines: "", holdPaths: [], allowAuthors: [], approvePaths: [], disclosure: "", paths: "", authors: "", approvalPaths: "" }] })}>
            <Icon name="Plus" className="size-3.5" aria-hidden />Add repository
          </button>
        </div>

        <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Posting</div>
        <div className="text-xs text-muted-foreground">
          In countdown mode a passing review waits, shows on the PR and in Insights, and posts unless you stop it. Every review Shuttle posts goes through its review queue with the footer below.
        </div>
        <label className={row}>
          <span className={label}>Comments wait</span>
          <span className="flex items-center gap-2">
            <input aria-label="Minutes a comment review waits" type="number" min={1} max={1440} className={`${FIELD} w-20`} value={shown(value.countdownMinutes)} onChange={(event) => set({ countdownMinutes: number(event.target.value) })} />
            <span className="text-xs text-muted-foreground">minutes before they post</span>
          </span>
        </label>
        <label className={row}>
          <span className={label}>Approvals wait</span>
          <span className="flex items-center gap-2">
            <input aria-label="Minutes an approval waits" type="number" min={1} max={2880} className={`${FIELD} w-20`} value={shown(value.approvals.countdownMinutes)}
              onChange={(event) => set({ approvals: { ...value.approvals, countdownMinutes: number(event.target.value) } })} />
            <span className="text-xs text-muted-foreground">minutes before they post</span>
          </span>
        </label>
        <label className={row}>
          <span className={label}>A day, per repository</span>
          <span className="flex items-center gap-2">
            <input aria-label="Reviews Shuttle posts a day in a repository" type="number" min={0} max={50} className={`${FIELD} w-20`} value={shown(value.maxPerDay)} onChange={(event) => set({ maxPerDay: number(event.target.value) })} />
            <span className="text-xs text-muted-foreground">reviews at most, comments and approvals together</span>
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Footer of every review Shuttle posts, in Markdown</span>
          <textarea aria-label="Footer of posted reviews" rows={2} className={FIELD} value={value.disclosure} onChange={(event) => set({ disclosure: event.target.value })} />
        </label>
        {value.disclosure.trim() !== DEFAULT_DISCLOSURE && (
          <div><button type="button" className={BUTTON_GHOST_SMALL} onClick={() => set({ disclosure: DEFAULT_DISCLOSURE })}>Use the default footer</button></div>
        )}
        <div data-disclosure-preview className="rounded-md border border-border bg-background px-3 py-2 text-[13px]">
          <div className="mb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground">How a posted review reads</div>
          <div>Thanks, this unblocks the header. One race in the overflow menu, noted inline.</div>
          <div className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground"><Markdown content={footer} /></div>
        </div>
        <label className={row}>
          <span className={label}>Breaker</span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            stop posting in a repository when more than
            <input aria-label="Marked findings that stop posting" type="number" min={0} max={50} className={`${FIELD} w-20`} value={shown(value.breaker.maxMarked)}
              onChange={(event) => set({ breaker: { ...value.breaker, maxMarked: number(event.target.value) } })} />
            of its last
            <input aria-label="Posted findings the breaker looks at" type="number" min={1} max={200} className={`${FIELD} w-20`} value={shown(value.breaker.window)}
              onChange={(event) => set({ breaker: { ...value.breaker, window: number(event.target.value) } })} />
            posted findings are marked as mistakes, until you resume it
          </span>
        </label>

        <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">The bar a finding must clear</div>
        <label className={row}>
          <span className={label}>Severity</span>
          <select aria-label="Lowest severity that can post" className={FIELD} value={value.minSeverity} onChange={(event) => set({ minSeverity: event.target.value as AutoPost["minSeverity"] })}>
            {AUTO_POST_SEVERITIES.map((severity) => <option key={severity} value={severity}>{SEVERITY_LABELS[severity]}</option>)}
          </select>
        </label>
        <label className={row}>
          <span className={label}>Verifier scores</span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            holds at least
            <input aria-label="Lowest verifier score that the finding holds" type="number" min={0} max={1} step={0.05} className={`${FIELD} w-20`} value={shown(value.floors.holds)}
              onChange={(event) => set({ floors: { ...value.floors, holds: number(event.target.value) } })} />
            and worth posting at least
            <input aria-label="Lowest verifier score that the finding is worth posting" type="number" min={0} max={1} step={0.05} className={`${FIELD} w-20`} value={shown(value.floors.worth)}
              onChange={(event) => set({ floors: { ...value.floors, worth: number(event.target.value) } })} />
          </span>
        </label>
        <label className={row}>
          <span className={label}>Target precision</span>
          <span className="flex items-center gap-2">
            <input aria-label="Target precision" type="number" min={0.5} max={1} step={0.01} className={`${FIELD} w-20`} value={shown(value.targetPrecision)}
              onChange={(event) => set({ targetPrecision: number(event.target.value) })} />
            <span className="text-xs text-muted-foreground">{Number.isNaN(value.targetPrecision) ? "" : `${oneIn(value.targetPrecision)} auto-posted findings you would not have posted`}</span>
          </span>
        </label>
        <label className={row}>
          <span className={label}>At most</span>
          <span className="flex items-center gap-2">
            <input aria-label="Comments a review posts" type="number" min={1} max={20} className={`${FIELD} w-20`} value={shown(value.maxComments)} onChange={(event) => set({ maxComments: number(event.target.value) })} />
            <span className="text-xs text-muted-foreground">comments, highest severity first</span>
          </span>
        </label>
        <label className={row}>
          <span className={label}>Hold PRs larger than</span>
          <span className="flex items-center gap-2">
            <input aria-label="Largest PR in changed lines" type="number" min={10} max={100000} className={`${FIELD} w-24`} value={shown(value.maxLines)} onChange={(event) => set({ maxLines: number(event.target.value) })} />
            <span className="text-xs text-muted-foreground">changed lines</span>
          </span>
        </label>

        <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Reviewer concerns that hold a draft</div>
        <div className="grid grid-cols-1 gap-x-4 @2xl:grid-cols-2" data-concern-holds>
          {(["comment", "approve"] as const).map((verdict) => (
            <div key={verdict}>
              <div className="mb-0.5 text-xs font-medium">{verdict === "comment" ? "Comments" : "Approvals"}</div>
              {CONCERN_KINDS.map((kind) => (
                <Checkbox key={kind} label={CONCERN_LABELS[kind]} checked={value.holdConcerns[verdict].includes(kind)}
                  onChange={(on) => set({ holdConcerns: { ...value.holdConcerns, [verdict]: CONCERN_KINDS.filter((k) => (k === kind ? on : value.holdConcerns[verdict].includes(k))) } })} />
              ))}
            </div>
          ))}
        </div>

        <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Approvals</div>
        <div className="text-xs text-muted-foreground">
          Shuttle records, for every draft, whether these rules would approve the PR. It approves only where the approvals mode posts, from a review that suggested approving, with at least two critic threads behind it, and when the PR touches nothing outside the paths listed for the repository. An approval also needs a low-risk assessment, an open PR at the head the review read, no requested changes, and no bot author outside the allowed authors. It carries the findings that pass the gate as its comments, even when comments only record. Changing a rule a decision reads stops reviews already scheduled; check them again to schedule them anew. Footers, countdowns and the daily limit apply as they are.
        </div>
        <label className={row}>
          <span className={label}>Approve PRs up to</span>
          <span className="flex items-center gap-2">
            <input aria-label="Largest PR an approval may cover" type="number" min={1} max={100000} className={`${FIELD} w-24`} value={shown(value.approvals.maxLines)}
              onChange={(event) => set({ approvals: { ...value.approvals, maxLines: number(event.target.value) } })} />
            <span className="text-xs text-muted-foreground">changed lines</span>
          </span>
        </label>
        <label className={row}>
          <span className={label}>With findings up to</span>
          <select aria-label="Highest finding severity an approval may carry" className={FIELD} value={value.approvals.maxSeverity}
            onChange={(event) => set({ approvals: { ...value.approvals, maxSeverity: event.target.value as AutoPost["approvals"]["maxSeverity"] } })}>
            <option value="nit">Nits only</option>
            <option value="low">Low, posted as comments</option>
            <option value="medium">Medium, posted as comments</option>
          </select>
        </label>
        <label className={row}>
          <span className={label}>Checks</span>
          <select aria-label="Checks an approval needs" className={FIELD} value={value.approvals.checks}
            onChange={(event) => set({ approvals: { ...value.approvals, checks: event.target.value as AutoPost["approvals"]["checks"] } })}>
            <option value="passed">Every check passed</option>
            <option value="not_failed">None failed; some may still run</option>
          </select>
        </label>
        <label className={row}>
          <span className={label}>Blocking problems</span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            held when the verifier scores one at or above
            <input aria-label="Lowest verifier blocking score that holds an approval" type="number" min={0} max={1} step={0.05} className={`${FIELD} w-20`} value={shown(value.floors.blocking)}
              onChange={(event) => set({ floors: { ...value.floors, blocking: number(event.target.value) } })} />
          </span>
        </label>
        <label className={row}>
          <span className={label}>Target precision</span>
          <span className="flex items-center gap-2">
            <input aria-label="Approval target precision" type="number" min={0.5} max={1} step={0.01} className={`${FIELD} w-20`} value={shown(value.approvals.target)}
              onChange={(event) => set({ approvals: { ...value.approvals, target: number(event.target.value) } })} />
            <span className="text-xs text-muted-foreground">{Number.isNaN(value.approvals.target) ? "" : `${oneIn(value.approvals.target)} auto approvals you would not have given`}</span>
          </span>
        </label>

        <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Verifier</div>
        <label className="flex flex-col gap-1">
          <span className={label}>A command that reads the prompt on stdin and prints JSON with holds, worth_posting and reason. Keep tools off, so it judges only the evidence it gets.</span>
          <textarea aria-label="Verifier command" rows={2} className={FIELD_CODE} value={value.verifier} onChange={(event) => set({ verifier: event.target.value })} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {value.verifier.trim() !== DEFAULT_VERIFIER_COMMAND && (
            <button type="button" className={BUTTON_GHOST_SMALL} onClick={() => set({ verifier: DEFAULT_VERIFIER_COMMAND })}>Use the default (Kimi K3 through pi)</button>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Give it up to
            <input aria-label="Verifier timeout in seconds" type="number" min={10} max={600} className={`${FIELD} w-20`} value={shown(value.verifierTimeoutSeconds)}
              onChange={(event) => set({ verifierTimeoutSeconds: number(event.target.value) })} />
            seconds a finding
          </label>
        </div>
      </div>
    </div>
  );
}
