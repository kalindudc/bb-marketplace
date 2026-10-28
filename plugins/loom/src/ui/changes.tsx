import { useEffect, useState, useSyncExternalStore } from "react";
import { experimental_Diff as Diff, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ChangedFile, ChangeSource, ChangesView, ControlAction, FilePatch, ProjectView, RepoOverview, rpcContract } from "../contract";
import { formatDuration, isMultiRepoProject, readyToLand } from "../format";
import { BUTTON, ConfirmButton, HEADING, RepoChip, StateBadge, messageOf, plural } from "./common";

const LIVE_REFRESH_MS = 10_000;
const VIEWED_LIMIT = 5000;
const STATUS_LETTERS: Record<ChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", type_changed: "T" };
const STATUS_TONES: Record<ChangedFile["status"], string> = { added: "text-success", modified: "text-warning-text", deleted: "text-destructive-text", renamed: "text-primary", copied: "text-primary", type_changed: "text-warning-text" };

const short = (sha: string | null) => (sha === null ? "" : sha.slice(0, 7));
const totals = (files: readonly ChangedFile[]) => files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });

function Counts({ files }: { files: readonly ChangedFile[] }) {
  const { additions, deletions } = totals(files);
  return (
    <span className="font-mono text-[11px] whitespace-nowrap">
      <span className="text-success">+{additions}</span> <span className="text-destructive-text">−{deletions}</span>
    </span>
  );
}

// ---------------------------------------------------------------- viewed marks

/** A changed file and the repo it changed in, null on a single-repo project: what a Viewed mark is kept for. */
export interface RepoFile {
  repo: string | null;
  file: ChangedFile;
}

// A mark holds a file's path and fingerprint, so it clears by itself when the file changes again; on a multi-repo project
// it holds the repo first, and a single-repo project's marks keep the form they had before projects had repos. Marks live
// in local storage, read again when it changes; when storage is unavailable they last as long as the page.
const remembered = new Map<string, { raw: string | null; marks: Set<string> }>();
const listeners = new Set<() => void>();
const keyOf = (slug: string) => `loom.viewed.${slug}`;
const markOf = ({ repo, file }: RepoFile) => `${repo === null ? "" : `${repo}\u0000`}${file.path}\u0000${file.fingerprint}`;
const NO_MARKS = new Set<string>();

function parseMarks(raw: string | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((mark): mark is string => typeof mark === "string") : []);
  } catch {
    return new Set();
  }
}

function marksOf(slug: string): Set<string> {
  const known = remembered.get(slug);
  let raw: string | null;
  try {
    raw = localStorage.getItem(keyOf(slug));
  } catch {
    return known?.marks ?? NO_MARKS;
  }
  if (known !== undefined && known.raw === raw) return known.marks;
  const marks = parseMarks(raw);
  remembered.set(slug, { raw, marks });
  return marks;
}

function setMark(slug: string, file: RepoFile, viewed: boolean): void {
  const next = new Set(marksOf(slug));
  next.delete(markOf(file));
  if (viewed) next.add(markOf(file));
  const raw = JSON.stringify([...next].slice(-VIEWED_LIMIT));
  try {
    localStorage.setItem(keyOf(slug), raw);
  } catch {}
  remembered.set(slug, { raw, marks: parseMarks(raw) });
  for (const listener of listeners) listener();
}

/** The project's viewed marks, shared by the Changes tab and its badge. */
export function useViewed(slug: string) {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => marksOf(slug),
  );
  return {
    has: (file: RepoFile) => current.has(markOf(file)),
    set: (file: RepoFile, viewed: boolean) => setMark(slug, file, viewed),
    unviewed: (files: readonly RepoFile[]) => files.filter((file) => !current.has(markOf(file))).length,
  };
}

const filesOf = (source: ChangeSource): RepoFile[] => (source.files ?? []).map((file) => ({ repo: source.repo, file }));

/** What Land would push: the files of every repo's integration branch, or null when there is nothing to count. */
export function landingFiles(changes: ChangesView | null): RepoFile[] | null {
  const branches = (changes?.sources ?? []).filter((source) => source.kind === "branch" && !source.gone && source.files !== null);
  return branches.length === 0 ? null : branches.flatMap(filesOf);
}

