import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Config, ServerConfig } from "../../config";
import type { ServerStatus, TestResult } from "../../contract";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, CARD, ErrorNote, FIELD, Pill, ServerBadge, Toggle } from "../common";
import { OPERATIONS, OPERATION_LABELS } from "../constants";
import { messageOf, useShuttleMutation, useShuttleQuery } from "../data";
import { ago } from "../format";
import { useConfig } from "./use-config";

type Operation = (typeof OPERATIONS)[number];

interface ServerDraft {
  /** The saved server's id, or null for a new one. */
  original: string | null;
  kind: ServerConfig["kind"];
  id: string;
  name: string;
  hostname: string;
  pattern: string;
  link: string;
  sep: "#" | "!";
  commands: Record<Operation, string>;
  read: string;
  workspaceKind: "git" | "provider" | "command";
  provider: string;
  /** The provider's inputs as JSON text, checked on save. */
  inputs: string;
  workspaceCommand: string;
}

type WorkspaceDraft = Pick<ServerDraft, "workspaceKind" | "provider" | "inputs" | "workspaceCommand">;

function workspaceDraftOf(workspace: ServerConfig["workspace"]): WorkspaceDraft {
  if (workspace?.kind === "provider") return { workspaceKind: "provider", provider: workspace.provider, inputs: JSON.stringify(workspace.inputs, null, 2), workspaceCommand: "" };
  if (workspace?.kind === "command") return { workspaceKind: "command", provider: "", inputs: "{}", workspaceCommand: workspace.command };
  return { workspaceKind: "git", provider: "", inputs: "{}", workspaceCommand: "" };
}

/** The workspace the draft describes, or the reason it cannot be saved. */
export function workspaceOf(draft: WorkspaceDraft): { workspace: ServerConfig["workspace"] } | { problem: string } {
  if (draft.workspaceKind === "git") return { workspace: undefined };
  if (draft.workspaceKind === "command") {
    const command = draft.workspaceCommand.trim();
    return command ? { workspace: { kind: "command", command } } : { problem: "Enter the command that prints the checkout's path." };
  }
  const provider = draft.provider.trim();
  if (!provider) return { problem: "Enter the environment provider's id, such as world-tree." };
  let inputs: unknown;
  try {
    inputs = JSON.parse(draft.inputs.trim() || "{}");
  } catch (error) {
    return { problem: `The inputs are not JSON: ${(error as Error).message}` };
  }
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) return { problem: "The inputs must be a JSON object." };
  return { workspace: { kind: "provider", provider, inputs: inputs as Record<string, unknown> } };
}

const emptyCommands = (): Record<Operation, string> => Object.fromEntries(OPERATIONS.map((op) => [op, ""])) as Record<Operation, string>;

function draftOf(server: ServerConfig | null): ServerDraft {
  if (server === null) return { original: null, kind: "command", id: "", name: "", hostname: "", pattern: "", link: "", sep: "#", commands: emptyCommands(), read: "", ...workspaceDraftOf(undefined) };
  return {
    original: server.id,
    kind: server.kind,
    id: server.id,
    name: server.name,
    hostname: server.hostname ?? "",
    pattern: server.pattern ?? "",
    link: server.link ?? "",
    sep: server.sep,
    commands: { ...emptyCommands(), ...server.commands },
    read: server.read ?? "",
    ...workspaceDraftOf(server.workspace),
  };
}

function serverOf(draft: ServerDraft, saved: ServerConfig | null): ServerConfig {
  const optional = (value: string) => (value.trim() === "" ? undefined : value.trim());
  const commands: ServerConfig["commands"] = {};
  for (const op of OPERATIONS) {
    const command = optional(draft.commands[op]);
    if (command !== undefined) commands[op] = command;
  }
  const hostname = draft.kind === "github" ? optional(draft.hostname) : undefined;
  const pattern = optional(draft.pattern);
  const link = optional(draft.link);
  const read = optional(draft.read);
  const workspace = workspaceOf(draft);
  // RPC input is strict JSON: an unset field is left out rather than undefined.
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    kind: draft.kind,
    enabled: saved?.enabled ?? true,
    ...(hostname === undefined ? {} : { hostname }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(link === undefined ? {} : { link }),
    sep: draft.sep,
    ...(read === undefined ? {} : { read }),
    ...("workspace" in workspace && workspace.workspace !== undefined ? { workspace: workspace.workspace } : {}),
    commands,
  };
}

