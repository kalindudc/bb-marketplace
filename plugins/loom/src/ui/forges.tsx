import { useState } from "react";
import type { ForgeProfileView, ForgeTestView } from "../contract";
import type { ForgeProfile } from "../spec";
import { BUTTON, BUTTON_PRIMARY, CARD, ConfirmButton, FIELD, messageOf, momentLabel, useAction, useLoom, useLoomWrite } from "./common";

/** The commands a profile runs, in the order the form shows them, with what each does and what it gets. */
const COMMANDS = [
  { key: "open", what: "Opens the pull request and prints its URL. Gets LOOM_REMOTE, LOOM_BASE, LOOM_HEAD, LOOM_TITLE and LOOM_DRAFT; the description is on stdin.", required: true },
  { key: "state", what: "Prints open, merged or closed for LOOM_URL.", required: true },
  { key: "feedback", what: "Prints the pull request's checks, reviews and comments as one JSON object, for LOOM_URL. Without it Loom reads only the state." },
  { key: "edit", what: "Sets the title (LOOM_TITLE) and the description (stdin) of LOOM_URL." },
  { key: "reply", what: "Answers the item LOOM_ITEM (LOOM_ITEM_KIND) with the text on stdin; LOOM_RESOLVE is 1 to resolve its thread." },
  { key: "retarget", what: "Moves LOOM_URL to the base branch LOOM_BASE." },
  { key: "ready", what: "Marks the draft LOOM_URL ready for review." },
  { key: "request_reviews", what: "Asks the logins in LOOM_REVIEWERS (comma-separated) to review LOOM_URL." },
  { key: "merge", what: "Merges LOOM_URL at LOOM_SHA, or hands it to the server's merge service; for auto_merge with method = \"command\"." },
  { key: "review_start", what: "The review gate: asks an outside reviewer to review the draft LOOM_URL at LOOM_SHA, once per push of the ticket's own work. Runs only on projects that set merge.publish." },
  { key: "review_read", what: "Prints {\"state\": \"pending\" | \"done\" | \"failed\", \"findings\": [{\"id\", \"title\", \"body\", \"path\", \"line\", \"severity\"}]} for LOOM_SHA; polled at each read." },
] as const;
type CommandKey = (typeof COMMANDS)[number]["key"];

interface Draft {
  original: string | null;
  id: string;
  name: string;
  commands: Record<CommandKey, string>;
  afterOpen: string;
  afterPush: string;
  ignoreChecks: string;
  bots: string;
  notes: string;
  reviewRounds: string;
}

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
const globs = (text: string) => text.split(",").map((glob) => glob.trim()).filter((glob) => glob !== "");

function draftOf(profile: ForgeProfile | null): Draft {
  const commands = Object.fromEntries(COMMANDS.map(({ key }) => [key, profile?.[key] ?? ""])) as Record<CommandKey, string>;
  return {
    original: profile?.id ?? null,
    id: profile?.id ?? "",
    name: profile?.name ?? "",
    commands,
    afterOpen: (profile?.after_open ?? []).join("\n"),
    afterPush: (profile?.after_push ?? []).join("\n"),
    ignoreChecks: (profile?.ignore_checks ?? []).join(", "),
    bots: (profile?.bots ?? []).join(", "),
    notes: profile?.notes ?? "",
    reviewRounds: profile?.review_rounds === undefined ? "" : String(profile.review_rounds),
  };
}

/** The profile the form holds, with empty fields left out; the server checks the rest. */
export function profileOf(draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { id: draft.id.trim(), name: draft.name.trim(), kind: "command" };
  for (const { key } of COMMANDS) if (draft.commands[key].trim() !== "") out[key] = draft.commands[key].trim();
  if (lines(draft.afterOpen).length > 0) out.after_open = lines(draft.afterOpen);
  if (lines(draft.afterPush).length > 0) out.after_push = lines(draft.afterPush);
  if (globs(draft.ignoreChecks).length > 0) out.ignore_checks = globs(draft.ignoreChecks);
  if (globs(draft.bots).length > 0) out.bots = globs(draft.bots);
  if (draft.notes.trim() !== "") out.notes = draft.notes.trim();
  if (draft.reviewRounds.trim() !== "") out.review_rounds = Number(draft.reviewRounds.trim());
  return out;
}

