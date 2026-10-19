import { memo, type CSSProperties, type ReactNode } from "react";
import {
  Markdown, UrlLink, experimental_Diff as Diff, experimental_Icon as Icon,
} from "@get-bb/plugin-sdk/app";
import { formatDuration, previewLines, type LogEntry, type TurnStats } from "./entries";
import type { SessionLogSettings, TimeFormat } from "./settings";

export interface LogRowProps {
  entry: LogEntry;
  expanded: boolean;
  focused: boolean;
  query: string;
  turnStats: TurnStats | undefined;
  chatHref: string | null;
  settings: SessionLogSettings;
  onToggle(id: string): void;
  onFocusRow(id: string): void;
  onCopy(entry: LogEntry): void;
  onOpenThread(threadId: string): void;
  registerElement(id: string, element: HTMLElement | null): void;
}

export function highlight(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const parts: ReactNode[] = [];
  const lowercase = text.toLowerCase();
  let start = 0;
  let match = lowercase.indexOf(needle);
  while (match >= 0) {
    if (match > start) parts.push(text.slice(start, match));
    parts.push(<mark key={match} className="bg-surface-selected text-foreground">{text.slice(match, match + needle.length)}</mark>);
    start = match + needle.length;
    match = lowercase.indexOf(needle, start);
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

function badgeFor(entry: LogEntry): string | null {
  const { row, status } = entry;
  if (row.kind === "work" && row.workKind === "command" && row.exitCode !== null && row.exitCode !== 0) {
    return `✗ exit ${row.exitCode}`;
  }
  if (row.kind === "work" && row.workKind === "approval" && row.lifecycle === "denied") return "denied";
  if (entry.isError) return "✗";
  if (status === "pending") return "running";
  if (status === "interrupted") return "interrupted";
  // A thought's title already says how long it took.
  if (status === "completed" && entry.category !== "thinking") return "✓";
  return null;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function formatTime(timestamp: number, format: TimeFormat): string {
  return new Date(timestamp).toLocaleTimeString(undefined, format === "12h"
    ? { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }
    : { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

// Clamps by rendered lines, so a long paragraph counts as the lines it wraps to.
const clampLines = (lines: number): CSSProperties => ({
  display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden",
});

function PatchPreview({ text, query }: { text: string; query: string }) {
  return (
    <div className="font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
      {previewLines(text, 8, 0).text.split("\n").map((line, index) => (
        <div
          key={index}
          className={line.startsWith("+") ? "text-diff-added" : line.startsWith("-") ? "text-diff-removed" : ""}
        >
          {highlight(line, query)}
        </div>
      ))}
    </div>
  );
}

function RowBody({ entry, expanded, query, settings, onToggle }: {
  entry: LogEntry;
  expanded: boolean;
  query: string;
  settings: SessionLogSettings;
  onToggle(id: string): void;
}) {
  const { row, body } = entry;
  if (entry.bodyFormat === "diff") {
    if (!body) return null;
    return expanded && row.kind === "work" && row.workKind === "file-change"
      ? <Diff patch={body} path={row.change.path} className="min-w-0" />
      : <PatchPreview text={body} query={query} />;
  }
  if (entry.bodyFormat === "markdown") {
    if (!body) return null;
    const clip = row.kind === "conversation" && row.role === "user" && !expanded &&
      (body.length > 1_200 || body.split("\n").length > 12);
    return (
      <>
        <div className={clip ? "max-h-48 overflow-hidden" : ""}>
          <Markdown content={body} className="text-sm break-words" />
        </div>
        {clip && <button type="button" className="text-xs text-foreground hover:underline" onClick={() => onToggle(entry.id)}>Show more</button>}
      </>
    );
  }

  if (entry.category === "thinking" && !expanded) {
    if (!body || settings.thinkingLines === 0) return null;
    return (
      <pre className="text-xs whitespace-pre-wrap break-words text-muted-foreground" style={clampLines(settings.thinkingLines)}>
        {highlight(body, query)}
      </pre>
    );
  }
  const isToolOutput = row.kind === "work" && (row.workKind === "command" || row.workKind === "tool" || row.workKind === "delegation");
  const output = !expanded && isToolOutput
    ? previewLines(body, settings.outputHeadLines, settings.outputTailLines).text : body;
  const args = expanded && row.kind === "work" && row.workKind === "tool" && row.toolArgs !== null
    ? JSON.stringify(row.toolArgs, null, 2) : null;
  const fullCommand = expanded && row.kind === "work" && row.workKind === "command" && row.command.includes("\n")
    ? row.command : null;
  if (!output && !args && !fullCommand) return null;
  return (
    <div className="space-y-1">
      {fullCommand && <pre className="font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">{highlight(fullCommand, query)}</pre>}
      {args && <pre className="font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">{highlight(args, query)}</pre>}
      {output && (
        <pre className={`text-xs whitespace-pre-wrap break-words ${isToolOutput ? "font-mono" : ""} text-muted-foreground`}>
          {highlight(output, query)}
        </pre>
      )}
    </div>
  );
}

export const LogRow = memo(function LogRow({
  entry, expanded, focused, query, turnStats, chatHref, settings,
  onToggle, onFocusRow, onCopy, onOpenThread, registerElement,
}: LogRowProps) {
  const badge = badgeFor(entry);
  const time = formatTime(entry.startedAt, settings.timeFormat);
  const threadId = entry.divider?.linkThreadId;
  return (
    <div
      ref={(element) => registerElement(entry.id, element)}
      role="listitem"
      tabIndex={focused ? 0 : -1}
      data-entry-id={entry.id}
      onFocus={(event) => { if (event.target === event.currentTarget) onFocusRow(entry.id); }}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 48px" }}
      data-sl-tint={entry.tint ?? undefined}
      className={`min-w-0 border-b border-border-seam px-3 py-2 text-foreground ${
        entry.divider ? "bg-surface-recessed focus:bg-surface-selected"
          : entry.tint && settings.tintRows ? "sl-tinted" : "hover:bg-state-hover focus:bg-surface-selected"
      } ${entry.depth === 1 ? "ml-4 border-l border-border-seam pl-3" : ""}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <time className="shrink-0 font-mono text-xs text-subtle-foreground" dateTime={new Date(entry.startedAt).toISOString()}>{time}</time>
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-sm"
          onClick={() => onToggle(entry.id)}
        >
          <Icon name={entry.icon} className={`size-4 shrink-0 ${entry.tint ? "sl-tint-icon" : ""}`} aria-hidden />
          <span className={`min-w-0 break-words ${expanded ? "" : "line-clamp-2"}`}>{highlight(entry.title, query)}</span>
        </button>
        {badge && <span className={`shrink-0 text-xs ${entry.isError ? "text-destructive-text" : statusColor(entry.status)}`}>{badge}</span>}
        {entry.durationMs !== null && entry.category !== "thinking" && <span className="shrink-0 font-mono text-xs text-subtle-foreground">{formatDuration(entry.durationMs)}</span>}
        <button type="button" aria-label="Copy row" title="Copy row" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => onCopy(entry)}>
          <Icon name="Copy" className="size-4" aria-hidden />
        </button>
      </div>
      {entry.divider && (
        <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{new Date(entry.startedAt).toLocaleDateString()}</span>
          {turnStats && (
            <span>
              {plural(turnStats.workCount, "tool")} · {plural(turnStats.errorCount, "error")}
              {turnStats.durationMs !== null ? ` · ${formatDuration(turnStats.durationMs)}` : ""}
              {turnStats.running ? " · running" : ""}
            </span>
          )}
        </div>
      )}
      <div className="min-w-0 pl-2 pt-1">
        <RowBody entry={entry} expanded={expanded} query={query} settings={settings} onToggle={onToggle} />
        {(chatHref || threadId) && (
          <div className="mt-1 flex gap-3 text-xs">
            {chatHref && <UrlLink data-chat-link href={chatHref} className="text-muted-foreground hover:text-foreground hover:underline">Show in chat</UrlLink>}
            {threadId && <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => onOpenThread(threadId)}>Open thread</button>}
          </div>
        )}
      </div>
    </div>
  );
});

function statusColor(status: LogEntry["status"]): string {
  return status === "pending" ? "text-warning-text" : "text-success";
}
