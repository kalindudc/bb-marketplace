import { useEffect, useRef, useState, type ReactNode } from "react";
import { GLYPHS } from "./glyph-paths.ts";

// Errors carry a machine code such as "POLICY_BLOCKED: "; people read the sentence after it.
export const plainError = (text: string | null | undefined): string => (text ?? "").replace(/^(?:Forage: )?[A-Z][A-Z_]+: /u, "");
export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;
export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

// Kept pages are Markdown; quotes and previews read better without the markup.
export function plainText(text: string): string {
 return text
  .replace(/[\u200B-\u200D\uFEFF]/gu, "")
  .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
  .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
  .replace(/^\s*(?:[-*+]|\d+\.)\s+/gmu, "")
  .replace(/^\s*>\s?/gmu, "")
  .replace(/(\*\*|__)(.+?)\1/gu, "$2")
  .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/gu, "$1$2")
  .replace(/`([^`]+)`/gu, "$1")
  .replace(/\|/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();
}
const PROVIDERS: Record<string, string> = { duckduckgo: "DuckDuckGo", exa: "Exa", brave: "Brave", searxng: "SearXNG", tavily: "Tavily", jina: "Jina", firecrawl: "Firecrawl", direct: "Direct", local: "This machine" };
export const providerName = (id: string | null | undefined) => (id ? PROVIDERS[id] ?? id : "");

// Only web addresses become links; anything else from a page or a provider stays text.
export const safeHref = (url: string): string | undefined => (/^https?:\/\//iu.test(url) ? url : undefined);

export function hostOf(url: string): string {
 try { return new URL(url).host.replace(/^www\./u, ""); } catch { return url.split("/")[0] ?? url; }
}
export function pathOf(url: string): string {
 try { const u = new URL(url); return `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`; } catch { return ""; }
}
export function shortUrl(url: string): string { return `${hostOf(url)}${pathOf(url)}`; }

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export function when(ms: number, now = Date.now()): string {
 const date = new Date(ms);
 const today = new Date(now);
 const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
 if (sameDay(date, today)) return time;
 const yesterday = new Date(now - 86_400_000);
 if (sameDay(date, yesterday)) return `Yesterday ${time}`;
 if (now - ms < 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: "short" });
 return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}
export const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export function size(bytes: number): string {
 if (bytes < 1024) return `${bytes} B`;
 if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
 return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
export function duration(ms: number): string {
 const s = Math.round(ms / 1000);
 return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// React re-applies innerHTML whenever the __html object is new, and a click whose mousedown landed on a replaced <path>
// never fires, so each glyph keeps one object and never takes the pointer itself.
const GLYPH_HTML = new Map<string, { __html: string }>();
const glyphHtml = (name: string) => {
 let html = GLYPH_HTML.get(name);
 if (!html) GLYPH_HTML.set(name, html = { __html: GLYPHS[name] ?? GLYPHS.forage! });
 return html;
};
export function Glyph({ name, className = "size-3.5", label }: { name: string; className?: string; label?: string }) {
 return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={cx("pointer-events-none shrink-0", className)}
  {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })} dangerouslySetInnerHTML={glyphHtml(name)} />;
}

export function Spinner({ className = "size-3.5" }: { className?: string }) {
 return <Glyph name="loader" className={cx("animate-spin", className)} />;
}

export function Tile({ label, className }: { label: string; className?: string }) {
 const letter = label.replace(/^www\./u, "").trim().charAt(0).toUpperCase() || "•";
 return <span aria-hidden className={cx("inline-grid size-5 shrink-0 place-items-center rounded-[5px] bg-surface-recessed text-[10px] font-semibold text-muted-foreground", className)}>{letter}</span>;
}

type Tone = "neutral" | "good" | "bad" | "warn" | "info";
const TONES: Record<Tone, string> = {
 neutral: "bg-surface-recessed text-muted-foreground",
 good: "bg-success/15 text-success",
 bad: "bg-surface-destructive text-destructive-text",
 warn: "bg-warning/10 text-warning-text",
 info: "bg-surface-selected text-foreground",
};
export function Tag({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
 return <span title={title} className={cx("inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-medium", TONES[tone])}>{children}</span>;
}

const BUTTON = {
 default: "border-border bg-card text-foreground hover:bg-state-hover",
 primary: "border-primary bg-primary text-primary-foreground hover:opacity-90",
 ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-state-hover hover:text-foreground",
 danger: "border-border bg-card text-destructive-text hover:bg-surface-destructive",
};
export function Button({ variant = "default", icon, children, className, ...rest }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { variant?: keyof typeof BUTTON; icon?: string }) {
 return <button type="button" {...rest} className={cx("inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs disabled:cursor-default disabled:opacity-50", BUTTON[variant], className)}>
  {icon && <Glyph name={icon} />}{children}
 </button>;
}
export function IconButton({ icon, label, className, ...rest }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> & { icon: string; label: string }) {
 return <button type="button" aria-label={label} title={label} {...rest} className={cx("inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40", className)}><Glyph name={icon} /></button>;
}

export function Chip({ pressed, onClick, children, tone }: { pressed: boolean; onClick(): void; children: ReactNode; tone?: "warn" }) {
 return <button type="button" aria-pressed={pressed} onClick={onClick}
  className={cx("inline-flex h-6 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs", pressed ? "border-foreground/40 bg-surface-selected text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground", tone === "warn" && !pressed && "text-warning-text")}>{children}</button>;
}
export function Count({ n }: { n: number }) { return <span className="font-semibold text-foreground">{n.toLocaleString()}</span>; }

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ id: T; label: ReactNode }>; onChange(value: T): void; label: string }) {
 return <div role="tablist" aria-label={label} className="flex gap-0.5 rounded-lg bg-surface-recessed p-0.5">
  {options.map((option) => <button key={option.id} type="button" role="tab" aria-selected={value === option.id} onClick={() => onChange(option.id)}
   className={cx("inline-flex h-6 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs", value === option.id ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{option.label}</button>)}
 </div>;
}

export function Menu({ trigger, children, align = "end", width = "w-64" }: { trigger(props: { open: boolean; toggle(): void }): ReactNode; children(close: () => void): ReactNode; align?: "start" | "end"; width?: string }) {
 const [open, setOpen] = useState(false);
 const ref = useRef<HTMLDivElement>(null);
 useEffect(() => {
  if (!open) return;
  const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } };
  document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
  return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
 }, [open]);
 return <div ref={ref} className="relative inline-flex">
  {trigger({ open, toggle: () => setOpen((v) => !v) })}
  {open && <div role="menu" className={cx("absolute top-full z-30 mt-1 rounded-lg border border-border bg-card p-1 shadow-lg", align === "end" ? "right-0" : "left-0", width)}>{children(() => setOpen(false))}</div>}
 </div>;
}
export function MenuItem({ icon, label, detail, onSelect, danger, checked, disabled }: { icon?: string; label: string; detail?: string; onSelect(): void; danger?: boolean; checked?: boolean; disabled?: boolean }) {
 return <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}
  className={cx("grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover disabled:cursor-default disabled:opacity-50", danger ? "text-destructive-text" : "text-foreground")}>
  <span className="pt-px">{checked ? <Glyph name="check" /> : icon ? <Glyph name={icon} /> : null}</span>
  <span className="min-w-0"><span className="block">{label}</span>{detail && <span className="block text-[11px] text-muted-foreground">{detail}</span>}</span>
 </button>;
}

export function Notice({ tone = "neutral", icon, children, action }: { tone?: "neutral" | "good" | "warn" | "bad"; icon?: string; children: ReactNode; action?: ReactNode }) {
 const palette = { neutral: "bg-surface-recessed", good: "bg-success/15", warn: "bg-warning/10", bad: "bg-surface-destructive" }[tone];
 const iconTone = { neutral: "text-muted-foreground", good: "text-success", warn: "text-warning-text", bad: "text-destructive-text" }[tone];
 return <div role={tone === "bad" ? "alert" : undefined} className={cx("flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground", palette)}>
  {icon && <span className={iconTone}><Glyph name={icon} /></span>}<span className="min-w-0 flex-1">{children}</span>{action}
 </div>;
}

export function Bar({ value, max, running }: { value: number; max: number; running?: boolean }) {
 const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
 return <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-recessed" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
  <span className={cx("block h-full rounded-full", running ? "bg-primary" : "bg-success")} style={{ width: `${pct}%` }} />
 </span>;
}

export function ErrorLine({ error }: { error: { message: string } | null | undefined }) {
 return error ? <p role="alert" className="px-3 py-2 text-xs text-destructive-text">{plainError(error.message)}</p> : null;
}
export function Loading({ label = "Loading…" }: { label?: string }) {
 return <p role="status" className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground"><Spinner />{label}</p>;
}