/** A test run: a pull request URL, the Test button, and what it read, or what failed. */
function TestRun({ label, run }: { label: string; run(url: string): Promise<ForgeTestView> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ForgeTestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await run(url.trim()));
    } catch (failure) {
      setResult(null);
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-forge-test className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label={`Pull request to test ${label} against`} className={`${FIELD} min-w-0 flex-1 font-mono text-xs`} placeholder="https://forge.example.com/acme/shop/pull/12" value={url} onChange={(event) => setUrl(event.target.value)} />
        <button type="button" className={BUTTON} disabled={busy || url.trim() === ""} onClick={() => void test()}>
          {busy ? "Testing…" : "Test"}
        </button>
      </div>
      <p className="text-xs text-[var(--loom-muted)]">Runs only the state and feedback commands, which read the pull request and change nothing.</p>
      {error !== null && <p className="text-xs text-[var(--loom-bad)]">{error}</p>}
      {result !== null && (
        <pre data-forge-test-result={result.passed ? "passed" : "failed"} className={`max-h-96 overflow-auto rounded-md border p-2 font-mono text-[11.5px] leading-relaxed ${result.passed ? "border-border-seam" : "border-destructive-text"}`}>
          {result.text}
        </pre>
      )}
    </div>
  );
}

function ProfileCard({ view, onEdit }: { view: ForgeProfileView; onEdit(): void }) {
  const remove = useLoomWrite("deleteForgeProfile");
  const test = useLoomWrite("testForgeProfile");
  const { busy, act } = useAction();
  const { profile } = view;
  const runs = COMMANDS.filter(({ key }) => profile[key] !== undefined).map(({ key }) => key);
  return (
    <li data-forge-profile={profile.id} className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {profile.name} <span className="font-mono text-xs font-normal text-[var(--loom-muted)]">{profile.id}</span>
          </div>
          <div className="text-xs text-[var(--loom-muted)]">
            Version {view.hash}, saved {momentLabel(view.updatedAt)}. {view.usedBy.length === 0 ? "No project uses it." : `Used by ${view.usedBy.map((use) => `${use.slug}${use.inForce ? "" : " (a version not approved yet)"}`).join(", ")}.`}
            {view.usedBy.length === 0 && !view.deletable && " Older or archived specs name it, so Loom keeps it."}
          </div>
        </div>
        <button type="button" aria-label={`Edit ${profile.name}`} className={BUTTON} onClick={onEdit}>
          Edit
        </button>
        {view.deletable && <ConfirmButton label="Delete" confirmLabel={`Yes, delete ${profile.name}`} disarmKey={profile.id} danger disabled={busy} onConfirm={() => void act(() => remove({ id: profile.id, confirm: true }), `Deleted ${profile.name}`)} />}
      </div>
      <div className="mt-1.5 text-xs text-[var(--loom-muted)]">
        Runs <span className="font-mono">{runs.join(", ")}</span>
        {profile.after_open !== undefined && ", after_open"}
        {profile.after_push !== undefined && ", after_push"}
        {profile.bots !== undefined && `; counts ${profile.bots.join(", ")} as bots`}
      </div>
      <TestRun label={profile.name} run={(url) => test({ id: profile.id, url })} />
    </li>
  );
}

