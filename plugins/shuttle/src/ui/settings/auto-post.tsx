import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { AUTO_POST_MODES, AUTO_POST_SEVERITIES, CONCERN_KINDS, DEFAULT_VERIFIER_COMMAND, type AutoPost, type AutoPostRepo, type ConcernKind } from "../../config";
import { BUTTON, BUTTON_GHOST_SMALL, CARD, Checkbox, FIELD, FIELD_CODE } from "../common";

/** A repository row as edited: its held paths and allowed authors as lines of globs until it is saved. */
export type AutoPostRepoDraft = AutoPostRepo & { paths: string; authors: string };
export type AutoPostDraft = Omit<AutoPost, "repos"> & { repos: AutoPostRepoDraft[] };

const splitGlobs = (text: string) => text.split(/[\s,]+/u).filter((glob) => glob !== "");

export const toAutoPostDraft = (value: AutoPost): AutoPostDraft => ({ ...value, repos: value.repos.map((repo) => ({ ...repo, paths: repo.holdPaths.join(", "), authors: repo.allowAuthors.join(", ") })) });

/** Rows without a repository are dropped; held paths are split into globs. */
export const fromAutoPostDraft = (draft: AutoPostDraft): AutoPost => ({
  ...draft,
  repos: draft.repos.filter((repo) => repo.repo.trim() !== "").map(({ paths, authors, ...repo }) => ({ ...repo, repo: repo.repo.trim(), holdPaths: splitGlobs(paths), allowAuthors: splitGlobs(authors) })),
});

const MODE_LABELS: Record<(typeof AUTO_POST_MODES)[number], string> = { off: "Off", shadow: "Shadow: decide, never post" };
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

/** Auto post: which repositories it watches, the verifier it asks, and the bar a finding must clear. */
export function AutoPostCard({ value, onChange }: { value: AutoPostDraft; onChange(next: AutoPostDraft): void }) {
  const set = (patch: Partial<AutoPostDraft>) => onChange({ ...value, ...patch });
  const setRepo = (index: number, patch: Partial<AutoPostRepoDraft>) => set({ repos: value.repos.map((repo, i) => (i === index ? { ...repo, ...patch } : repo)) });
  const number = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));
  const row = "grid grid-cols-1 items-center gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3";
  const label = "text-xs text-muted-foreground";
  const shown = (n: number) => (Number.isNaN(n) ? "" : n);
  return (
    <div className={CARD} data-auto-post-settings>
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <Icon name="Eye" className="size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Auto post</div>
          <div className="text-xs text-muted-foreground">
            Check each AI review draft against the review's critic votes, the code it quotes and a fast verifier. Shadow mode records what Shuttle would post and never posts; Insights › Auto post compares it with what you post.
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 pb-3.5 text-sm">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Repositories</div>
        {value.repos.length === 0 && <div className="text-xs text-muted-foreground">Off everywhere. Add a repository to start shadow mode there.</div>}
        {value.repos.map((repo, index) => (
          <div key={index} data-auto-post-repo={index} className="rounded-md border border-border px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label={`Repository ${index + 1}`} className={`${FIELD} min-w-0 flex-1 font-mono`} placeholder="acme/app, or a glob such as acme/*" value={repo.repo}
                onChange={(event) => setRepo(index, { repo: event.target.value })} />
              <select aria-label={`Mode for repository ${index + 1}`} className={FIELD} value={repo.mode} onChange={(event) => setRepo(index, { mode: event.target.value as AutoPostRepo["mode"] })}>
                {AUTO_POST_MODES.map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
              </select>
              <button type="button" className={BUTTON_GHOST_SMALL} aria-label={`Remove repository ${index + 1}`} onClick={() => set({ repos: value.repos.filter((_, i) => i !== index) })}>
                <Icon name="X" className="size-3.5" aria-hidden />
              </button>
            </div>
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
          </div>
        ))}
        <div>
          <button type="button" className={BUTTON} onClick={() => set({ repos: [...value.repos, { repo: "", mode: "shadow", guidelines: "", holdPaths: [], allowAuthors: [], paths: "", authors: "" }] })}>
            <Icon name="Plus" className="size-3.5" aria-hidden />Add repository
          </button>
        </div>

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
          Shadow mode records, for every draft, whether these rules would approve the PR. Nothing is approved. An approval also needs a low-risk assessment, an open PR at the head the review read, no requested changes, and no bot author outside the allowed authors.
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
