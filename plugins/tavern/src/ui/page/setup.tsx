import { experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useId, useState, type ReactNode } from "react";
import { isGuardrailSetting } from "../../shared/settings";
import { forgeProfileSchema, placementRuleSchema, type ForgeProfile, type PlacementRule } from "../../shared/placement-settings";
import { setupContract, setupPrompt, type SetupLine, type SetupProposal } from "../../shared/setup";
import { FoldSummary } from "../kit";
import { Ago, ReadState } from "./common";
import { PageGlyph } from "./glyphs";
import { settingLabel } from "./settings-label";
import "./setup.css";

const sectionNames: Record<string, string> = { tavern: "Tavern", away: "Closing time", attention: "Your attention", keepers: "Keepers and decisions",
  classes: "Classes and models", scopes: "Scopes", machines: "Where work runs", journal: "Journal", data: "Data and backups",
  tuning: "Tuning", knobs: "Tavern knobs", pinned: "Pinned knobs", tuned: "Saved tuning" };
const statuses = { pass: { mark: "✓", label: "Passed" }, fail: { mark: "!", label: "Needs a fix" }, unchecked: { mark: "–", label: "Not checked yet" } };
const statusText = { stale: "Settings changed. Ask the agent for a fresh proposal.", applied: "Applied. See Settings history for the receipt.", dismissed: "Dismissed." };
const matchLabels: Record<keyof PlacementRule["match"], string> = { projectIds: "Projects", repoRemotes: "Repository remotes", keeperPathGlobs: "Keeper checkout paths", keeperEnvironmentProviders: "Keeper environment providers", classes: "Classes", questIds: "Quests" };
const consentLabels = { guardInstall: "Lets Tavern install its guard on the target machine", remoteDetectionOnly: "Lets remote scopes detect violations without blocking them", linuxUncontainedChecks: "Lets members run Linux checks outside containment" } satisfies Record<keyof PlacementRule["consent"], string>;
const scriptLabels = { open: "Open script", state: "State script", close: "Close script" };
const changeLabel = (key: string) => key === "machines.rules" ? "Machine rules" : key === "machines.forges" ? "Forge profiles" : settingLabel(key);
const date = (at: number) => <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>;
const proposer = (p: SetupProposal) => p.threadId ? `@${p.threadId}` : "Terminal";
const count = (p: SetupProposal) => `${p.changes.length} ${p.changes.length === 1 ? "change" : "changes"}`;
const failures = (p: SetupProposal) => p.preflight.filter(line => line.status === "fail").length;
const failedText = (n: number) => n === 0 ? "No failed checks" : `${n} failed ${n === 1 ? "check" : "checks"}`;
const valueText = (key: string, value: SetupProposal["changes"][number]["to"], after = false) => value === null
  ? after && key.endsWith(".reasoning") ? "Provider default" : "Not set"
  : typeof value === "string" ? value : JSON.stringify(value);

