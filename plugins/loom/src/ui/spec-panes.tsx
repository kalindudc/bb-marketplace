import { useState, type ReactNode } from "react";
import type { SpecVersionView } from "../contract";
import { isMultiRepo } from "../repos";
import type { Spec } from "../spec";
import { changedAt, dependencyChain, wavesOf } from "../spec-paths";
import { BUTTON, CHIP, HEADING, RepoChip, plural } from "./common";
import { Noteable } from "./spec-marks";

const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-xs [overflow-wrap:anywhere]">{children}</code>;
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** A path in one repo (null on a single-repo spec): tickets in different repos never share a file. */
const fileKey = (repo: string | null, glob: string) => JSON.stringify([repo, glob]);
/** Repos in the spec's order. */
const repoRank = (spec: Spec) => {
  const names = (spec.repo ?? []).map((repo) => repo.name);
  return (repo: string | null) => (repo === null ? 0 : names.indexOf(repo));
};

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
  /** The repo of its tickets; null on a single-repo spec. */
  repo: string | null;
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
  const tickets = new Map<string, { repo: string | null; glob: string; refs: Set<string> }>();
  const add = (repo: string | null, glob: string, refs: readonly string[]) => {
    const key = fileKey(repo, glob);
    const entry = tickets.get(key) ?? { repo, glob, refs: new Set<string>() };
    for (const ref of refs) entry.refs.add(ref);
    tickets.set(key, entry);
  };
  const listers = new Map<string, { repo: string | null; glob: string; refs: string[] }>();
  for (const ticket of spec.ticket) {
    const repo = ticket.repo ?? null;
    for (const glob of new Set(ticket.scope)) {
      const key = fileKey(repo, glob);
      listers.set(key, { repo, glob, refs: [...(listers.get(key)?.refs ?? []), ticket.ref] });
    }
  }
  for (const { repo, glob, refs } of listers.values()) if (refs.length > 1) add(repo, glob, refs);
  // scopeOverlaps pairs only tickets of the same repo.
  const repoOf = new Map(spec.ticket.map((ticket) => [ticket.ref, ticket.repo ?? null]));
  for (const overlap of view.overlaps) {
    const repo = repoOf.get(overlap.a)!;
    for (const glob of overlap.paths) add(repo, glob, [overlap.a, overlap.b, ...(listers.get(fileKey(repo, glob))?.refs ?? [])]);
  }
  const rankRepo = repoRank(spec);

  const scopeOf = new Map(spec.ticket.map((ticket) => [ticket.ref, ticket.scope]));
  const upstream = new Map(spec.ticket.map((ticket) => [ticket.ref, new Set(dependencyChain(spec.ticket, ticket.ref).up)]));
  const ordered = (a: string, b: string) => upstream.get(a)!.has(b) || upstream.get(b)!.has(a);
  return [...tickets.values()]
    .sort((a, b) => rankRepo(a.repo) - rankRepo(b.repo) || byCodePoint(a.glob, b.glob))
    .map(({ repo, glob, refs: set }) => {
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
      return { repo, glob, tickets: refs, paths: [...own, ...related], order, loose: loose.length > 0 };
    });
}

interface FileRow {
  glob: string;
  name: string;
  tickets: string[];
  paths: string[];
}