function ProfileForm({ initial, onDone }: { initial: Draft; onDone(): void }) {
  const [draft, setDraft] = useState(initial);
  const save = useLoomWrite("saveForgeProfile");
  const test = useLoomWrite("testForgeProfile");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await save({ profile: profileOf(draft), original: draft.original, confirm: true });
      onDone();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setSaving(false);
    }
  };
  const row = "grid grid-cols-1 items-start gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3";
  const label = "pt-1.5 text-xs text-[var(--loom-muted)]";
  return (
    <div data-forge-form className={`${CARD} flex flex-col gap-2.5`}>
      <b className="text-sm">{draft.original === null ? "Add a forge profile" : `Edit ${initial.name}`}</b>
      <label className={row}>
        <span className={label}>Name</span>
        <input aria-label="Profile name" className={FIELD} placeholder="Forge" value={draft.name} onChange={(event) => set("name", event.target.value)} />
      </label>
      <label className={row}>
        <span className={label}>Id</span>
        <span>
          <input aria-label="Profile id" className={`${FIELD} font-mono`} placeholder="forge" value={draft.id} disabled={draft.original !== null} onChange={(event) => set("id", event.target.value)} />
          <span className="mt-1 block text-xs text-[var(--loom-muted)]">What a spec names: forge = {"{"} profile = "{draft.id.trim() || "forge"}" {"}"}. Lowercase letters, digits and dashes; it cannot change later.</span>
        </span>
      </label>
      {COMMANDS.map((command) => (
        <label key={command.key} className={row}>
          <span className={label}>
            <span className="font-mono">{command.key}</span>
            {"required" in command && " (required)"}
          </span>
          <span>
            <input aria-label={`${command.key} command`} className={`${FIELD} font-mono text-xs`} value={draft.commands[command.key]} onChange={(event) => set("commands", { ...draft.commands, [command.key]: event.target.value })} />
            <span className="mt-1 block text-xs text-[var(--loom-muted)]">{command.what}</span>
          </span>
        </label>
      ))}
      <label className={row}>
        <span className={label}>after_open</span>
        <span>
          <textarea aria-label="after_open commands" rows={2} className={`${FIELD} font-mono text-xs`} value={draft.afterOpen} onChange={(event) => set("afterOpen", event.target.value)} />
          <span className="mt-1 block text-xs text-[var(--loom-muted)]">One command per line, run once after the pull request opens; a failure is posted and holds nothing.</span>
        </span>
      </label>
      <label className={row}>
        <span className={label}>after_push</span>
        <span>
          <textarea aria-label="after_push commands" rows={2} className={`${FIELD} font-mono text-xs`} value={draft.afterPush} onChange={(event) => set("afterPush", event.target.value)} />
          <span className="mt-1 block text-xs text-[var(--loom-muted)]">One command per line, run after each push to the open pull request and after Loom moves it to another base.</span>
        </span>
      </label>
      <label className={row}>
        <span className={label}>Ignored checks</span>
        <input aria-label="Ignored checks" className={`${FIELD} font-mono text-xs`} placeholder="reviews, Bot comments addressed" value={draft.ignoreChecks} onChange={(event) => set("ignoreChecks", event.target.value)} />
      </label>
      <label className={row}>
        <span className={label}>Bot authors</span>
        <span>
          <input aria-label="Bot authors" className={`${FIELD} font-mono text-xs`} placeholder="*@robots.example.com, merge-bot*" value={draft.bots} onChange={(event) => set("bots", event.target.value)} />
          <span className="mt-1 block text-xs text-[var(--loom-muted)]">Globs separated by commas. Their top-level comments start no fix round, on top of the accounts the server marks as bots and Loom's Bot authors setting.</span>
        </span>
      </label>
      <label className={row}>
        <span className={label}>Review gate rounds</span>
        <span>
          <input aria-label="Review gate rounds" inputMode="numeric" className={`${FIELD} w-24`} placeholder="3" value={draft.reviewRounds} onChange={(event) => set("reviewRounds", event.target.value)} />
          <span className="mt-1 block text-xs text-[var(--loom-muted)]">How many fix rounds the review gate's findings may start before Loom stops sending them and leaves the draft to you. 1 to 10; empty is 3.</span>
        </span>
      </label>
      <label className={row}>
        <span className={label}>Notes for agents</span>
        <span>
          <textarea aria-label="Notes for agents" rows={3} className={FIELD} value={draft.notes} onChange={(event) => set("notes", event.target.value)} />
          <span className="mt-1 block text-xs text-[var(--loom-muted)]">Added to the brief of every worker and reviewer of a pull request on this forge, such as how the server's review bot clears a finding.</span>
        </span>
      </label>
      <TestRun label="this profile" run={(url) => test({ profile: profileOf(draft), url })} />
      {error !== null && <p className="text-xs text-[var(--loom-bad)]">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} onClick={onDone}>
          Cancel
        </button>
        <button type="button" className={BUTTON_PRIMARY} disabled={saving} onClick={() => void submit()}>
          Save profile
        </button>
      </div>
    </div>
  );
}

