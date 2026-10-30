import { experimental_Icon as Icon, experimental_usePluginId, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ChangedFile, ConversationItem, FileChange, PrDetails, PrView } from "../contract";
import { Avatar } from "./avatar";
import { BUTTON, Pill } from "./common";
import { openExternal, useShuttleQuery } from "./data";
import { age, plural, settingsHref } from "./format";

const CHANGE_LOOKS: Record<FileChange, { letter: string; className: string; title: string }> = {
  added: { letter: "A", className: "bg-success/10 text-success", title: "Added" },
  modified: { letter: "M", className: "bg-warning/10 text-warning-text", title: "Modified" },
  removed: { letter: "D", className: "bg-surface-destructive text-destructive-text", title: "Deleted" },
  renamed: { letter: "R", className: "bg-surface-recessed text-foreground", title: "Renamed" },
  copied: { letter: "C", className: "bg-surface-recessed text-foreground", title: "Copied" },
  changed: { letter: "M", className: "bg-warning/10 text-warning-text", title: "Changed" },
};

/** A github.com PR opens straight on its files; any other server's link opens as it is. */
export const diffUrl = (pr: Pick<PrView, "url">) => (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/u.test(pr.url) ? `${pr.url.replace(/\/$/u, "")}/files` : pr.url);

function DiffBar({ file }: { file: ChangedFile }) {
  const added = file.additions ?? 0;
  const removed = file.deletions ?? 0;
  const total = added + removed;
  const green = total === 0 ? 0 : Math.round((added / total) * 5);
  const red = total === 0 ? 0 : Math.min(5 - green, Math.round((removed / total) * 5));
  return (
    <span aria-hidden className="inline-flex gap-px">
      {Array.from({ length: 5 }, (_, index) => (
        <i key={index} className={`inline-block size-[7px] rounded-[1.5px] ${index < green ? "bg-success" : index < green + red ? "bg-destructive" : "bg-border"}`} />
      ))}
    </span>
  );
}

function FileRow({ file, threads }: { file: ChangedFile; threads: { open: number; all: number } }) {
  const look = CHANGE_LOOKS[file.change];
  const slash = file.path.lastIndexOf("/");
  return (
    <li data-file={file.path} className="grid grid-cols-[18px_minmax(0,1fr)_auto_auto] items-center gap-2.5 border-t border-border px-3 py-1.5 text-[12.5px] first:border-t-0">
      <span title={look.title} className={`inline-flex size-[18px] items-center justify-center rounded font-mono text-[10px] font-bold ${look.className}`}>{look.letter}</span>
      <span className="min-w-0 truncate font-mono text-xs" title={file.path}>
        {slash >= 0 && <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>}
        {file.path.slice(slash + 1)}
      </span>
      <span>{threads.open > 0 ? <Pill tone="warn" icon="MessageSquare">{threads.open} open</Pill> : threads.all > 0 ? <Pill icon="MessageSquare">{threads.all}</Pill> : null}</span>
      <span className="inline-flex items-center gap-2 whitespace-nowrap font-mono text-[11.5px]">
        {file.additions !== null && <span className="text-success">+{file.additions}</span>}
        {file.deletions !== null && <span className="text-destructive-text">−{file.deletions}</span>}
        <DiffBar file={file} />
      </span>
    </li>
  );
}

function Heading({ title, count, aside }: { title: string; count: number; aside?: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-[13.5px] font-semibold">{title}</h3>
      <Pill>{count.toLocaleString()}</Pill>
      <span className="flex-1" />
      {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
    </div>
  );
}

/** What changed, as a summary: the commits and each file's path and line counts. The diff itself stays on the server. */
export function ChangesPane({ pr, items, details }: { pr: PrView; items: readonly ConversationItem[] | undefined; details: PrDetails | null }) {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const config = useShuttleQuery("getConfig", {});
  const command = config.data?.config.servers.some((server) => server.id === pr.server && server.kind === "command") === true;
  const commits = details?.commits ?? null;
  const files = details?.files ?? null;
  const threadsOn = (path: string) => {
    const threads = new Map<string, boolean>();
    for (const item of items ?? []) if (item.kind === "thread" && item.path === path) threads.set(item.thread ?? item.id, item.resolved);
    return { open: [...threads.values()].filter((resolved) => !resolved).length, all: threads.size };
  };
  const open = (
    <button type="button" className={BUTTON} onClick={() => openExternal(navigate, diffUrl(pr))}>
      <Icon name="ExternalLink" className="size-3.5" aria-hidden />Open the full diff on {pr.serverName}
    </button>
  );
  if (items === undefined && details === null) return <div className="text-sm text-muted-foreground">Loading the changes…</div>;
  if (commits === null && files === null) {
    return (
      <div data-changes className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
        <span>
          {pr.additions !== null && pr.deletions !== null ? `+${pr.additions.toLocaleString()} −${pr.deletions.toLocaleString()}` : "Its changes"}
          {pr.files !== null && ` in ${plural(pr.files, "file")}`}. {pr.serverName} sent no list of the commits and files.
        </span>
        {command && (
          <span data-changes-setup className="text-xs">
            A command server lists them when its activity command answers <code className="rounded-sm bg-surface-recessed px-1 font-mono text-foreground">SHUTTLE_DETAIL=1</code> with commits and files.{" "}
            <UrlLink href={settingsHref(pluginId)} className="text-primary underline-offset-2 hover:underline">Settings › Servers</UrlLink>
          </span>
        )}
        {open}
      </div>
    );
  }
  return (
    <div data-changes>
      {commits !== null && (
        <section aria-label="Commits" className="mb-5">
          <Heading title="Commits" count={commits.total} aside={commits.total > commits.items.length ? `The last ${commits.items.length}, oldest first` : "Oldest first"} />
          <ul className="overflow-hidden rounded-lg border border-border bg-card">
            {commits.items.map((commit) => (
              <li key={commit.sha} data-commit={commit.sha} className="flex items-center gap-2.5 border-t border-border px-3 py-2 text-[13px] first:border-t-0">
                <Icon name="GitCommit" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={commit.message}>{commit.message || "(no message)"}</span>
                <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{commit.sha.slice(0, 7)}</span>
                {commit.author !== null && <span title={commit.author}><Avatar login={commit.author} size={18} /></span>}
                {commit.at !== null && <span className="w-8 shrink-0 text-right text-xs text-muted-foreground" title={new Date(commit.at).toLocaleString()}>{age(commit.at)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {files !== null && (
        <section aria-label="Files" className="mb-4">
          <Heading title="Files" count={files.total} aside={pr.additions !== null && pr.deletions !== null ? `+${pr.additions.toLocaleString()} −${pr.deletions.toLocaleString()}` : undefined} />
          <ul className="overflow-hidden rounded-lg border border-border bg-card">
            {files.items.map((file) => <FileRow key={file.path} file={file} threads={threadsOn(file.path)} />)}
          </ul>
          {files.total > files.items.length && (
            <div className="mt-2 text-xs text-muted-foreground">
              Showing the first {files.items.length} of {files.total.toLocaleString()} files. The rest are on {pr.serverName}.
            </div>
          )}
        </section>
      )}
      {open}
    </div>
  );
}
