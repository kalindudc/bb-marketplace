import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  ThreadTitle, experimental_useProviders, experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreads, useSidebarThreadShortcut, type PluginBrowserBbSdk, type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { infoLoaders, useCached, type Resource } from "./info-data";
import * as format from "./info-format";
import { StatusGlyph } from "./status-glyph";
import { ageLabel } from "./time";
import { lastActivity } from "./triage";
import type { InfoCardMode } from "./settings";
import { STATE_LABEL, type RowState } from "./status";

type PullRequest = NonNullable<ReturnType<typeof experimental_useSidebarThreadPullRequest>["pullRequest"]>;
const PR_STATE: Record<PullRequest["state"], string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const PR_CHECKS: Partial<Record<PullRequest["experimental_checks"]["state"], string>> =
  { passing: "Checks passing", pending: "Checks pending", failing: "Checks failing" };
const PR_REVIEW: Partial<Record<PullRequest["experimental_review"]["state"], string>> =
  { review_requested: "Review requested", approved: "Approved", changes_requested: "Changes requested" };

const count = (value: number, one: string, many: string) => `${value.toLocaleString()} ${value === 1 ? one : many}`;
const ago = (now: number, at: number) => {
  const age = ageLabel(now, at);
  return age === "now" ? "just now" : `${age} ago`;
};
const messages = (outline: format.Outline) => {
  const { prompts, replies } = format.outlineSummary(outline);
  return `${count(prompts, "prompt", "prompts")} · ${count(replies, "reply", "replies")}`;
};

function Field<T>({ resource, children }: { resource: Resource<T>; children(value: T): ReactNode }): ReactNode {
  if (resource.status === "loading") return <span className="sb-info-skeleton" />;
  if (resource.status === "error") return "Unavailable";
  return children(resource.value) ?? "—";
}

function Meter({ usage }: { usage: format.Usage }) {
  const { percent, text } = format.usageSummary(usage);
  return <span className="sb-info-meter-row">
    <span className={`sb-info-meter ${percent >= 80 ? "sb-info-meter-high" : ""}`}><span style={{ width: `${percent}%` }} /></span>
    <span className="sb-info-mono">{text}</span>
  </span>;
}

function changesText(status: format.WorkspaceStatus): ReactNode {
  const changes = format.changesSummary(status);
  if (!changes) return null;
  const label = format.changesLabel(changes);
  const shown = changes.committed ?? changes.uncommitted;
  if (!shown) return label;
  return <span className="sb-info-mono">
    <span className="sb-info-added">+{shown.insertions.toLocaleString()}</span>{" "}
    <span className="sb-info-removed">−{shown.deletions.toLocaleString()}</span>{label.slice(label.indexOf(" · "))}
  </span>;
}

function aheadBehind(status: format.WorkspaceStatus, withBase: boolean): string | null {
  const changes = format.changesSummary(status);
  if (!changes || (withBase && !changes.base)) return null;
  return `↑${changes.ahead.toLocaleString()} ↓${changes.behind.toLocaleString()}${withBase ? ` vs ${changes.base}` : ""}`;
}

const pullRequestWords = (pr: PullRequest) =>
  [`#${pr.number} ${PR_STATE[pr.state]}`, PR_CHECKS[pr.experimental_checks.state], PR_REVIEW[pr.experimental_review.state]]
    .filter((word): word is string => word !== undefined);

