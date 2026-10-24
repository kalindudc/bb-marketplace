import { useRef } from "react";
import { FIELD } from "../common";

/** A prompt template: chips insert a variable at the caret. */
export function PromptEditor({ label, value, variables, onChange, rows = 5 }: {
  label: string;
  value: string;
  variables: readonly string[];
  onChange(next: string): void;
  rows?: number;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (name: string) => {
    const token = `{${name}}`;
    const node = area.current;
    const start = node?.selectionStart ?? value.length;
    const end = node?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="min-w-0">
      <textarea ref={area} aria-label={label} rows={rows} value={value} onChange={(event) => onChange(event.target.value)}
        className={`${FIELD} w-full resize-y font-mono text-xs leading-relaxed`} />
      <div className="mt-1.5 flex flex-wrap gap-1">
        {variables.map((name) => (
          <button key={name} type="button" title={`Insert {${name}}`} onClick={() => insert(name)}
            className="cursor-pointer rounded border border-border px-1.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
            {`{${name}}`}
          </button>
        ))}
      </div>
    </div>
  );
}
