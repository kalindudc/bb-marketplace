import { useEffect, useId, useRef, useState } from "react";

export interface NameEditorProps {
  initial?: string;
  placeholder?: string;
  action: "create" | "save";
  onSubmit(name: string): Promise<unknown>;
  onCancel(): void;
}

const failure = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : "Switchboard could not save that name";

export function NameEditor({ initial = "", placeholder, action, onSubmit, onCancel }: NameEditorProps) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const settled = useRef(false);
  const mounted = useRef(true);
  const errorId = useId();
  useEffect(() => {
    mounted.current = true;
    // A microtask lets a closing menu finish moving focus before the field takes it.
    queueMicrotask(() => {
      if (!mounted.current) return;
      input.current?.focus();
      input.current?.select();
    });
    return () => { mounted.current = false; };
  }, []);
  const cancel = () => {
    if (settled.current || pending) return;
    settled.current = true;
    onCancel();
  };
  const submit = (fromBlur: boolean) => {
    if (settled.current || pending) return;
    const name = value.trim();
    // Leaving the field after an error, without editing, gives up rather than retrying the same name.
    if (!name || name === initial.trim() || (fromBlur && error)) { cancel(); return; }
    setPending(true);
    setError(null);
    onSubmit(name).then(() => { settled.current = true; }, (cause: unknown) => {
      if (!mounted.current) return;
      setPending(false);
      setError(failure(cause));
    });
  };
  const busy = action === "create" ? "Creating…" : "Saving…";
  return <span className="sb-name-editor flex min-w-0 flex-1 items-center gap-2" aria-busy={pending}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <input ref={input} aria-label="Section name" value={value} placeholder={placeholder} maxLength={100}
      autoCapitalize="sentences" autoCorrect="off" spellCheck={false} readOnly={pending}
      aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
      className="sb-name-input min-w-0 flex-1"
      onChange={(event) => { setValue(event.target.value); setError(null); }}
      onBlur={() => submit(true)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          if (!event.nativeEvent.isComposing && !composing.current) submit(false);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }} />
    <span aria-hidden className="sb-name-hint shrink-0 font-mono text-[10px] text-subtle-foreground">
      {pending ? busy : `↵ ${action}`}</span>
    {pending && <span role="status" className="sr-only">{busy}</span>}
    {error && <span id={errorId} role="alert"
      className="sb-name-error rounded-md border border-border bg-popover px-2 py-1 text-xs text-destructive shadow-md">{error}</span>}
  </span>;
}