/** What a link pattern lacks, before the server is asked. */
function patternProblem(pattern: string): string | null {
  if (pattern.trim() === "") return null;
  try {
    new RegExp(pattern, "u");
  } catch (error) {
    return `not a valid regular expression: ${(error as Error).message}`;
  }
  if (!pattern.includes("(?<repo>") || !pattern.includes("(?<number>")) return "needs (?<repo>…) and (?<number>…) groups";
  return null;
}

function TestResults({ results }: { results: readonly TestResult[] }) {
  return (
    <ul aria-label="Test results" className="mt-2 flex flex-col gap-1 rounded-md border border-border bg-background p-2">
      {results.map((result) => (
        <li key={result.operation} data-test-result={result.operation} className="flex items-start gap-2 text-xs">
          <Icon name={result.ok ? "Check" : "X"} className={`mt-0.5 size-3.5 shrink-0 ${result.ok ? "text-success" : "text-destructive"}`} aria-hidden />
          <span className="w-32 shrink-0 font-mono">{result.operation}</span>
          <span className={`min-w-0 flex-1 break-words ${result.ok ? "text-muted-foreground" : "text-destructive"}`}>{result.detail}</span>
          <span className="shrink-0 text-muted-foreground">{result.ms} ms</span>
        </li>
      ))}
      {results.length === 0 && <li className="text-xs text-muted-foreground">The server ran no commands.</li>}
    </ul>
  );
}

function StatusPill({ status }: { status: ServerStatus | null }) {
  if (status === null || status.ok === null) return <Pill>Not synced yet</Pill>;
  if (status.ok) return <Pill tone="ok" icon="Check">{status.login ? `Signed in as ${status.login}` : "Synced"}</Pill>;
  return <Pill tone="bad" icon="AlertTriangle" title={status.error ?? undefined}>{status.error ?? "The last sync failed"}</Pill>;
}

