import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { memoryConfigInput, memoryContract, type MemoryConfigInput } from "../../shared/memory";
import { FoldSummary } from "../kit";
import { ReadState } from "./common";
import { PageGlyph } from "./glyphs";
import "./memory.css";

const blank = { id: "", name: "", save: "", find: "", curate: "", timeoutSeconds: 15 };
type Profile = MemoryConfigInput["profiles"][number];
const fieldLabels: Record<string, string> = { id: "Profile ID", name: "Name", save: "Save executable", find: "Find executable", curate: "Curate executable", timeoutSeconds: "Timeout (seconds)" };
export function MemorySettings() {
  const query = experimental_useRpcQuery({ contract: memoryContract, method: "memorySettings", input: null });
  return <div className="tavern tv-page tv-set">{query.data ?
    <Profiles key={query.data.revision} value={query.data} reload={query.refetch} /> :
    <ReadState error={query.error} retry={query.refetch} />}</div>;
}
function Profiles({ value, reload }: { value: { revision: number; config: MemoryConfigInput }; reload: () => unknown }) {
  const [draft, setDraft] = useState(value.config);
  const [error, setError] = useState<string | null>(null);
  const mutation = experimental_useRpcMutation({ contract: memoryContract, method: "memoryConfigure" });
  const pending = mutation.isPending;
  const dirty = JSON.stringify(draft) !== JSON.stringify(value.config);
  const update = (index: number, patch: Partial<Profile>) => setDraft(current => ({
    active: patch.id !== undefined && current.active === current.profiles[index]?.id ? patch.id || "builtin" : current.active,
    profiles: current.profiles.map((profile, i) => i === index ? { ...profile, ...patch } : profile),
  }));
  const remove = (index: number) => setDraft(current => ({
    active: current.active === current.profiles[index]?.id ? "builtin" : current.active,
    profiles: current.profiles.filter((_, i) => i !== index),
  }));
  const save = async () => {
    setError(null);
    const result = memoryConfigInput.safeParse(draft);
    if (!result.success) {
      setError(result.error.issues.map(({ path: [group, index, field], message }) => {
        if (group === "profiles" && typeof index === "number") {
          const profile = draft.profiles[index]?.name || `Profile ${index + 1}`;
          return `${profile}, ${fieldLabels[String(field)] ?? "settings"}: ${message}`;
        }
        return `${group === "active" ? "Active store" : "Profiles"}: ${message}`;
      }).join(" "));
      return;
    }
    try { await mutation.mutate({ revision: value.revision, config: result.data }); await reload(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <section className="tv-card tv-settings-card" aria-label="Memory profiles">
    <header className="tv-settings-head"><PageGlyph name="file" size={18} /><div><h3>Note store</h3><p className="tv-settings-hint">Built-in works without setup. Switching stores does not move notes.</p></div></header>
    <div className="tv-settings-body tv-memory-controls">
      <form onSubmit={event => { event.preventDefault(); if (dirty && !pending) void save(); }}>
        <fieldset disabled={pending} className="tv-memory-fields">
          <label data-settings-row="memory.active"><span data-settings-copy>Active store</span><select className="tv-select" value={draft.active} onChange={event => setDraft({ ...draft, active: event.target.value })}>
            <option value="builtin">Built-in</option>
            {draft.profiles.map((profile, index) => <option value={profile.id} disabled={!profile.id} key={index}>{profile.name || profile.id || "Unnamed profile"}</option>)}
          </select></label>
          {draft.profiles.map((profile, i) => <details className="tv-memory-profile" key={i} open={!value.config.profiles[i] || undefined}>
            <FoldSummary>{profile.name || "New profile"}{draft.active === profile.id && " · Active"}</FoldSummary>
            <div className="tv-memory-fields">
              <div className="tv-memory-grid">
                <label data-settings-row="memory.profiles.name"><span data-settings-copy>Name</span><input className="tv-text" value={profile.name} maxLength={160} required onChange={event => update(i, { name: event.target.value })} /></label>
                <label data-settings-row="memory.profiles.id"><span data-settings-copy>Profile ID</span><input className="tv-text" value={profile.id} pattern="[a-z][a-z0-9-]{0,31}" required onChange={event => update(i, { id: event.target.value })} /></label>
              </div>
              {(["save", "find", "curate"] as const).map(op => <label key={op} data-settings-row={`memory.profiles.${op}`}><span data-settings-copy>{op[0]!.toUpperCase() + op.slice(1)} executable</span><input className="tv-text" value={profile[op]} maxLength={1024} required onChange={event => update(i, { [op]: event.target.value })} /></label>)}
              <label data-settings-row="memory.profiles.timeoutSeconds"><span data-settings-copy>Timeout (seconds)</span><input className="tv-text" value={profile.timeoutSeconds || ""} type="number" min={1} max={120} required onChange={event => update(i, { timeoutSeconds: Number(event.target.value) })} /></label>
              <div><button type="button" className="btn ghost" onClick={() => remove(i)}>Remove profile</button></div>
            </div>
          </details>)}
          <p>Use trusted absolute paths outside agent workspaces. Tavern checks each changed command with <code>--help</code> on your primary host before saving.</p>
          {error && <p role="alert" className="tv-problem">{error}</p>}
          <div className="tv-memory-actions">
            <button type="button" className="btn ghost" disabled={draft.profiles.length >= 20} onClick={() => setDraft({ ...draft, profiles: [...draft.profiles, { ...blank }] })}>Add profile</button>
            <button className="btn act" disabled={!dirty || pending}>{pending ? "Checking commands…" : "Save memory settings"}</button>
            {error && <button type="button" className="btn ghost" onClick={() => { setDraft(value.config); setError(null); void reload(); }}>Reload saved settings</button>}
          </div>
        </fieldset>
      </form>
    </div>
  </section>;
}