// ---------------------------------------------------------------- the source list

function sourceDetail(source: ChangeSource, now: number): string {
  if (source.kind === "branch") return `vs ${source.against}${source.files === null ? "" : ` · ${plural(source.files.length, "file")}`}`;
  if (source.kind === "merge") return `merge ${short(source.head)}${source.at === null ? "" : ` · ${formatDuration(now - source.at)} ago`}`;
  if (source.kind === "live") return `live worktree · attempt ${source.attempt}`;
  if (source.head === null) return source.note ?? "no changes";
  return source.state === "review" ? `commit ${short(source.head)} · review round ${source.reviewRound}` : `commit ${short(source.head)}`;
}

function SourceRow({ source, selected, now, branch, onSelect }: { source: ChangeSource; selected: boolean; now: number; branch: string | null; onSelect(): void }) {
  const empty = source.files !== null && source.files.length === 0;
  return (
    <button
      type="button"
      data-source={source.id}
      aria-current={selected ? "true" : undefined}
      disabled={empty}
      onClick={onSelect}
      className={`block w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs disabled:cursor-default disabled:opacity-50 ${source.kind === "merge" ? "pl-5" : ""} ${selected ? "bg-surface-selected" : "hover:bg-state-hover"}`}
    >
      <span className="flex items-center gap-1.5">
        {source.kind === "branch" ? <span className="font-mono font-semibold">{branch}</span> : <span className="font-medium">{source.key}</span>}
        {source.kind !== "branch" && source.kind !== "merge" && source.state !== null && <StateBadge state={source.state} />}
      </span>
      <span className="mt-0.5 flex flex-wrap gap-x-1.5 text-muted-foreground">
        <span>{sourceDetail(source, now)}</span>
        {source.files !== null && source.files.length > 0 && <Counts files={source.files} />}
      </span>
    </button>
  );
}

const onBranch = (source: ChangeSource) => source.kind === "branch" || source.kind === "merge";

