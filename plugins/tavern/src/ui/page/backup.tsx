import { experimental_PluginRpcCallError, experimental_copyToClipboard, experimental_saveFile, experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { backupBundleSchema, backupContract, type BackupEntry, type BackupManifest, type BackupRestore } from "../../shared/backup";
import { ExpandsMark, Glyph, OverflowMenu, TimeAgo, localTime, plural, useToday } from "../kit";
import { PageGlyph } from "./glyphs";
import { ChangeList, NumberField, SettingDefault, useTavernSettings } from "./settings";
import { FoldLoad, SettingsSkeleton } from "./skeletons";

const size = (b: number) => b < 1000 ? `${b} B` : b < 1e6 ? `${(b / 1000).toFixed(b < 1e4 ? 1 : 0)} KB` : `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
const when = (at: number, day: number) => localTime(at, day);
/** Paths read with ~ for the home folder, as Import and export shows them; Copy path still copies the full one. */
export const tilde = (path: string) => path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/, "~");
const counts = (c: BackupEntry["counts"]) => [`${c.classes} class${c.classes === 1 ? "" : "es"}`, plural(c.characters, "character"), c.records === null ? null : `${c.records.toLocaleString("en")} record${c.records === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
export const tooLarge = (bytes: number, limit: number) => `Your records are about ${size(bytes)}, over the ${size(limit)} a download allows. Save backup keeps them on disk.`;
/** Until the server registers the backup calls, bb answers unknown_method; the page then shows nothing broken. */
export const backupsMissing = (e: unknown) => e instanceof experimental_PluginRpcCallError && e.code === "unknown_method";
const SOON = "Backups arrive in the next update.";
const message = (e: unknown) => backupsMissing(e) ? SOON : e instanceof Error ? e.message : String(e);
const and = (parts: string[]) => parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
const readText = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`)); reader.readAsText(file); });
const download = async (fileName: string, text: string) => (await experimental_saveFile({ fileName, blob: new Blob([text], { type: fileName.endsWith(".json") ? "application/json" : "text/markdown" }) })) === "started";

type From = { name: string } | { bundle: string };

/** One restore, previewed in place: what would change, then Restore applies exactly that preview. */
function RestorePreview({ from, onDone, onCancel }: { from: From; onDone: (receipt: string) => void; onCancel: () => void }) {
  const restore = experimental_useRpcMutation({ contract: backupContract, method: "backupRestore" });
  const [preview, setPreview] = useState<BackupRestore | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => { setError(null); setStale(false); try { setPreview(await restore.mutate({ from, apply: false })); } catch (e) { setError(message(e)); } };
  useEffect(() => { void ask(); }, []);
  const apply = async () => {
    if (!preview) return;
    setError(null);
    try {
      const out = await restore.mutate({ from, apply: true, previewHash: preview.previewHash });
      if (out.code === "stale") { setStale(true); setPreview(null); return; }
      if (out.code === "invalid") { setPreview(out); return; }
      const files = out.files.filter((f) => f.action !== "same").length;
      onDone([`Restored ${plural(out.settings.changes.length, "setting")}`, plural(files, "file"), out.records.action === "restore" ? plural(Object.values(out.records.counts).reduce((a, b) => a + b, 0), "record") : null].filter(Boolean).join(", ") + ".");
    } catch (e) { setError(message(e)); }
  };
  const changed = preview?.files.filter((f) => f.action !== "same") ?? [];
  const same = preview?.files.filter((f) => f.action === "same") ?? [];
  const recordTotal = preview ? Object.values(preview.records.counts).reduce((a, b) => a + b, 0) : 0;
  const nothing = preview && !preview.problems.length && !preview.settings.changes.length && !changed.length && preview.records.action !== "restore";
  const scope = preview ? and([preview.settings.changes.length ? plural(preview.settings.changes.length, "setting") : "", changed.length ? plural(changed.length, "file") : "", preview.records.action === "restore" ? `${recordTotal.toLocaleString("en")} record${recordTotal === 1 ? "" : "s"}` : ""].filter(Boolean)) : "";
  return <div className="tv-preview-box tv-bk-preview" aria-live="polite" aria-busy={restore.isPending}>
    {!preview && !stale && !error && <p className="m small" role="status">Checking what this backup would change…</p>}
    {stale && <p className="tv-problem" role="alert">The backup or Tavern changed after this preview, so nothing was restored. <button type="button" className="lnk-btn act" onClick={() => void ask()}><span>Preview again</span></button></p>}
    {error && <p className="tv-problem" role="alert">{error}</p>}
    {preview && <>
      {!!preview.skippedForgeProfiles?.length && <p className="tv-warn">Skipped forge profiles: {preview.skippedForgeProfiles.join(", ")}. Current profiles were kept. Edit forge commands on Tavern’s Settings page, Where work runs.</p>}
      {preview.problems.length > 0 && <ul className="tv-problem" role="alert">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {nothing ? <p className="m small">Everything already matches this backup.</p> : <>
        <div className="tv-bk-part"><b>Settings</b>{preview.settings.changes.length ? <ChangeList changes={preview.settings.changes} problems={[]} /> : <span className="m small">no change</span>}</div>
        <div className="tv-bk-part"><b>Files</b><span className="m small">{[changed.filter((f) => f.action === "add").length && `${changed.filter((f) => f.action === "add").length} added`, changed.filter((f) => f.action === "change").length && `${changed.filter((f) => f.action === "change").length} changed`, same.length && `${same.length} the same`].filter(Boolean).join(" · ") || "none"}</span>
          {changed.length > 0 && <ul className="tv-changes">{changed.map((f) => <li key={f.path}><span className={`tag tv-bk-${f.action}`}>{f.action === "add" ? "added" : "changed"}</span><code title={f.path}>{f.path}</code></li>)}</ul>}
          <p className="m small">Restore never deletes a file the backup does not have.</p>
        </div>
        <div className="tv-bk-part"><b>Records</b>{preview.records.action === "restore" ? <span>{recordTotal.toLocaleString("en")} record{recordTotal === 1 ? "" : "s"} restore into this empty Tavern: {Object.entries(preview.records.counts).map(([k, n]) => `${n} ${k}`).join(", ")}</span>
          : preview.records.action === "refused" ? <span className="tv-warn">Not restored: {preview.records.reason ?? "Tavern already has records"}. Settings, classes, characters and scopes still restore.</span>
          : <span className="m small">none in this backup</span>}</div>
      </>}
    </>}
    <div className="tv-set-acts">
      {preview && !nothing && preview.code === "preview" && <button type="button" className="btn sm pri" disabled={restore.isPending || preview.problems.length > 0} onClick={() => void apply()}><span>Restore {scope}</span></button>}
      <button type="button" className="lnk-btn act" onClick={onCancel}><span>{nothing ? "Close" : "Cancel"}</span></button>
    </div>
  </div>;
}

/** Settings page: save a backup, download one, restore one with an inline preview, and see how many are kept. */
export function BackupSection() {
  const day = useToday();
  const list = experimental_useRpcQuery({ contract: backupContract, method: "backupList", input: {} });
  const save = experimental_useRpcMutation({ contract: backupContract, method: "backupSave" });
  const exporter = experimental_useRpcMutation({ contract: backupContract, method: "backupExport" });
  const [withData, setWithData] = useState(false);
  const [projects, setProjects] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [fromFile, setFromFile] = useState<{ fileName: string; text: string; manifest: BackupManifest } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ids = useId();
  const d = list.data;
  if (!d && backupsMissing(list.error)) return <div className="tavern tv-page tv-set"><p className="tv-empty tv-bk-soon" data-empty>{SOON}</p></div>;
  if (!d) return <div className="tavern tv-page tv-set"><FoldLoad error={list.error} retry={list.refetch} label="the backups"><SettingsSkeleton rows={3} /></FoldLoad></div>;
  const overLimit = withData && d.dataBytes !== null && d.dataBytes > d.exportLimitBytes;
  const guard = async (fn: () => Promise<void>) => { setError(null); setReceipt(null); try { await fn(); } catch (e) { setError(message(e)); } };
  const onSave = () => guard(async () => {
    const out = await save.mutate({ withData, projects });
    if (out.code !== "ok" || !out.backup) { setError(out.problem ?? "The backup could not be saved."); return; }
    setReceipt(`Saved ${out.backup.name} (${size(out.backup.bytes)})${out.pruned.length ? `, and removed ${plural(out.pruned.length, "older backup")} past the keep count` : ""}.`);
    void list.refetch();
  });
  const onExport = () => guard(async () => {
    const out = await exporter.mutate({ withData, projects });
    if (out.code === "too-large") { setError(tooLarge(out.bytes, out.limit)); return; }
    setReceipt(await download(out.filename, out.json) ? `Downloaded ${out.filename}: ${counts(out.counts)}.` : "The download could not start.");
  });
  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    await guard(async () => {
      const text = await readText(file);
      let json: unknown;
      try { json = JSON.parse(text); } catch { setError(`${file.name} is not a Tavern backup: it is not JSON.`); return; }
      const parsed = backupBundleSchema.safeParse(json);
      if (!parsed.success) { setError(`${file.name} is not a Tavern backup (tavern-backup/1): ${parsed.error.issues[0]?.message ?? "unknown shape"}.`); return; }
      setFromFile({ fileName: file.name, text, manifest: parsed.data.manifest }); setOpen("file");
    });
    if (fileInput.current) fileInput.current.value = "";
  };
  const done = (text: string) => { setOpen(null); setFromFile(null); setReceipt(text); void list.refetch(); };
  const busy = save.isPending || exporter.isPending;
  return <div className="tavern tv-page tv-set tv-backup">
    <div className="tv-bk-opts" role="group" aria-label="Include in the backup">
      <span className="m small">Include:</span>
      <span className="tv-bk-optl"><label className="tv-set-check"><input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} /><span>With records{d.dataBytes !== null ? ` (about ${size(d.dataBytes)})` : ""}</span></label>
      <label className="tv-set-check"><input type="checkbox" checked={projects} onChange={(e) => setProjects(e.target.checked)} /><span>Each project's .agents/tavern folder</span></label></span>
    </div>
    <div className="tv-set-acts">
      <button type="button" className="btn sm pri" disabled={busy} onClick={() => void onSave()}><PageGlyph name="archive" size={13} /><span>Save backup now</span></button>
      <button type="button" className="btn sm" disabled={busy || overLimit} aria-describedby={overLimit ? `${ids}-limit` : undefined} onClick={() => void onExport()}><PageGlyph name="export" size={13} /><span>Download backup (JSON)</span></button>
    </div>
    {overLimit && <p id={`${ids}-limit`} className="tv-holdnote" role="status"><PageGlyph name="note" /><span>{tooLarge(d.dataBytes!, d.exportLimitBytes)}</span></p>}
    {receipt && <p className="tv-receipt" role="status"><Glyph name="check" size={14} className="tv-g" /><span>{receipt}</span></p>}
    {error && <p className="tv-problem" role="alert">{error}</p>}
    {d.error && <p className="tv-problem" role="alert">The backups folder could not be read: {d.error}</p>}

    <div className="tv-bk-head"><b>Saved backups</b>{d.backups.length > 0 && <span className="tv-count">{plural(d.backups.length, "backup")}</span>}<KeepField fallback={d.keep} /></div>
    {d.backups.length === 0 ? <p className="tv-empty" data-empty>No saved backups yet. Save one now, or have a script run <code>bb tavern backup save</code>.</p>
      : <ul className="tv-bk-list">{d.backups.map((b) => <li key={b.name} className="tv-bk-row">
        <div className="tv-bk-main">
          <span className="tv-bk-t"><b title={b.name}>{when(b.createdAt, day)}</b><TimeAgo at={b.createdAt} />{b.withData && <span className="tag">with records</span>}{b.projects && <span className="tag">projects</span>}</span>
          <span className="m small">{counts(b.counts)} · {size(b.bytes)} · Tavern {b.tavernVersion}</span>
          {b.problems.length > 0 && <span className="tv-bk-prob"><PageGlyph name="fail" size={13} /><span>{b.problems.join("; ")}</span></span>}
        </div>
        <button type="button" className="lnk-btn act tv-bk-go" aria-expanded={open === b.name} aria-controls={`${ids}-${b.name}`} aria-label={`Restore the backup from ${when(b.createdAt, day)}`} onClick={() => setOpen(open === b.name ? null : b.name)}><span>Restore</span><ExpandsMark open={open === b.name} /></button>
        {open === b.name && <div id={`${ids}-${b.name}`} className="tv-bk-open"><RestorePreview from={{ name: b.name }} onDone={done} onCancel={() => setOpen(null)} /></div>}
      </li>)}</ul>}

    <div className="tv-set-acts">
      <button type="button" className="btn sm" onClick={() => fileInput.current?.click()}><PageGlyph name="file" size={13} /><span>Restore from a file…</span></button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="Choose a Tavern backup file" onChange={(e) => void pickFile(e.target.files?.[0])} />
    </div>
    {open === "file" && fromFile && <div className="tv-bk-open">
      <p className="m small"><b>{fromFile.fileName}</b>: saved {when(fromFile.manifest.createdAt, day)} on {fromFile.manifest.machine.hostname}, Tavern {fromFile.manifest.tavernVersion}, {counts(fromFile.manifest.counts)}.</p>
      <RestorePreview from={{ bundle: fromFile.text }} onDone={done} onCancel={() => { setOpen(null); setFromFile(null); }} />
    </div>}
    <FolderLine dir={d.dir} />
  </div>;
}

/** How many saved backups to keep; older ones are removed after each save. 0 keeps every backup. */
function KeepField({ fallback }: { fallback: number }) {
  const api = useTavernSettings();
  const id = useId();
  if (!api.data) return <span className="m small">{fallback === 0 ? "keeps every backup" : `keeps the newest ${fallback}`}</span>;
  const keep = api.data.effective.data.backupKeep;
  return <div className="tv-bk-keep" data-setting-keys="data.backupKeep">
    <label htmlFor={id} className="m small">Keep the newest</label>
    <NumberField id={id} value={keep} min={0} max={365} unit={keep === 1 ? "backup" : "backups"} disabled={api.pending} onSave={(v) => void api.save({ data: { backupKeep: v } })} />
    <span className="m small">0 keeps every backup</span>
    <SettingDefault setting="data.backupKeep" api={api} />
    {api.note && <span className="tv-problem" role="alert">{api.note}</span>}
  </div>;
}

function FolderLine({ dir }: { dir: string }) {
  const [copied, setCopied] = useState(false);
  return <p className="m small tv-bk-dir">Folder: <code title={dir}>{tilde(dir)}</code> <button type="button" className="lnk-btn act" onClick={() => void experimental_copyToClipboard({ text: dir }).then((ok) => setCopied(ok))}><span>{copied ? "Copied" : "Copy path"}</span></button></p>;
}

/** The Export menu on Classes and Character sheets: one file on a detail page, all of them on a list page. */
export function RegistryExport({ kind, id, name }: { kind: "class" | "character"; id?: string; name: string }) {
  const available = experimental_useRpcQuery({ contract: backupContract, method: "backupList", input: {} });
  const file = experimental_useRpcMutation({ contract: backupContract, method: "registryFile" });
  const folder = experimental_useRpcMutation({ contract: backupContract, method: "registryExportFolder" });
  const bundle = experimental_useRpcMutation({ contract: backupContract, method: "backupExport" });
  const [receipt, setReceipt] = useState<{ text: string; copy?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<void>) => { setError(null); setReceipt(null); fn().catch((e) => setError(message(e))); };
  const shipped = (source: string) => source === "shipped" ? " It ships with Tavern; a copy in ~/.agents/tavern/ overrides it." : "";
  const items = id ? [
    { id: "file", label: "Save this file", run: () => run(async () => { const out = await file.mutate({ kind, id }); setReceipt({ text: (await download(out.filename, out.text)) ? `Saved ${out.filename}.${shipped(out.source)}` : "The download could not start." }); }) },
    { id: "md", label: "Copy as Markdown", run: () => run(async () => { const out = await file.mutate({ kind, id }); setReceipt({ text: (await experimental_copyToClipboard({ text: out.text })) ? `Copied ${out.filename} as Markdown.${shipped(out.source)}` : "Could not copy to the clipboard." }); }) },
  ] : [
    { id: "folder", label: "Save as files in ~/.agents/tavern/exports", title: "Saves one Markdown file each in a new dated folder under ~/.agents/tavern/exports",
      content: <><span className="gap" /><span className="tv-mi2"><span>Save as files</span><span className="tv-mi2-p" data-content>~/.agents/tavern/exports</span></span></>, run: () => run(async () => { const out = await folder.mutate({ kind }); setReceipt({ text: `Saved ${plural(out.files.length, "file")} to ${tilde(out.path)}.`, copy: out.path }); }) },
    { id: "bundle", label: "Download one file (JSON)", run: () => run(async () => { const out = await bundle.mutate({ parts: [kind === "class" ? "classes" : "characters"] }); if (out.code === "too-large") { setError(tooLarge(out.bytes, out.limit)); return; } setReceipt({ text: (await download(out.filename, out.json)) ? `Downloaded ${out.filename}.` : "The download could not start." }); }) },
  ];
  const menu = <OverflowMenu label={`Export ${name}`} className="tv-export-menu" triggerClassName="btn sm" trigger={<><PageGlyph name="export" size={14} /><span>Export</span></>} items={items} />;
  // While Tavern asks whether exports exist, the menu's space is held, inert: unseen, unfocusable and out of the accessibility tree.
  if (!available.data) return available.error ? null : <div className="tv-export" style={{ visibility: "hidden" }} inert aria-hidden="true">{menu}</div>;
  return <div className={`tv-export ${receipt || error ? "has-receipt" : ""}`}>
    {menu}
    {(receipt || error) && <ExportReceipt receipt={receipt} error={error} />}
  </div>;
}

function ExportReceipt({ receipt, error }: { receipt: { text: string; copy?: string } | null; error: string | null }): ReactNode {
  const [copied, setCopied] = useState(false);
  if (error) return <p className="tv-problem" role="alert">{error}</p>;
  return <p className="tv-receipt" role="status"><Glyph name="check" size={14} className="tv-g" /><span>{receipt!.text}</span>{receipt!.copy && <button type="button" className="lnk-btn act" onClick={() => void experimental_copyToClipboard({ text: receipt!.copy! }).then(setCopied)}><span>{copied ? "Copied" : "Copy path"}</span></button>}</p>;
}

export const BACKUP_INTRO = "Without records, a backup holds your settings, classes, characters and scopes file. Records add quests, plans, asks, decisions, journals and events; never secrets or transcripts.";
