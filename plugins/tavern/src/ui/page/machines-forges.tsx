import { useId, useState } from "react";
import type { ForgeProfile } from "../../shared/placement-settings";

export function ForgeProfiles({ profiles, pending, save }: { profiles: ForgeProfile[]; pending: boolean; save: (profiles: ForgeProfile[]) => Promise<boolean> }) {
  const [editing, setEditing] = useState<ForgeProfile | null>(null);
  const [adding, setAdding] = useState(false);
  const uid = useId();
  const submit = async () => {
    if (!editing) return;
    const next = adding ? [...profiles, editing] : profiles.map(profile => profile.id === editing.id ? editing : profile);
    if (await save(next)) { setEditing(null); setAdding(false); }
  };
  return <section className="mx-section" aria-label="Forge profiles"><h2>Forge profiles</h2>
    <p>Choose how draft pull requests open from home. Commands run on the source host in its checkout. The description goes to standard input. Tavern opens drafts only; it never marks ready or merges.</p>
    {profiles.length === 0 && <p>No forge profiles. With no profile, every rule opens pull requests on the member’s machine.</p>}
    {profiles.map(profile => <div className="tv-set-row" key={profile.id}><div className="tv-set-l"><b>{profile.name}</b><p>{profile.kind === "github" ? "GitHub through gh" : "User command"}{profile.enabled ? "" : ", disabled"}</p></div><div className="tv-set-c"><button type="button" className="btn" onClick={() => { setEditing(profile); setAdding(false); }}>Edit {profile.name}</button><button type="button" className="btn" disabled={pending} onClick={() => void save(profiles.filter(item => item.id !== profile.id))}>Remove {profile.name}</button></div></div>)}
    {!editing && <button type="button" className="btn" onClick={() => { setEditing({ id: "forge", name: "Forge", kind: "github", enabled: true }); setAdding(true); }}>Add forge profile</button>}
    {editing && <form className="mx-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="mx-field"><label htmlFor={`${uid}-id`}>Profile ID</label><input className="tv-text" id={`${uid}-id`} value={editing.id} disabled={!adding} pattern="[a-z][a-z0-9-]{0,31}" required onChange={event => setEditing({ ...editing, id: event.target.value })} /></div>
      <div className="mx-field"><label htmlFor={`${uid}-name`}>Name</label><input className="tv-text" id={`${uid}-name`} value={editing.name} required onChange={event => setEditing({ ...editing, name: event.target.value })} /></div>
      <div className="mx-field"><label htmlFor={`${uid}-kind`}>Kind</label><select className="tv-select" id={`${uid}-kind`} value={editing.kind} onChange={event => setEditing(event.target.value === "github" ? { id: editing.id, name: editing.name, enabled: editing.enabled, kind: "github" } : { ...editing, kind: "command", open: "" })}><option value="github">GitHub through gh</option><option value="command">Command</option></select></div>
      <label><input type="checkbox" checked={editing.enabled} onChange={event => setEditing({ ...editing, enabled: event.target.checked })} /> Enabled</label>
      {editing.kind === "command" && <>
        <div className="mx-field"><label htmlFor={`${uid}-open`}>Open command</label><textarea className="tv-text" id={`${uid}-open`} value={editing.open} required onChange={event => setEditing({ ...editing, open: event.target.value })} /><p className="mx-hint">A shell string. Print the existing or new draft URL as the last URL in standard output. Commands have a two-minute limit and are not retried.</p></div>
        <div className="mx-field"><label htmlFor={`${uid}-state`}>State command (optional)</label><textarea className="tv-text" id={`${uid}-state`} value={editing.state ?? ""} onChange={event => { const { state, ...rest } = editing; setEditing(event.target.value ? { ...rest, state: event.target.value } : rest); }} /></div>
        <p className="mx-hint">Open receives FORGE_REMOTE, FORGE_BASE, FORGE_HEAD, FORGE_TITLE and FORGE_DRAFT=1. State receives FORGE_URL and FORGE_PR_NUMBER and prints open, merged or closed. Each variable is also set with the LOOM_ prefix.</p>
      </>}
      <div className="mx-ef"><button className="btn pri" type="submit" disabled={pending}>Save profile</button><button className="btn" type="button" onClick={() => setEditing(null)}>Cancel</button></div>
    </form>}
  </section>;
}
