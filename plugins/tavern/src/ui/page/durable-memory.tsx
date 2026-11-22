import { experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useId, useState } from "react";
import { memoryContract, memoryDraft, memoryKind, memoryStatus, type MemoryDraft, type MemoryListInput, type MemoryManageInput, type MemoryNote } from "../../shared/memory";
import { TimeAgo } from "../kit";
import { ReadState } from "./common";
import { PageGlyph } from "./glyphs";
import "./memory.css";

const word = (value: string) => value[0]!.toUpperCase() + value.slice(1);
const base: MemoryListInput = { project: "", text: "", kind: null, status: null, memory: null, limit: 12, offset: 0 };
const date = (at: number) => new Date(at).toLocaleDateString();
export function MemoryPage() {
  const projects = experimental_useRpcQuery({ contract: memoryContract, method: "memoryProjects", input: null });
  const [filter, setFilter] = useState(base);
  const [draftText, setDraftText] = useState("");
  const [notice, setNotice] = useState("");
  const searchId = useId();
  const navigate = useBbNavigate();
  const input = { ...filter, project: filter.project || projects.data?.[0]?.id || "" };
  const results = experimental_useRpcQuery({ contract: memoryContract, method: "memoryList", input, enabled: !!input.project });
  const data = results.error ? undefined : results.data;
  return <section className="tv-memory-page" aria-label="Memory">
    <header className="tv-memory-header"><PageGlyph name="ledger" size={22} /><div><h2>Memory</h2><p>Durable notes from Keepers and their parties.</p></div>{data && <span className="tv-memory-store">Store: {data.store}</span>}</header>
    {!projects.data ? <ReadState error={projects.error} retry={projects.refetch} /> : !projects.data.length ? <p role="status" className="tv-empty">No projects to search.</p> : <>
      <form className="tv-card tv-memory-filter" onSubmit={event => { event.preventDefault(); setFilter({ ...filter, text: draftText.trim(), offset: 0 }); }}>
        <label className="tv-memory-search" htmlFor={searchId}>Search notes<input className="tv-text" id={searchId} type="search" maxLength={500} value={draftText} onChange={event => setDraftText(event.target.value)} /></label>
        <label>Project<select className="tv-select" value={input.project} onChange={event => setFilter({ ...filter, project: event.target.value, offset: 0 })}>{projects.data.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
        <label>Kind<select className="tv-select" value={filter.kind ?? ""} onChange={event => setFilter({ ...filter, kind: memoryKind.safeParse(event.target.value).data ?? null, offset: 0 })}><option value="">All kinds</option>{memoryKind.options.map(kind => <option key={kind} value={kind}>{word(kind)}</option>)}</select></label>
        <label>Status<select className="tv-select" value={filter.status ?? filter.memory ?? ""} onChange={event => { const value = event.target.value; setFilter({ ...filter, status: memoryStatus.safeParse(value).data ?? null, memory: value === "excluded" ? value : null, offset: 0 }); }}><option value="">All statuses</option>{memoryStatus.options.map(status => <option key={status} value={status}>{word(status)}</option>)}<option value="excluded">Excluded from memory</option></select></label>
        <button className="btn act">Search</button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {!data ? <ReadState error={results.error} retry={results.refetch} /> : <>
        {data.external && <p className="tv-memory-backend">{data.recorded ? "Showing changes recorded by Tavern, not a fresh read of the store." : `Showing search results from ${data.store}.`} To edit, supersede or retire a note, manage notes in {data.store}.</p>}
        <section className="tv-card tv-memory-review" aria-label="Needs Keeper review">
          <h3>Needs Keeper review</h3>
          {data.unreviewed.length ? <ul>{data.unreviewed.map(row => <li key={row.id}><span data-content>{row.title}</span>
            <span className="tv-memory-review-meta">{data.people?.[row.author] ?? "Unknown author"} · <TimeAgo at={row.createdAt} />{row.curator && <button type="button" className="lnk-btn act" onClick={() => navigate.toThread(row.curator!)}>Open Keeper</button>}</span>
          </li>)}</ul> : <p>No notes awaiting review in this project.</p>}
        </section>
        <section aria-label="Notes" className="tv-memory-notes">
          <h3>Notes</h3>
          {!data.notes.length && <p className="tv-empty" role="status">No matching notes.</p>}
          {data.notes.map(note => <NoteRow key={`${note.id}:${note.updatedAt}`} note={note} external={data.external} author={data.people?.[note.author.thread] ?? `Unknown author (${word(note.author.classId)})`}
            reviewer={note.reviewedBy ? data.people?.[note.reviewedBy] ?? "Unknown Keeper" : null} priorTitle={note.supersedes ? data.previousTitles?.[note.supersedes] : undefined} saved={async () => { setNotice("Note updated."); await results.refetch(); }} />)}
          {filter.offset > 0 || data.more ? <div className="tv-memory-actions"><button type="button" className="btn ghost" disabled={!filter.offset} onClick={() => setFilter({ ...filter, offset: Math.max(0, filter.offset - filter.limit) })}>Previous notes</button><button type="button" className="btn ghost" disabled={!data.more} onClick={() => setFilter({ ...filter, offset: filter.offset + filter.limit })}>Next notes</button></div> : null}
        </section>
      </>}
    </>}
  </section>;
}

function PreviousNote({ project, id, title }: { project: string; id: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const region = useId();
  const query = experimental_useRpcQuery({ contract: memoryContract, method: "memoryPrevious", input: { project, id }, enabled: open });
  if (!title) return "Previous note not available in Tavern";
  return <><button type="button" className="lnk-btn act" aria-expanded={open} aria-controls={region} onClick={() => setOpen(!open)}>{title}</button>
    <div id={region} hidden={!open} className="tv-memory-prior">{open && (query.data ?
      <p data-content className="tv-memory-body">{query.data.body}</p> : query.data === null ?
        <p role="status">Previous note not available in Tavern.</p> : <ReadState error={query.error} retry={query.refetch} />)}</div></>;
}

type Edit = MemoryManageInput["action"];
function NoteRow({ note, external, author, reviewer, priorTitle, saved }: { note: MemoryNote; external: boolean; author: string; reviewer: string | null; priorTitle?: string; saved: () => Promise<void> }) {
  const [action, setAction] = useState<Edit | null>(null);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = experimental_useRpcMutation({ contract: memoryContract, method: "memoryManage" });
  const target = { id: note.id, expectedUpdatedAt: note.updatedAt };
  const start = (next: Edit) => { setAction(next); setError(null); setTitle(note.title); setBody(note.body); setReason(""); };
  const save = async () => {
    if (!action) return;
    setError(null);
    try {
      let input: MemoryManageInput;
      if (action === "edit" || action === "supersede") {
        const draft: MemoryDraft = memoryDraft.parse({ title, body, kind: note.kind, source: note.source, appliesTo: note.appliesTo, tags: note.tags });
        input = { ...target, action, note: draft };
      } else if (action === "exclude") input = { ...target, action, reason: reason.trim() };
      else input = { ...target, action };
      await mutation.mutate(input);
      setAction(null);
      await saved();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <details className="tv-card tv-memory-note">
    <summary><span data-content>{note.title}</span><span className="tv-memory-meta"><span>{word(note.kind)}</span>{note.status !== "accepted" && <span>{word(note.status)}</span>}{note.memory === "excluded" && <span>Excluded</span>}{!note.reviewedBy && note.status === "accepted" && <span>Unreviewed</span>}</span></summary>
    <div className="tv-memory-detail">
      <p data-content className="tv-memory-body">{note.body}</p>
      <dl className="tv-memory-facts">
        <dt>Source</dt><dd data-content>{word(note.source.kind)}: <code>{note.source.value}</code></dd>
        <dt>Applies to</dt><dd data-content>{word(note.appliesTo.kind)}: {note.appliesTo.value}</dd>
        <dt>Author</dt><dd data-content>{author}</dd>
        <dt>Reviewed</dt><dd>{reviewer && note.reviewedAt !== null ? `${reviewer} · ${date(note.reviewedAt)}` : "Not yet"}</dd>
        {note.tags.length > 0 && <><dt>Tags</dt><dd data-content>{note.tags.join(", ")}</dd></>}
        {note.exclusionReason && <><dt>Excluded because</dt><dd data-content>{note.exclusionReason}</dd></>}
        {note.supersedes && <><dt>Supersedes</dt><dd><PreviousNote project={note.project} id={note.supersedes} title={priorTitle} /></dd></>}
      </dl>
      {note.status === "accepted" && !action && <div className="tv-memory-actions">{(external ? [note.memory === "included" ? "exclude" : "include"] as const : ["edit", "supersede", note.memory === "included" ? "exclude" : "include", "retire"] as const).map(op => <button className="btn ghost" key={op} type="button" onClick={() => start(op)}>{op === "include" ? "Re-include" : word(op)}</button>)}</div>}
      {action && <form className="tv-memory-fields" onSubmit={event => { event.preventDefault(); if (!mutation.isPending) void save(); }}>
        <h4>{action === "include" ? "Re-include note" : `${word(action)} note`}</h4>
        {(action === "edit" || action === "supersede") && <>
          {action === "supersede" && <p>The old note stays in history. Search will return the replacement.</p>}
          <label>Title<input className="tv-text" required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label>Body<textarea className="tv-text" required maxLength={4000} rows={5} value={body} onChange={event => setBody(event.target.value)} /></label>
        </>}
        {action === "exclude" && <label>Reason<input className="tv-text" required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>}
        {action === "retire" && <p>Retire this note from search and keep it in history.</p>}
        {action === "include" && <p>Return this note to search and clear its exclusion reason.</p>}
        {error && <p className="tv-problem" role="alert">{error}</p>}
        <div className="tv-memory-actions"><button className="btn act" disabled={mutation.isPending}>{action === "edit" ? "Save changes" : action === "include" ? "Re-include note" : `Confirm ${action}`}</button><button type="button" className="btn ghost" disabled={mutation.isPending} onClick={() => setAction(null)}>Cancel</button></div>
      </form>}
    </div>
  </details>;
}
