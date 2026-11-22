import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { rpcContract } from "../../shared/contract";
import { questNamesSchema, type BoardQuest } from "../../shared/schema";
import { ExpandsMark } from "../kit";

export function QuestRename({ quest }: { quest: Pick<BoardQuest, "id" | "title" | "short"> }) {
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "renameBoardQuest" });
  const opener = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const short = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => { if (open) title.current?.focus(); }, [open]);
  const close = () => {
    setOpen(false);
    setInvalid([]);
    setError(null);
    opener.current?.focus();
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    setError(null);
    const form = new FormData(event.currentTarget);
    const names = questNamesSchema.safeParse({ title: form.get("title"), short: form.get("short") });
    if (!names.success) {
      const fields = names.error.issues.map(issue => String(issue.path[0]));
      setInvalid(fields);
      (fields.includes("title") ? title : short).current?.focus();
      return;
    }
    try {
      await mutation.mutate({ id: quest.id, ...names.data });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const field = (name: "title" | "short", label: string, limit: string, ref: typeof title) => {
    const fieldId = `${id}-${name}`;
    const bad = invalid.includes(name);
    return <div className="tv-rename-field">
      <label htmlFor={fieldId}>{label}</label>
      <input ref={ref} className="tv-text" id={fieldId} name={name} defaultValue={quest[name]} required
        readOnly={mutation.isPending} aria-invalid={bad || undefined} aria-describedby={`${fieldId}-help`}
        onChange={() => { setInvalid(fields => fields.filter(field => field !== name)); setError(null); }} />
      <span id={`${fieldId}-help`} className={bad ? "tv-rename-error" : "m"} role={bad ? "alert" : undefined}>
        {bad ? `Enter a ${label.toLowerCase()} of ${limit} characters.` : `${limit} characters.`}
      </span>
    </div>;
  };
  return <section className="tv-card tv-rename" aria-label="Quest name">
    <button className="btn ghost" type="button" ref={opener} aria-expanded={open} aria-controls={id} aria-disabled={mutation.isPending || undefined}
      onClick={() => { if (!mutation.isPending) open ? close() : setOpen(true); }}>
      <ExpandsMark open={open} />Rename quest
    </button>
    <div id={id} hidden={!open}>
      {open && <form className="tv-rename-form" noValidate onSubmit={event => void save(event)} onKeyDown={event => {
        if (event.key === "Escape" && !mutation.isPending) { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
        {field("title", "Title", "1–200", title)}
        {field("short", "Short name", "1–40", short)}
        {error && <p className="tv-rename-error" role="alert">{error}</p>}
        <div className="tv-rename-actions">
          <button className="btn pri" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save name"}</button>
          <button className="btn ghost" type="button" disabled={mutation.isPending} onClick={close}>Cancel</button>
        </div>
      </form>}
    </div>
  </section>;
}