/** On a multi-repo project, one section per repo in [[repo]] order, headed by its chip; a repo that cannot be read says why in its section. */
function SourceList({ changes, selected, now, onSelect }: { changes: ChangesView; selected: ChangeSource | null; now: number; onSelect(id: string): void }) {
  const shown = changes.sources.filter((source) => !source.gone);
  const gone = changes.sources.length - shown.length;
  const row = (source: ChangeSource) => <SourceRow key={source.id} source={source} selected={source.id === selected?.id} now={now} branch={changes.branch} onSelect={() => onSelect(source.id)} />;
  const groups = (sources: ChangeSource[], Heading: "h3" | "h4") => {
    const titled: Array<[string, ChangeSource[]]> =
      changes.strategy === "pr"
        ? [["Tickets", sources]]
        : [
            [changes.finished ? "What merged" : "On the integration branch", sources.filter(onBranch)],
            [changes.finished ? "Not merged" : "Not merged yet", sources.filter((source) => !onBranch(source))],
          ];
    return titled
      .filter(([, entries]) => entries.length > 0)
      .map(([title, entries]) => (
        <div key={title} className="space-y-0.5">
          <Heading className={`${HEADING} px-2`}>{title}</Heading>
          {entries.map(row)}
        </div>
      ));
  };
  return (
    <nav aria-label="Change sources" data-change-sources className="w-full shrink-0 space-y-3 border-b border-border-seam p-2 md:w-64 md:border-r md:border-b-0">
      {isMultiRepoProject(changes)
        ? changes.repos.map((repo) => {
            const own = shown.filter((source) => source.repo === repo.name);
            return (
              <section key={repo.name} data-change-repo={repo.name} aria-label={`repo ${repo.name}`} className="space-y-2">
                <h3 className="px-2">
                  <RepoChip name={repo.name!} />
                </h3>
                {repo.unavailable !== null ? (
                  <p data-repo-unavailable className="px-2 text-xs text-muted-foreground">
                    {repo.unavailable}
                  </p>
                ) : own.length === 0 ? (
                  <p className="px-2 text-xs text-muted-foreground">{changes.sources.some((source) => source.repo === repo.name) ? "Its changes are no longer in the repository." : "No changes yet."}</p>
                ) : (
                  groups(own, "h4")
                )}
              </section>
            );
          })
        : groups(shown, "h3")}
      {gone > 0 && (
        <p data-gone className="px-2 text-xs text-muted-foreground">
          {gone === 1 ? "1 part of this project is" : `${gone} parts of this project are`} no longer in the repository, so {gone === 1 ? "it is" : "they are"} left out.
        </p>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------- one file

function FileDiff({ slug, source, file, view }: { slug: string; source: ChangeSource; file: ChangedFile; view: "unified" | "split" }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ patch: FilePatch | null; error: string | null }>({ patch: null, error: null });
  const live = source.kind === "live";
  useEffect(() => {
    let current = true;
    const repo = source.repo === null ? {} : { repo: source.repo };
    const input = live ? { slug, path: file.path, key: source.key!, ...repo } : { slug, path: file.path, base: source.base!, head: source.head!, ...repo };
    rpc.call("changePatch", input).then(
      (patch) => current && setState({ patch, error: null }),
      (error) => current && setState({ patch: null, error: messageOf(error) }),
    );
    return () => {
      current = false;
    };
  }, [rpc, slug, live, source.repo, source.key, source.base, source.head, file.path, file.fingerprint]);

  if (file.binary) return <p className="px-3 py-2 text-xs text-muted-foreground">Binary file, not shown.</p>;
  if (state.error !== null) return <p role="alert" className="px-3 py-2 text-xs text-destructive-text">Could not load the patch: {state.error}</p>;
  if (state.patch === null) return <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>;
  if (state.patch.patch === null) return <p className="px-3 py-2 text-xs text-muted-foreground">{state.patch.message}</p>;
  if (state.patch.patch === "") return <p className="px-3 py-2 text-xs text-muted-foreground">No line changes, such as a change of file mode.</p>;
  return (
    <div data-file-diff>
      <Diff patch={state.patch.patch} path={file.path} view={view} />
      {state.patch.truncated && <p className="px-3 py-2 text-xs text-warning-text">The patch is longer than 400 KB, so it is cut short here.</p>}
    </div>
  );
}

function FileRow(props: { slug: string; source: ChangeSource; file: ChangedFile; open: boolean; viewed: boolean; view: "unified" | "split"; onToggle(): void; onViewed(viewed: boolean): void; onTicket(key: string): void }) {
  const { file, open, viewed } = props;
  return (
    <div data-file={file.path} data-viewed={viewed ? "" : undefined} className="overflow-hidden rounded-md border border-border-seam">
      <div className="flex flex-wrap items-center gap-2 bg-surface-recessed px-2.5 py-1.5 text-xs">
        <button type="button" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${file.path}`} onClick={props.onToggle} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
          <span aria-hidden className="w-3 text-muted-foreground">
            {open ? "▾" : "▸"}
          </span>
          <span title={file.status.replace("_", " ")} className={`w-3 text-center text-[10px] font-bold ${STATUS_TONES[file.status]}`}>
            {STATUS_LETTERS[file.status]}
          </span>
          <span className={`min-w-0 truncate font-mono ${viewed ? "text-muted-foreground" : ""}`}>
            {file.previousPath !== null && file.previousPath !== file.path ? `${file.previousPath} → ` : ""}
            {file.path}
          </span>
        </button>
        {file.tickets.map((key) => (
          <button key={key} type="button" data-file-ticket={key} onClick={() => props.onTicket(key)} className="cursor-pointer rounded border border-border-seam px-1 text-[10.5px] text-muted-foreground hover:text-foreground">
            {key}
          </button>
        ))}
        {file.untracked && <span className="rounded-full border border-warning px-1.5 text-[10.5px] text-warning-text">new, not committed</span>}
        <Counts files={[file]} />
        <button type="button" aria-pressed={viewed} onClick={() => props.onViewed(!viewed)} className={`cursor-pointer rounded border px-1.5 text-[11px] ${viewed ? "border-success text-success" : "border-border-seam text-muted-foreground hover:text-foreground"}`}>
          {viewed ? "✓ Viewed" : "Viewed"}
        </button>
      </div>
      {open && <FileDiff slug={props.slug} source={props.source} file={file} view={props.view} />}
    </div>
  );
}

// ---------------------------------------------------------------- the selected source

function SourceIntro({ changes, source, view, busy, onControl }: { changes: ChangesView; source: ChangeSource; view: ProjectView; busy: boolean; onControl(action: ControlAction, repo?: string): void }) {
  const navigate = useBbNavigate();
  const { overview } = view;
  const files = source.files ?? [];
  const card = view.board.find((entry) => entry.key === source.key);
  const openTicket = source.key === null ? null : (
    <button type="button" className={BUTTON} onClick={() => navigate.toPluginPanel("loom", { subPath: `${changes.slug}/${source.key}` })}>
      Open ticket
    </button>
  );
  const sizes = (
    <>
      {plural(files.length, "file")}, <Counts files={files} />
    </>
  );

  if (source.kind === "branch") {
    // A multi-repo project's branch source is one repo's: it lands that repo alone, onto that repo's base.
    const repo = source.repo === null ? null : changes.repos.find((entry) => entry.name === source.repo)!;
    const name = repo?.name ?? null;
    const branch = repo?.branch ?? changes.branch;
    const base = repo?.base ?? changes.base;
    const own = overview.repos.find((entry) => entry.name === name);
    // A repo has a done ticket exactly when it has work to land or was landed, as repoLand in next-step-bar.tsx counts it.
    const hasDone = name === null ? (overview.ticketCounts.done ?? 0) > 0 : own !== undefined && (own.toLand || own.landedAt !== null);
    const landable = changes.strategy === "integration" && (overview.state === "running" || overview.state === "paused") && hasDone;
    const merged = changes.sources.filter((entry) => entry.kind === "merge" && entry.repo === source.repo).length;
    return (
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">
          {name !== null && <RepoChip name={name} className="mr-1.5 align-middle" />}
          {changes.finished ? (
            <>
              What <span className="font-mono">{branch}</span> merged
            </>
          ) : (
            <>
              <span className="font-mono">{branch}</span> compared with <span className="font-mono">{source.against}</span>
            </>
          )}
        </h2>
        <p className="text-xs text-muted-foreground">
          {changes.finished ? `From before its first merge to its last, ${short(source.head)}: ` : "Everything merged so far: "}
          {plural(merged, "ticket")}, {sizes}
          {changes.finished ? "." : `, at ${short(source.head)}.`}
        </p>
        {landable && (
          <div data-land-panel className="flex flex-wrap items-center gap-3 rounded-md border border-border-seam px-3 py-2.5">
            {name === null ? (
              <p className="min-w-0 flex-1 text-xs">
                {readyToLand(overview) && <b>This is what lands. </b>}
                Land pushes <span className="font-mono">{changes.branch}</span> at <span className="font-mono">{short(source.head)}</span> and opens one pull request into {changes.base}, or updates the one already open. Land to {changes.base} merges{" "}
                <span className="font-mono">{changes.remoteBase}</span> in, runs the after_merge checks and pushes straight to {changes.base}.
              </p>
            ) : (
              <p className="min-w-0 flex-1 text-xs">
                {readyToLand(overview) && <b>This is what lands in {name}. </b>}
                Land {name} pushes <span className="font-mono">{branch}</span> in {name} at <span className="font-mono">{short(source.head)}</span> and opens one pull request into {base}, or updates the one already open. Land {name} to {base} merges{" "}
                <span className="font-mono">{repo!.remoteBase}</span> in, runs the after_merge checks and pushes straight to {base}. The other repos do not land.
              </p>
            )}
            {name === null ? (
              <>
                <ConfirmButton label="Land" confirmLabel="Click again to land" disabled={busy} onConfirm={() => onControl("land")} />
                <ConfirmButton label={`Land to ${changes.base}`} disabled={busy} onConfirm={() => onControl("landDirect")} />
              </>
            ) : (
              <>
                <ConfirmButton label={`Land ${name}`} confirmLabel={`Click again to land ${name}`} disabled={busy} onConfirm={() => onControl("land", name)} />
                <ConfirmButton label={`Land ${name} to ${base}`} confirmLabel={`Click again to land ${name} to ${base}`} disabled={busy} onConfirm={() => onControl("landDirect", name)} />
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  const title = (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">
        {source.key} · {source.title}
      </h2>
      <StateBadge state={source.kind === "merge" ? "merged" : source.state!} />
      {source.repo !== null && <RepoChip name={source.repo} />}
      {openTicket}
      {card?.prUrl != null && (
        <button type="button" className={BUTTON} onClick={() => navigate.openUrl(card.prUrl!)}>
          Open pull request
        </button>
      )}
    </div>
  );
  if (source.kind === "merge") {
    return (
      <div className="space-y-2">
        {title}
        <p className="text-xs text-muted-foreground">
          What its merge <span className="font-mono">{short(source.head)}</span> added to <span className="font-mono">{source.against}</span>
          {source.at === null ? "" : `, ${formatDuration(view.now - source.at)} ago`}: {sizes}.
        </p>
      </div>
    );
  }
  if (source.kind === "live") {
    return (
      <div className="space-y-2">
        {title}
        <div data-live className="flex flex-wrap items-center gap-3 rounded-md border border-warning bg-warning/10 px-3 py-2.5">
          <p className="min-w-0 flex-1 text-xs text-warning-text">
            <b>Live.</b> The worker is still editing, so this is its worktree now, uncommitted changes included, against <span className="font-mono">{source.against}</span>. It refreshes every 10 seconds while you watch, and none of it has passed the checks yet.
          </p>
          {card?.threadId != null && (
            <button type="button" className={BUTTON} onClick={() => navigate.toThread(card.threadId!)}>
              Open worker thread
            </button>
          )}
        </div>
      </div>
    );
  }
  const reviewed = source.state === "review" || source.state === "approved" || source.state === "merging" || source.state === "pr_open";
  return (
    <div className="space-y-2">
      {title}
      <p className="text-xs text-muted-foreground">
        {reviewed ? "Commit " : "Its last commit, "}
        <span className="font-mono">{short(source.head)}</span>
        {reviewed ? ", the one that passed the checks and the diff the reviewers read," : ","} against <span className="font-mono">{source.against}</span>
        {changes.strategy === "pr" && source.state === "done" ? ", as it merged" : ""}: {sizes}.
      </p>
    </div>
  );
}

/**
 * The source to show: the one chosen (by id, or a ticket's key), else the whole branch, else the first with changes. On a multi-repo project
 * the whole branch is that of the first repo, in [[repo]] order, with work to land by `repos`, else of the first repo, and "branch" chooses it;
 * a repo that cannot be read is passed over.
 */
export function pickSource(changes: ChangesView, chosen: string | null, repos: readonly RepoOverview[] = []): ChangeSource | null {
  const shown = changes.sources.filter((source) => !source.gone);
  const picked = chosen === null ? undefined : shown.find((source) => source.id === chosen || source.key === chosen);
  if (picked !== undefined && (picked.files === null || picked.files.length > 0 || picked.kind === "branch")) return picked;
  if (!isMultiRepoProject(changes)) return shown.find((source) => source.files === null || source.files.length > 0) ?? shown[0] ?? null;
  const readable = changes.repos.filter((repo) => repo.unavailable === null);
  const landing = readable.find((repo) => repos.some((entry) => entry.name === repo.name && entry.toLand)) ?? readable[0];
  const listed = shown.filter((source) => readable.some((repo) => repo.name === source.repo));
  return listed.find((source) => source.kind === "branch" && source.repo === landing?.name) ?? listed.find((source) => source.files === null || source.files.length > 0) ?? listed[0] ?? null;
}

export function ChangesTab(props: { changes: ChangesView | null; error: string | null; view: ProjectView; busy: boolean; chosen: string | null; onChoose(id: string): void; onControl(action: ControlAction, repo?: string): void; onReload(): void }) {
  const { changes, view, chosen } = props;
  const slug = view.overview.slug;
  const viewed = useViewed(slug);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const source = changes === null ? null : pickSource(changes, chosen, view.overview.repos);
  const live = source?.kind === "live";
  const { onReload } = props;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(onReload, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, onReload]);
  // Reset while rendering, not in an effect, so a path open in one source never opens, and reads, the same path in the next one.
  const [openIn, setOpenIn] = useState(source?.id);
  if (openIn !== source?.id) {
    setOpenIn(source?.id);
    setOpen(new Set());
  }

  if (changes === null) {
    return props.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load the changes: {props.error}</p>;
  }
  // A multi-repo project keeps its repo sections whatever happens, so each repo that cannot be read still says why and how to fix it.
  const multi = isMultiRepoProject(changes);
  if (!multi && changes.unavailable !== null) return <p data-changes-unavailable className="p-4 text-sm text-muted-foreground">{changes.unavailable}</p>;
  if (source === null) {
    const nothing = changes.sources.length > 0 ? "This project's changes are no longer in the repository." : "No changes yet.";
    if (!multi) return <p className="p-4 text-sm text-muted-foreground">{nothing}</p>;
    const unreadable = changes.repos.some((repo) => repo.unavailable !== null);
    return (
      <div data-changes className="flex min-h-0 flex-col md:flex-row">
        <SourceList changes={changes} selected={null} now={view.now} onSelect={props.onChoose} />
        <p data-changes-empty className="min-w-0 flex-1 p-4 text-sm text-muted-foreground">
          {changes.unavailable !== null
            ? "None of the project's repos can be read; each repo's section says why."
            : `${changes.sources.some((entry) => entry.gone) ? "The changes of the repos that can be read are no longer in their repositories." : "No changes yet."}${unreadable ? " A repo that cannot be read says why in its section." : ""}`}
        </p>
      </div>
    );
  }

  const files = source.files ?? [];
  const seen = files.length - viewed.unviewed(filesOf(source));
  const toggle = (path: string) => setOpen((before) => {
    const next = new Set(before);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  return (
    <div data-changes className="flex min-h-0 flex-col md:flex-row">
      <SourceList changes={changes} selected={source} now={view.now} onSelect={props.onChoose} />
      <div data-change-source={source.id} className="min-w-0 flex-1 space-y-3 p-4">
        {/* Keyed by source, so a Land armed for one repo is disarmed when another repo shows. */}
        <SourceIntro key={source.id} changes={changes} source={source} view={view} busy={props.busy} onControl={props.onControl} />
        {source.files === null ? (
          <p role="alert" className="text-xs text-destructive-text">{source.note}</p>
        ) : files.length === 0 ? (
          <p className="text-xs text-muted-foreground">{source.note ?? "No files differ."}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span role="group" aria-label="Diff layout" className="inline-flex overflow-hidden rounded-md border border-border-seam text-xs">
                {(["unified", "split"] as const).map((option) => (
                  <button key={option} type="button" aria-pressed={mode === option} onClick={() => setMode(option)} className={`cursor-pointer px-2.5 py-1 capitalize ${mode === option ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
                    {option}
                  </button>
                ))}
              </span>
              <button type="button" className={BUTTON} onClick={() => setOpen(new Set(files.map((file) => file.path)))}>
                Expand all
              </button>
              <button type="button" className={BUTTON} onClick={() => setOpen(new Set())}>
                Collapse all
              </button>
              <span data-viewed-progress className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                Viewed {seen} of {files.length}
                <span aria-hidden className="h-1.5 w-24 overflow-hidden rounded-full bg-state-hover">
                  <span className="block h-full bg-success" style={{ width: `${Math.round((seen / files.length) * 100)}%` }} />
                </span>
              </span>
            </div>
            {source.truncated && <p className="text-xs text-warning-text">Showing the first {plural(files.length, "file")}.</p>}
            <div className="space-y-2">
              {files.map((file) => (
                <FileRow
                  key={file.path}
                  slug={slug}
                  source={source}
                  file={file}
                  open={open.has(file.path)}
                  viewed={viewed.has({ repo: source.repo, file })}
                  view={mode}
                  onToggle={() => toggle(file.path)}
                  onViewed={(next) => {
                    viewed.set({ repo: source.repo, file }, next);
                    if (next) setOpen((before) => new Set([...before].filter((path) => path !== file.path)));
                  }}
                  onTicket={props.onChoose}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