export function InfoCardBody({ thread, state, projectName, stale, now, mode, sdk }: { thread: PluginSidebarThread; state: RowState;
  projectName: string; stale: boolean; now: number; mode: Exclude<InfoCardMode, "off">; sdk: PluginBrowserBbSdk }): ReactElement {
  const sidebar = experimental_useSidebarThreads();
  const { providers } = experimental_useProviders();
  const { pullRequest } = experimental_useSidebarThreadPullRequest(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const environmentId = thread.environment?.id ?? null;
  // The loaders read only these fields of the thread, so a streaming thread keeps its loaders.
  const loaders = useMemo(() => infoLoaders(sdk, thread, mode), [sdk, thread.id, environmentId, thread.hasPendingInteraction, mode]);
  const options = useCached(loaders.options)!;
  const usage = useCached(loaders.usage)!;
  const outline = useCached(loaders.outline);
  const asks = useCached(loaders.asks);
  const changes = useCached(loaders.changes);

  const provider = providers.find((entry) => entry.id === thread.providerId);
  const reasoning = (value: NonNullable<format.ExecutionOptions>) =>
    provider?.reasoningLevels?.find((level) => level.id === value.reasoningLevel)?.label ?? value.reasoningLevel;
  const model = (value: format.ExecutionOptions) => value && [format.modelLabel(value.model), reasoning(value)].filter(Boolean).join(" · ");
  const branch = thread.environment?.branchName ?? null;
  const machine = thread.host?.name ?? null;
  const sectionId = format.rootThread(sidebar.threads, thread).sectionId;
  const section = sidebar.sections.find((entry) => entry.id === sectionId)?.name ?? "Threads";
  const parent = thread.parentThreadId ? sidebar.threads.find((entry) => entry.id === thread.parentThreadId)?.displayTitle : undefined;
  const children = format.childrenLabel(sidebar.threads, thread.id);
  const background = format.backgroundLabels(thread);
  const age = ageLabel(now, lastActivity(thread));
  const ask = asks && !(asks.status === "ready" && format.askSummary(asks.value) === null) && asks;

  const header = <>
    <div className="sb-info-top">
      <StatusGlyph state={state} label={STATE_LABEL[state]} />
      <span>{thread.indicatorLabel ?? STATE_LABEL[state]} · {age === "now" ? "active now" : `${age} ago`}</span>
      {shortcut && <span className="sb-info-kbd sb-info-mono">{shortcut.label}</span>}
    </div>
    <div className="sb-info-title"><ThreadTitle threadId={thread.id} /></div>
    <div className="sb-info-crumb">{projectName} › {section}</div>
    {parent && <div className="sb-info-crumb">↳ Child of {parent}</div>}
    {stale && <div className="sb-info-crumb">Idle for {Math.floor((now - lastActivity(thread)) / 86_400_000)} days</div>}
    {ask && <div className="sb-info-ask">⚑ <Field resource={ask}>{format.askSummary}</Field></div>}
  </>;

  if (mode === "glance") return <>
    {header}
    <dl className="sb-info-rows">
      <dt>Model</dt><dd><Field resource={options}>{model}</Field></dd>
      <dt>Context</dt><dd><Field resource={usage}>{(value) => value && <Meter usage={value} />}</Field></dd>
      {branch ? <><dt>Branch</dt><dd className="sb-info-mono">{branch}</dd></> :
        machine && <><dt>Machine</dt><dd>{machine}</dd></>}
      {changes && <><dt>Changes</dt><dd><Field resource={changes}>{changesText}</Field></dd></>}
      {pullRequest && <><dt>Pull request</dt><dd>#{pullRequest.number} {PR_STATE[pullRequest.state]}</dd></>}
    </dl>
  </>;

  if (mode === "briefing") return <>
    {header}
    {outline && <>
      <div className="sb-info-sep" />
      <div className="sb-info-label">Asked</div>
      <div className="sb-info-text"><Field resource={outline}>{(value) => format.outlineSummary(value).asked}</Field></div>
      <div className="sb-info-label">Latest</div>
      <div className="sb-info-text"><Field resource={outline}>{(value) => format.outlineSummary(value).latest}</Field></div>
      <div className="sb-info-line sb-info-muted"><Field resource={outline}>{messages}</Field></div>
    </>}
    <div className="sb-info-sep" />
    <div className="sb-info-line">
      <span className="sb-info-chip"><Field resource={options}>{model}</Field></span>
      <span className="sb-info-chip"><Field resource={options}>{(value) => value && format.permissionLabel(value.permissionMode)}</Field></span>
    </div>
    <div className="sb-info-line"><span className="sb-info-muted">Context</span><Field resource={usage}>{(value) => value && <Meter usage={value} />}</Field></div>
    {branch && <div className="sb-info-line sb-info-single">
      <span className="sb-info-muted">⑂</span><span className="sb-info-mono sb-info-ellipsis">{branch}</span>
      {thread.environment?.isWorktree && <span className="sb-info-chip">worktree</span>}
    </div>}
    {changes && <div className="sb-info-line">
      <Field resource={changes}>{changesText}</Field>
      <span className="sb-info-muted sb-info-mono"><Field resource={changes}>{(value) => aheadBehind(value, false)}</Field></span>
    </div>}
    {pullRequest && <div className="sb-info-line">{pullRequestWords(pullRequest).map((word) => <span key={word} className="sb-info-chip">{word}</span>)}</div>}
    {(children || background.length > 0) && <div className="sb-info-line">
      {children && <span className="sb-info-chip">↳ {children}</span>}
      {background.map((word) => <span key={word} className="sb-info-chip">{word}</span>)}
    </div>}
    <div className="sb-info-sep" />
    <div className="sb-info-foot">Created {ago(now, thread.createdAt)}{machine && ` · ${machine}`}</div>
  </>;

  const cell = (label: string, value: ReactNode, span = false) =>
    <div className={span ? "sb-info-span" : undefined}><div className="sb-info-label">{label}</div><div className="sb-info-value">{value}</div></div>;
  return <>
    {header}
    <div className="sb-info-grid">
      {cell("Provider", provider?.displayName ?? thread.providerId)}
      {cell("Model", <Field resource={options}>{(value) => value && format.modelLabel(value.model)}</Field>)}
      {cell("Reasoning", <Field resource={options}>{(value) => value && reasoning(value)}</Field>)}
      {cell("Permissions", <Field resource={options}>{(value) => value && format.permissionLabel(value.permissionMode)}</Field>)}
      {cell("Context", <Field resource={usage}>{(value) => value && <>
        <Meter usage={value} />{format.costLabel(value) && <span className="sb-info-muted"> · {format.costLabel(value)}</span>}
      </>}</Field>, true)}
      {cell("Messages", outline ? <Field resource={outline}>{messages}</Field> : "—")}
      {cell("Children", children ?? "—")}
      {cell("Background", background.length ? background.join(", ") : "—")}
      {cell("Branch", branch ? <span className="sb-info-mono">{branch}</span> : "—", true)}
      {cell("Changes", changes ? <Field resource={changes}>{changesText}</Field> : "—")}
      {cell("Base", changes ? <Field resource={changes}>{(value) => aheadBehind(value, true)}</Field> : "—")}
      {cell("Pull request", pullRequest ? pullRequestWords(pullRequest).join(" · ") : "—", true)}
      {cell("Machine", machine ?? "—")}
      {cell("Environment", thread.environment ? thread.environment.isWorktree ? "Managed worktree" : "Checkout" : "—")}
      {cell("Created", ago(now, thread.createdAt))}
      {cell("Last read", thread.lastReadAt === null ? "—" : ago(now, thread.lastReadAt))}
    </div>
  </>;
}