/** The files the tickets may change: first the paths tickets share, then every path by folder (by repo first on a multi-repo spec), then the paths no ticket may change. */
export function FilesPane({ view, highlighted, onPick, onClear }: { view: SpecVersionView; highlighted: string | null; onPick(ref: string): void; onClear(): void }) {
  const { spec } = view;
  const [sharedOnly, setSharedOnly] = useState(false);
  const waves = wavesOf(spec.ticket);
  const position = new Map(spec.ticket.map((ticket, index) => [ticket.ref, index]));
  const rank = (a: string, b: string) => waves[a]! - waves[b]! || position.get(a)! - position.get(b)!;
  const shared = sharedRows(view, rank);
  const sharedAt = new Map(shared.map((row) => [fileKey(row.repo, row.glob), row]));
  const multi = isMultiRepo(spec);
  const rankRepo = repoRank(spec);

  const files = new Map<string, { repo: string | null; glob: string; tickets: string[]; paths: string[] }>();
  spec.ticket.forEach((ticket) =>
    ticket.scope.forEach((glob, index) => {
      const repo = ticket.repo ?? null;
      const key = fileKey(repo, glob);
      const file = files.get(key) ?? { repo, glob, tickets: [], paths: [] };
      if (!file.tickets.includes(ticket.ref)) file.tickets.push(ticket.ref);
      file.paths.push(`ticket[${ticket.ref}].scope[${index}]`);
      files.set(key, file);
    }),
  );
  const groups = new Map<string | null, Map<string, FileRow[]>>();
  for (const file of [...files.values()].sort((a, b) => rankRepo(a.repo) - rankRepo(b.repo))) {
    if (sharedOnly && !sharedAt.has(fileKey(file.repo, file.glob))) continue;
    const { folder, name } = splitPath(file.glob);
    const folders = groups.get(file.repo) ?? new Map<string, FileRow[]>();
    folders.set(folder, [...(folders.get(folder) ?? []), { glob: file.glob, name, paths: file.paths, tickets: [...file.tickets].sort(rank) }]);
    groups.set(file.repo, folders);
  }
  const lit = (tickets: readonly string[]) => highlighted !== null && tickets.includes(highlighted);
  const chips = (tickets: readonly string[]) => (
    <span className="flex flex-wrap gap-1">
      {tickets.map((ref) => (
        <TicketChip key={ref} name={ref} on={ref === highlighted} onPick={onPick} />
      ))}
    </span>
  );

  const folderList = (repo: string | null, folders: Map<string, FileRow[]>) =>
    [...folders]
      .sort(([a], [b]) => byCodePoint(a, b))
      .map(([folder, rows]) => (
        <div key={folder} data-folder={folder} className="space-y-0.5">
          <h5 className="text-xs font-semibold">
            <span className={folder === "" ? "" : "font-mono [overflow-wrap:anywhere]"}>{folder === "" ? "Top level" : folder}</span> <span className="font-normal text-muted-foreground">· {rows.length}</span>
          </h5>
          <ul className="space-y-0.5 border-l border-border-seam pl-2">
            {rows
              .sort((a, b) => byCodePoint(a.name, b.name))
              .map((row) => {
                const share = sharedAt.get(fileKey(repo, row.glob));
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
      ));

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
                <li key={fileKey(row.repo, row.glob)} data-shared={row.glob} data-repo={row.repo ?? undefined} data-highlighted={lit(row.tickets) || undefined} className={`rounded-md ${lit(row.tickets) ? "bg-surface-selected" : ""}`}>
                  <Noteable paths={row.paths} label={`shared path ${row.glob}${row.repo === null ? "" : ` in ${row.repo}`}`}>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {row.repo !== null && <RepoChip name={row.repo} />}
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
        <h4 className={HEADING}>
          All files by {multi ? "repo and folder" : "folder"} · {plural(files.size, "path")}
        </h4>
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
        {groups.size === 0 && <p className="text-sm text-muted-foreground">No shared paths to show.</p>}
        {multi
          ? [...groups].map(([repo, folders]) => (
              <section key={repo} data-repo-files={repo} aria-label={`Files in ${repo}`} className="space-y-1.5 rounded-md border border-border-seam p-2">
                <h5 className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                  <RepoChip name={repo!} />
                  <span className="text-xs font-normal text-muted-foreground">{plural([...folders.values()].reduce((count, rows) => count + rows.length, 0), "path")}</span>
                </h5>
                {folderList(repo, folders)}
              </section>
            ))
          : groups.has(null) && folderList(null, groups.get(null)!)}
      </section>

      <section className="space-y-1">
        <Noteable paths={["scope.enforce"]} label="scope › enforce">
          <span className={HEADING}>Protected paths · enforce: {spec.scope.enforce}</span>
        </Noteable>
        {multi && <p className="pl-2 text-[11px] text-muted-foreground">These apply in every repo; a repo's own protected paths are under Project & limits.</p>}
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