/** Loom's forge profiles: each one's version, the projects that use it and a test run, and a form to add or edit one. */
export function ForgesSection() {
  const { data, error } = useLoom("forgeProfiles", null);
  const [editing, setEditing] = useState<Draft | null>(null);
  if (data === undefined) return error !== null ? <p className="text-sm text-[var(--loom-bad)]">Could not load the forge profiles: {error}</p> : <p className="text-sm text-[var(--loom-muted)]">Loading…</p>;
  return (
    <div data-section="forges" className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2.5">
        {data.map((view) => (
          <ProfileCard key={view.profile.id} view={view} onEdit={() => setEditing(draftOf(view.profile))} />
        ))}
      </ul>
      {data.length === 0 && <p className="text-sm text-[var(--loom-muted)]">No forge profiles yet. A spec can still write its forge's commands itself; a profile keeps them in one place for every project.</p>}
      {editing !== null ? (
        <ProfileForm key={editing.original ?? "new"} initial={editing} onDone={() => setEditing(null)} />
      ) : (
        <div>
          <button type="button" className={BUTTON} onClick={() => setEditing(draftOf(null))}>
            Add a forge profile
          </button>
        </div>
      )}
    </div>
  );
}

/** Every forge profile as TOML: copy it out, or paste one in and see what it changes before applying it. */
export function ForgeTransferSection() {
  const exported = useLoom("exportForgeProfiles", null);
  const importer = useLoomWrite("importForgeProfiles");
  const [toml, setToml] = useState("");
  const [preview, setPreview] = useState<{ toml: string; changes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const { busy, act } = useAction();
  const check = async () => {
    setError(null);
    try {
      setPreview({ toml, changes: (await importer({ toml, apply: false, confirm: true })).changes });
    } catch (failure) {
      setPreview(null);
      setError(messageOf(failure));
    }
  };
  const current = preview !== null && preview.toml === toml ? preview : null;
  return (
    <div data-section="forge-transfer" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON} onClick={() => setShown(!shown)} aria-expanded={shown}>
          {shown ? "Hide the TOML" : "Show the TOML"}
        </button>
        <span className="text-xs text-[var(--loom-muted)]">The same as <code className="rounded bg-surface-recessed px-1 font-mono">bb loom forge export</code>. Importing never removes a profile the TOML leaves out.</span>
      </div>
      {shown && <pre data-forge-toml className="max-h-96 overflow-auto rounded-md border border-border-seam p-2 font-mono text-xs">{exported.data?.toml || "# No forge profiles."}</pre>}
      <textarea aria-label="TOML to import" rows={8} className={`${FIELD} font-mono text-xs`} placeholder={'[[forge]]\nid = "forge"\nname = "Forge"\nopen = "…"\nstate = "…"'} value={toml} onChange={(event) => setToml(event.target.value)} />
      {error !== null && <p className="text-xs text-[var(--loom-bad)]">{error}</p>}
      {current !== null && (
        <div data-forge-import-preview className="text-sm">
          {current.changes.length === 0 ? <span className="text-[var(--loom-muted)]">This TOML matches the profiles Loom has.</span> : <ul className="list-disc pl-5">{current.changes.map((change) => <li key={change}>{change}</li>)}</ul>}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} disabled={toml.trim() === ""} onClick={() => void check()}>
          Preview changes
        </button>
        <button
          type="button"
          className={BUTTON_PRIMARY}
          disabled={busy || current === null || current.changes.length === 0}
          onClick={() => void act(async () => {
            await importer({ toml, apply: true, confirm: true });
            setToml("");
            setPreview(null);
          }, "Imported the forge profiles")}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