function ServerCard({ server, status, busy, onEnable, onEdit, onDelete }: {
  server: ServerConfig;
  status: ServerStatus | null;
  busy: boolean;
  onEnable(on: boolean): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const testServer = useShuttleMutation("testServer");
  const testing = testServer.isPending;
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const supported = (op: Operation) => (status !== null ? status.operations.includes(op) : server.kind === "github" || server.commands[op] !== undefined);
  const test = async () => {
    const out = await testServer.run({ id: server.id });
    if (out !== null) setResults(out.results);
  };
  return (
    <li data-server={server.id} className={`${CARD} p-3`}>
      <div className="flex flex-wrap items-center gap-2.5">
        <ServerBadge name={server.name} large />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{server.name} <span className="font-mono text-xs font-normal text-muted-foreground">{server.id}</span></div>
          <div className="text-xs text-muted-foreground">
            {server.kind === "github" ? `Built-in GitHub adapter (gh)${server.hostname ? ` on ${server.hostname}` : ""}` : "Command adapter"}
          </div>
        </div>
        <StatusPill status={status} />
        {status?.durationMs != null && status.ok && <span className="text-xs text-muted-foreground">{(status.durationMs / 1000).toFixed(1)}s per sync</span>}
        {status !== null && status.ok === false && status.lastOkAt !== null && <span className="text-xs text-muted-foreground">last good sync {ago(status.lastOkAt)}</span>}
        <button type="button" className={BUTTON} disabled={testing} onClick={() => void test()}>{testing ? "Testing…" : "Test"}</button>
        <Toggle on={server.enabled} label={`Enable ${server.name}`} disabled={busy} onChange={onEnable} />
        <button type="button" aria-label={`Edit ${server.name}`} className={BUTTON_GHOST} onClick={onEdit}>Edit</button>
        {confirming ? (
          <>
            <button type="button" className={`${BUTTON} text-destructive`} disabled={busy} onClick={() => { setConfirming(false); onDelete(); }}>Click again to delete</button>
            <button type="button" className={BUTTON_GHOST} onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" aria-label={`Delete ${server.name}`} className={BUTTON_GHOST} disabled={busy} onClick={() => setConfirming(true)}>
            <Icon name="Trash2" className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1">
        {OPERATIONS.map((op) => (
          <span key={op} title={OPERATION_LABELS[op]}><Pill tone={supported(op) ? "ok" : "neutral"} icon={supported(op) ? "Check" : undefined}>{op}</Pill></span>
        ))}
      </div>
      {results !== null && <TestResults results={results} />}
    </li>
  );
}

function ServerForm({ initial, saved, existingIds, saving, onSave, onCancel }: {
  initial: ServerDraft;
  saved: ServerConfig | null;
  existingIds: readonly string[];
  saving: boolean;
  onSave(server: ServerConfig): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [results, setResults] = useState<TestResult[] | null>(null);
  const testServer = useShuttleMutation("testServer");
  const testing = testServer.isPending;
  const set = <K extends keyof ServerDraft>(key: K, value: ServerDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const problem = draft.kind === "command" ? patternProblem(draft.pattern) : null;
  const duplicate = draft.original === null && existingIds.includes(draft.id.trim());
  const workspaceResult = workspaceOf(draft);
  const workspaceProblem = "problem" in workspaceResult ? workspaceResult.problem : null;
  const test = async () => {
    const out = await testServer.run({ server: serverOf(draft, saved) });
    if (out !== null) setResults(out.results);
  };
  const row = "grid grid-cols-1 items-center gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3";
  const label = "text-xs text-muted-foreground";
  return (
    <div data-server-form className={`${CARD} border-primary p-3`}>
      <div className="mb-3 flex items-center gap-2">
        <b className="flex-1 text-sm">{draft.original === null ? "Add a server" : `Edit ${initial.name}`}</b>
        <button type="button" aria-label="Close the server form" className={BUTTON_GHOST} onClick={onCancel}><Icon name="X" className="size-3.5" aria-hidden /></button>
      </div>
      <div className="flex flex-col gap-2.5 text-sm">
        <label className={row}><span className={label}>Name</span><input aria-label="Server name" className={FIELD} placeholder="GitLab (self-hosted)" value={draft.name} onChange={(event) => set("name", event.target.value)} /></label>
        <label className={row}>
          <span className={label}>Id</span>
          <span>
            <input aria-label="Server id" className={`${FIELD} w-full font-mono`} placeholder="gitlab-acme" value={draft.id} disabled={draft.original !== null} onChange={(event) => set("id", event.target.value)} />
            <span className="mt-1 block text-xs text-muted-foreground">
              {duplicate ? <span className="text-destructive">A server already has this id.</span> : "The first part of every PR key from this server, as in gitlab-acme:group/project!77. Lowercase letters, digits and dashes."}
            </span>
          </span>
        </label>
        {draft.kind === "github" ? (
          <label className={row}><span className={label}>Hostname</span><input aria-label="Hostname" className={`${FIELD} font-mono`} placeholder="github.com (leave empty), or your GitHub Enterprise host" value={draft.hostname} onChange={(event) => set("hostname", event.target.value)} /></label>
        ) : (
          <>
            <label className={row}>
              <span className={label}>Link pattern</span>
              <span>
                <input aria-label="Link pattern" className={`${FIELD} w-full font-mono`} placeholder="^https://git\.acme\.dev/(?<repo>.+?)/-/merge_requests/(?<number>\d+)" value={draft.pattern} onChange={(event) => set("pattern", event.target.value)} />
                <span className={`mt-1 block text-xs ${problem ? "text-destructive" : "text-muted-foreground"}`}>{problem ?? "A regular expression for this server's PR links, with (?<repo>…) and (?<number>…) groups."}</span>
              </span>
            </label>
            <label className={row}><span className={label}>Link template</span><input aria-label="Link template" className={`${FIELD} font-mono`} placeholder="https://git.acme.dev/{repo}/-/merge_requests/{number}" value={draft.link} onChange={(event) => set("link", event.target.value)} /></label>
            <label className={row}>
              <span className={label}>Number sign</span>
              <select aria-label="Number sign" className={FIELD} value={draft.sep} onChange={(event) => set("sep", event.target.value as "#" | "!")}>
                <option value="#"># (as in owner/repo#77)</option>
                <option value="!">! (as in group/project!77)</option>
              </select>
            </label>
            <table className="w-full border-collapse text-xs">
              <tbody>
                {OPERATIONS.map((op) => (
                  <tr key={op} className="border-t border-border">
                    <td className="w-40 py-1.5 pr-2 align-middle">
                      <div className="font-mono">{op}</div>
                      <div className="text-[11px] text-muted-foreground">{OPERATION_LABELS[op]}</div>
                    </td>
                    <td className="py-1.5">
                      <input aria-label={`${op} command`} className={`${FIELD} w-full font-mono text-xs`} value={draft.commands[op]}
                        placeholder={op === "view" ? "Required" : "Leave empty to skip this list"}
                        onChange={(event) => set("commands", { ...draft.commands, [op]: event.target.value })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">
              Commands run with <span className="font-mono">/bin/sh</span> and get <span className="font-mono">SHUTTLE_REPO</span>, <span className="font-mono">SHUTTLE_NUMBER</span>, <span className="font-mono">SHUTTLE_STATE</span> and <span className="font-mono">SHUTTLE_TEAM</span>. Each prints JSON.
            </p>
          </>
        )}
        <label className={row}>
          <span className={label}>Read command</span>
          <span>
            <input aria-label="Read command" className={`${FIELD} w-full font-mono`} placeholder={draft.kind === "github" ? "gh pr view {number} -R {repo} --comments (the default)" : "dt pr view {number} -R {repo} --comments"}
              value={draft.read} onChange={(event) => set("read", event.target.value)} />
            <span className="mt-1 block text-xs text-muted-foreground">How a review agent reads a PR with its conversation; {"{repo}"}, {"{number}"} and {"{url}"} are filled in, shell-quoted.</span>
          </span>
        </label>
        <label className={row}>
          <span className={label}>Review workspace</span>
          <select aria-label="Review workspace" className={FIELD} value={draft.workspaceKind} onChange={(event) => set("workspaceKind", event.target.value as ServerDraft["workspaceKind"])}>
            <option value="git">bb's git worktree</option>
            <option value="provider">A bb environment provider, such as World tree</option>
            <option value="command">A command that prints a checkout's path</option>
          </select>
        </label>
        {draft.workspaceKind === "provider" && (
          <>
            <label className={row}><span className={label}>Provider</span><input aria-label="Environment provider" className={`${FIELD} font-mono`} placeholder="world-tree" value={draft.provider} onChange={(event) => set("provider", event.target.value)} /></label>
            <label className={row}>
              <span className={label}>Inputs (JSON)</span>
              <textarea aria-label="Provider inputs" rows={3} className={`${FIELD} w-full font-mono text-xs`} placeholder='{ "tree": "shuttle-{number}" }' value={draft.inputs} onChange={(event) => set("inputs", event.target.value)} />
            </label>
          </>
        )}
        {draft.workspaceKind === "command" && (
          <label className={row}>
            <span className={label}>Command</span>
            <input aria-label="Workspace command" className={`${FIELD} w-full font-mono text-xs`} placeholder="cd ~/world && dev tree add shuttle-{number} >&2 && echo ~/world/trees/shuttle-{number}/src"
              value={draft.workspaceCommand} onChange={(event) => set("workspaceCommand", event.target.value)} />
          </label>
        )}
        <p className={`text-xs ${workspaceProblem ? "text-destructive" : "text-muted-foreground"}`}>
          {workspaceProblem ?? "Used when a review preset asks for its own checkout. Inputs and the command may use {number}, {repo}, {repo_name}, {head_ref}, {base}, {head}, {server} and {slug}; the command prints the checkout's absolute path on its last line."}
        </p>
      </div>
      {results !== null && <TestResults results={results} />}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button type="button" className={BUTTON} disabled={testing} onClick={() => void test()}>{testing ? "Testing…" : "Test commands"}</button>
        <button type="button" className={BUTTON_PRIMARY} disabled={saving || duplicate || workspaceProblem !== null} onClick={() => onSave(serverOf(draft, saved))}>Save server</button>
      </div>
    </div>
  );
}

/** Where Shuttle finds pull requests: each server's status, its operations, a test run, and a form for command servers. */
export function ServersSection() {
  const { config, loadError, saving, saveError, save } = useConfig();
  const overview = useShuttleQuery("overview", {});
  const [editing, setEditing] = useState<ServerDraft | null>(null);
  if (config === null) return loadError !== null ? <ErrorNote>Could not load Shuttle's settings: {loadError}</ErrorNote> : <div className="text-sm text-muted-foreground">Loading…</div>;

  const statusOf = (id: string) => overview.data?.servers.find((server) => server.id === id) ?? null;
  const replace = (servers: ServerConfig[], done: string) => save({ ...config, servers } satisfies Config, done);
  const saveServer = async (server: ServerConfig, original: string | null) => {
    const servers = original === null ? [...config.servers, server] : config.servers.map((item) => (item.id === original ? server : item));
    if (await replace(servers, `Saved ${server.name}`)) setEditing(null);
  };
  const editingSaved = editing?.original != null ? config.servers.find((server) => server.id === editing.original) ?? null : null;
  return (
    <div data-section="servers" className="flex flex-col gap-3">
      {saveError !== null && <ErrorNote>{saveError}</ErrorNote>}
      {overview.error !== null && <ErrorNote>Could not load the servers' status: {messageOf(overview.error)}</ErrorNote>}
      <ul className="flex flex-col gap-2.5">
        {config.servers.map((server) => (
          <ServerCard key={server.id} server={server} status={statusOf(server.id)} busy={saving}
            onEnable={(on) => void replace(config.servers.map((item) => (item.id === server.id ? { ...item, enabled: on } : item)), `${on ? "Enabled" : "Disabled"} ${server.name}`)}
            onEdit={() => setEditing(draftOf(server))}
            onDelete={() => void replace(config.servers.filter((item) => item.id !== server.id), `Deleted ${server.name}`)} />
        ))}
      </ul>
      {config.servers.length === 0 && <p className="text-sm text-muted-foreground">No server yet: Shuttle lists nothing until you add one.</p>}
      {editing !== null ? (
        <ServerForm key={editing.original ?? "new"} initial={editing} saved={editingSaved} existingIds={config.servers.map((server) => server.id)} saving={saving}
          onSave={(server) => void saveServer(server, editing.original)} onCancel={() => setEditing(null)} />
      ) : (
        <div>
          <button type="button" className={BUTTON} onClick={() => setEditing(draftOf(null))}>
            <Icon name="Plus" className="size-3.5" aria-hidden />
            Add a server
          </button>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">What each command prints</summary>
        <div className="mt-2 space-y-2 text-xs text-muted-foreground">
          <p>The same shapes for every server; the built-in GitHub adapter follows them too.</p>
          <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-[11.5px] leading-relaxed text-foreground">{COMMAND_SHAPES}</pre>
        </div>
      </details>
    </div>
  );
}

const COMMAND_SHAPES = `// whoami: one object
{"login": "kalindudc"}

// authored, review_requested, team_requested, mentioned: a JSON array; view: one of these objects
[{"repo": "shop/world", "number": 2269437, "title": "…", "author": "sam.lee",
  "state": "open", "draft": false, "head": "9f3c2a1", "updated_at": "2026-10-23T14:58:00Z",
  "checks": "passed", "review": "required", "teams": ["@shop/edge-routing"]}]

// activity: one object; each item id stays the same until the item changes
{"head": "a41f7c3", "items": [{"id": "r7", "kind": "review", "author": "ana.k", "bot": false,
  "state": "changes_requested", "body": "…", "path": null, "line": null, "url": "…"}]}`;