function RuleDetails({ rule }: { rule: PlacementRule }) {
  const target = rule.target;
  const machine = target.kind === "provider" ? target.machine : null;
  const where = !machine ? "Keep the current hire placement" : machine.type === "new" ? `New machine through ${machine.machineProviderId}`
    : machine.type === "existing" ? `Existing host ${machine.hostId}` : machine.type === "keeper" ? "Keeper’s machine" : "Machine with the project checkout";
  const matches = Object.entries(rule.match) as [keyof PlacementRule["match"], string[]][];
  const pr = rule.pullRequests;
  return <dl className="tsu-facts">
    <div><dt>Matches</dt><dd>{matches.length ? <ul>{matches.map(([key, values]) => <li key={key}>{matchLabels[key]}: {values.join(", ")}</li>)}</ul> : "All work"}</dd></div>
    <div><dt>Where work runs</dt><dd>{where}{target.kind === "provider" && <> using {target.environmentProviderId}</>}</dd></div>
    <div><dt>Workspace</dt><dd>{target.kind === "current" ? "Unchanged" : target.workspace === "dedicated-machine" ? "Dedicated machine" : "Linked worktree"}</dd></div>
    <div><dt>Class models</dt><dd>{Object.keys(rule.classModels ?? {}).length ? <ul>{Object.entries(rule.classModels ?? {}).map(([id, model]) =>
      <li key={id}>{id}: {model.model}{model.provider && ` through ${model.provider}`}{model.reasoning && `, ${model.reasoning} reasoning`}</li>)}</ul> : "Use the class defaults"}</dd></div>
    <div><dt>Pull requests</dt><dd>{pr?.at === "home" ? `Open from home using ${pr.profile}` : "Open from the member’s machine"}</dd></div>
    <div><dt>Consent</dt><dd><ul>{Object.entries(consentLabels).map(([id, label]) => <li key={id}><span>{label}</span>: <strong>{rule.consent[id as keyof typeof consentLabels] ? "Yes" : "No"}</strong></li>)}</ul></dd></div>
  </dl>;
}
function ForgeDetails({ profile }: { profile: ForgeProfile }) {
  if (profile.kind === "github") return <p>Uses the gh CLI on this machine</p>;
  return <dl className="tsu-facts">{(Object.keys(scriptLabels) as (keyof typeof scriptLabels)[]).map(field => profile[field] === undefined ? null :
    <div key={field}><dt>{scriptLabels[field]}</dt><dd><code>{profile[field]}</code></dd></div>)}</dl>;
}
function PlacementDiff({ change }: { change: SetupProposal["changes"][number] }) {
  const schema = change.key === "machines.rules" ? placementRuleSchema : forgeProfileSchema;
  const entries = (value: typeof change.to) => (Array.isArray(value) ? value : []).flatMap(item => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  const before = entries(change.from), after = entries(change.to);
  type Entry = typeof before[number];
  const render = (entry: Entry) => "label" in entry ? <RuleDetails rule={entry} /> : <ForgeDetails profile={entry} />;
  const name = (entry: Entry) => "label" in entry ? entry.label : entry.name;
  const byId = (items: Entry[]) => new Map(items.map((item, index) => [item.id, { item, index }]));
  const old = byId(before), next = byId(after);
  const rows = [...new Set([...next.keys(), ...old.keys()])].flatMap(id => {
    const previous = old.get(id), proposed = next.get(id), item = proposed?.item ?? previous!.item;
    const reordered = previous && proposed && previous.index !== proposed.index && "label" in item;
    if (previous && proposed && !reordered && JSON.stringify(previous.item) === JSON.stringify(proposed.item)) return [];
    return [{ id, item, previous, proposed, reordered, kind: !previous ? "Added" : !proposed ? "Removed" : "Changed" }];
  });
  return <>
    <ul className="tsu-placement">{rows.map(({ id, item, previous, proposed, reordered, kind }) => <li key={id}>
      <header><span className="tsu-tag">{kind}</span> <strong>{name(item)}</strong> <code>{id}</code>{!item.enabled && " (off)"}</header>
      {reordered && <p>Rule order: {previous!.index + 1} to {proposed!.index + 1}</p>}
      {render(item)}
      {kind === "Changed" && <details><FoldSummary>Before this change</FoldSummary>{render(previous!.item)}</details>}
    </li>)}</ul>
    <details className="tsu-json"><FoldSummary>Show as settings JSON</FoldSummary><code>{JSON.stringify({ before: change.from, proposed: change.to }, null, 2)}</code></details>
  </>;
}
function checkLabel(line: SetupLine, changes: SetupProposal["changes"]) {
  const match = /^machines\.(forges|rules)\.(\d+)(?:\.(.*))?$/.exec(line.key);
  if (!match) return line.key.startsWith("classes.") ? settingLabel(line.key) : "Setup check";
  const [, group, index, field] = match;
  const value = changes.find(change => change.key === `machines.${group}`)?.to;
  const item = Array.isArray(value) ? value[Number(index)] : undefined;
  const name = item && typeof item === "object" && !Array.isArray(item) ? item.name ?? item.label : undefined;
  const detail = field?.startsWith("classModels.") ? `${field.split(".").at(-1)} model`
    : field === "target" ? "placement provider" : field && scriptLabels[field as keyof typeof scriptLabels]?.toLowerCase();
  return [typeof name === "string" ? name : `${group === "rules" ? "Rule" : "Profile"} ${Number(index) + 1}`, detail].filter(Boolean).join(", ");
}
function Checks({ lines, changes }: { lines: SetupLine[]; changes: SetupProposal["changes"] }) {
  if (!lines.length) return null;
  return <ul className="tsu-checks" aria-label="Preflight">{lines.map((line, index) => <li key={index} data-status={line.status}>
    <span className="tsu-mark" aria-hidden="true">{statuses[line.status].mark}</span>
    <div><strong>{statuses[line.status].label}</strong> <span>{checkLabel(line, changes)}</span><p>{line.message}</p><code className="tsu-key">{line.key}</code></div>
  </li>)}</ul>;
}
function ProposalBy({ data }: { data: SetupProposal }) {
  const nav = useBbNavigate();
  return <div className="tsu-by"><span>Proposed by</span> {data.threadId
    ? <button type="button" className="tsu-thread lnk-btn" onClick={() => nav.toThread(data.threadId!)}>{proposer(data)}</button>
    : <span>{proposer(data)}</span>}{data.classId && <span>· {data.classId}</span>}{data.proposedAt !== null && <span>· {date(data.proposedAt)}</span>}</div>;
}
function SetupCard({ proposal, refresh }: { proposal: SetupProposal; refresh: () => void }) {
  const apply = experimental_useRpcMutation({ contract: setupContract, method: "setupApply" });
  const dismiss = experimental_useRpcMutation({ contract: setupContract, method: "setupDismiss" });
  const [result, setResult] = useState<SetupProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId(), data = result?.state !== "pending" && result ? result : proposal.state === "pending" ? result ?? proposal : proposal;
  const groups = new Map<string, SetupProposal["changes"]>();
  const sorted = [...data.changes].sort((a, b) => Number(isGuardrailSetting(b.key)) - Number(isGuardrailSetting(a.key)));
  for (const change of sorted) {
    const group = `${isGuardrailSetting(change.key) ? "guardrail" : "standard"}.${change.key.split(".")[0]}`;
    const rows = groups.get(group);
    if (rows) rows.push(change); else groups.set(group, [change]);
  }
  const attached = new Map<string | undefined, SetupLine[]>();
  for (const line of data.preflight) {
    const key = sorted.find(change => line.key === change.key || line.key.startsWith(change.key + "."))?.key
      ?? (line.key.startsWith("classes.") ? sorted.find(change => change.key.startsWith(line.key.split(".").slice(0, 2).join(".") + "."))?.key : undefined);
    const rows = attached.get(key);
    if (rows) rows.push(line); else attached.set(key, [line]);
  }
  const failed = failures(data), busy = apply.isPending || dismiss.isPending;
  const act = async (mutation: typeof apply | typeof dismiss) => {
    setError(null);
    try { setResult(await mutation.mutate({ id: data.id })); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  return <article className="tavern tsu-card" aria-labelledby={id}>
    <header className="tsu-head"><PageGlyph name="rule" /><div><h3 id={id}>Tavern setup proposal</h3><p>{count(data)} · {failedText(failed)}</p><ProposalBy data={data} /></div></header>
    <div className="tsu-body">
      {data.state !== "pending" && <div className="tsu-status" role="status"><p>{statusText[data.state]}</p>
        {data.conflicts.length > 0 && <ul>{data.conflicts.map(({ key, at }) => <li key={key}>{changeLabel(key)} ({key}) changed{at !== null && <> on {date(at)}</>}.</li>)}</ul>}</div>}
      <Checks lines={attached.get(undefined) ?? []} changes={data.changes} />
      {Array.from(groups, ([group, changes]) => <section className="tsu-group" key={group}><h4>{sectionNames[group.split(".")[1]!] ?? group}</h4>
        <ul>{changes.map(change => <li key={change.key} className="tsu-change">
          <div className="tsu-line-head"><strong>{changeLabel(change.key)}</strong>{isGuardrailSetting(change.key) && <span className="tsu-tag tsu-guardrail">Guardrail</span>} <code className="tsu-key">{change.key}</code></div>
          <p><strong>Agent's reason:</strong> <span>{change.reason}</span></p>
          <Checks lines={attached.get(change.key) ?? []} changes={data.changes} />
          {change.key === "machines.rules" || change.key === "machines.forges" ? <PlacementDiff change={change} /> :
            <dl className="tsu-diff"><div><dt>Before</dt><dd><code>{valueText(change.key, change.from)}</code></dd></div>
              <div><dt>Proposed</dt><dd><code>{valueText(change.key, change.to, true)}</code></dd></div></dl>}
        </li>)}</ul></section>)}
      {(data.state === "pending" || data.state === "stale") && <footer className="tsu-foot">
        {data.state === "pending" && <p id={id + "-why"}>{failed ? "Ask the agent to fix the failed checks before applying." : data.forgeProbe ? "Apply runs the forge help checks, then saves all changes together." : "Apply saves these changes together and leaves other settings alone."}</p>}
        <div className="tsu-actions">
          {data.state === "pending" && <button className="btn pri" type="button" aria-describedby={id + "-why"} disabled={failed > 0 || busy} onClick={() => void act(apply)}>{apply.isPending ? "Checking…" : "Apply"}</button>}
          <button className="btn" type="button" disabled={busy} onClick={() => void act(dismiss)}>Dismiss</button>
        </div>
      </footer>}
      {error && <p className="tsu-error" role="alert">{error}</p>}
    </div>
  </article>;
}

export function SetupDirective({ attributes }: PluginMessageDirectiveProps) {
  const id = attributes.id ?? "";
  const valid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
  const query = experimental_useRpcQuery({ contract: setupContract, method: "setupProposal", input: { id }, enabled: valid });
  if (query.error) return <ReadState error={query.error} retry={query.refetch} />;
  if (!valid || query.data === null) return <p>Tavern could not find this setup proposal.</p>;
  return query.data ? <SetupCard key={id} proposal={query.data} refresh={() => void query.refetch()} /> : <p>Reading Tavern setup proposal…</p>;
}

export function SetupSettings() {
  const pending = experimental_useRpcQuery({ contract: setupContract, method: "setupPending", input: null });
  const projects = experimental_useRpcQuery({ contract: setupContract, method: "setupProjects", input: null });
  const navigate = useBbNavigate();
  const [projectId, setProjectId] = useState("");
  const [request, setRequest] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const id = useId(), ready = !!request.trim() && !!projects.data?.some(project => project.id === projectId);
  const list: ReactNode = pending.error ? <ReadState error={pending.error} retry={pending.refetch} /> : pending.data?.length ? pending.data.map(item => {
    const open = expanded === item.id;
    return <div className="tsu-entry" key={item.id}>
      <button className="tsu-expand" type="button" aria-label={`Review proposal from ${proposer(item)}: ${count(item)}, ${failedText(failures(item))}`} aria-expanded={open}
        aria-controls={open ? item.id : undefined} onClick={() => setExpanded(open ? null : item.id)}>
        <strong>{proposer(item)}{item.classId && ` · ${item.classId}`}</strong><span>{count(item)} · {failedText(failures(item))}{item.state === "stale" && " · Stale"}
          {item.proposedAt !== null && <> · <Ago at={item.proposedAt} /></>}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && <div id={item.id}><SetupCard proposal={item} refresh={() => void pending.refetch()} /></div>}
    </div>;
  }) : <p>{pending.data ? "No proposals to review." : "Reading setup proposals…"}</p>;
  return <section className="tavern tv-page tsu-settings">
    <form className="tsu-form" data-settings-row="" onSubmit={event => {
      event.preventDefault();
      if (ready) navigate.toCompose({ projectId, initialPrompt: setupPrompt(request), focusPrompt: true });
    }}>
      <label htmlFor={id + "-project"} data-settings-copy>Project</label>
      <select className="tv-select" id={id + "-project"} value={projectId} onChange={event => setProjectId(event.target.value)}>
        <option value="">{projects.data ? "Choose a project" : "Reading projects…"}</option>
        {projects.data?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <label htmlFor={id + "-request"} data-settings-copy>What should Tavern be set up for?</label>
      <textarea className="tv-text" id={id + "-request"} rows={2} maxLength={8000} value={request} onChange={event => setRequest(event.target.value)}
        placeholder="Open draft pull requests with my scripts in ~/bin; run checks on a separate machine." />
      <p id={id + "-form-help"} data-settings-copy>{ready ? "Review the request in the composer before sending it." : "Choose a project and describe what you want the agent to set up."}</p>
      <button className="btn pri" type="submit" aria-describedby={id + "-form-help"} disabled={!ready} data-settings-copy>Set up with an agent</button>
    </form>
    {projects.error && <ReadState error={projects.error} retry={projects.refetch} />}
    <div className="tsu-list"><h3>Open setup proposals</h3>{list}</div>
  </section>;
}
