import type { ComposerConfig } from "./config.ts";
import type { Ledger, LedgerResume } from "./types.ts";

const MAX_LISTED_FILES = 12;
const MAX_LISTED_COMMANDS = 10;

function bullet(lines: string[]): string {
  return lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- (none recorded)";
}

export function renderLedgerBlock(ledger: Ledger): string {
  const { state } = ledger;
  const constraints = ledger.constraints.length
    ? ledger.constraints.map((row) => `- ${row.text}`).join("\n")
    : "- (none recorded)";
  const filesRead = state.filesRead.slice(-MAX_LISTED_FILES).map((row) => row.path);
  const filesWritten = state.filesWritten.slice(-MAX_LISTED_FILES).map((row) => row.path);
  const commands = state.commands
    .slice(-MAX_LISTED_COMMANDS)
    .map((row) => `\`${row.cmd.replace(/\s+/g, " ").slice(0, 160)}\` → exit ${row.exit ?? "?"}`);
  const head = [state.branch, state.head].filter(Boolean).join(" @ ");
  return [
    "## Constraints (verbatim, still in force)",
    constraints,
    "",
    "## State (extracted, not summarised)",
    bullet([
      `goal: ${state.goal ?? "(not recorded)"}`,
      ...(head ? [`branch: ${head}`] : []),
      ...(filesWritten.length ? [`files written: ${filesWritten.join(", ")}`] : []),
      ...(filesRead.length ? [`files read: ${filesRead.join(", ")}`] : []),
      ...(state.failingTests.length ? [`failing tests: ${state.failingTests.join("; ")}`] : []),
      ...(state.openQuestions.length ? [`open questions: ${state.openQuestions.join(" | ")}`] : []),
    ]),
    ...(commands.length ? ["", "Commands run:", bullet(commands)] : []),
  ].join("\n");
}

export interface PromptInput {
  conversationText: string;
  previousSummary?: string;
  ledger: Ledger;
  customInstructions?: string;
  maxSummaryTokens: number;
  resumeContract: boolean;
}

export function buildSummaryPrompt(input: PromptInput): string {
  const { conversationText, previousSummary, ledger, customInstructions, maxSummaryTokens, resumeContract } = input;
  const parts: string[] = [
    "You are compacting a coding agent's conversation so it can continue without the transcript.",
    "",
    "Write ONLY these markdown sections, in this order:",
    "## Goal",
    "## Progress",
    "### Done",
    "### In Progress",
    "### Blocked",
    "## Key Decisions",
    "## Next Steps",
    "## Critical Context",
    "",
    "Hard rules:",
    "- Name file paths, commands, flags and identifiers exactly. Never paste code or file contents: they are on disk.",
    "- Keep unresolved things unresolved. If something was not verified, write \"unverified\". Never turn an open question into a conclusion.",
    "- Do not invent. If the transcript does not say it, omit it.",
    "- No preamble, no closing remark, no meta-commentary.",
    `- Budget: at most ${maxSummaryTokens} tokens.`,
  ];
  if (resumeContract) {
    parts.push(
      "",
      "Then one final block, exactly in this shape and nothing after it:",
      "RESUME:",
      "state: <one line: where the work stands right now>",
      "next: <one line: the single next action>",
      "verify: <one line: the command or check that proves it worked>",
    );
  }
  if (customInstructions?.trim()) {
    parts.push("", "Focus requested for this compaction:", customInstructions.trim());
  }
  parts.push("", "<constraints>", renderLedgerBlock(ledger), "</constraints>");
  if (previousSummary?.trim()) {
    parts.push(
      "",
      "<previous-summary>",
      "This is the summary the previous compaction produced. Fold it into the new one; do not repeat it verbatim.",
      previousSummary.trim(),
      "</previous-summary>",
    );
  }
  parts.push("", "<conversation>", conversationText, "</conversation>");
  return parts.join("\n");
}

export interface ParsedNarrative {
  narrative: string;
  resume: LedgerResume | null;
}

export function parseResume(text: string): ParsedNarrative {
  const marker = /^RESUME:\s*$/m.exec(text);
  if (!marker) return { narrative: text.trim(), resume: null };
  const head = text.slice(0, marker.index).trim();
  const tail = text.slice(marker.index + marker[0].length);
  const field = (name: string): string | null => {
    const match = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "im").exec(tail);
    return match?.[1]?.trim() ?? null;
  };
  const state = field("state");
  const next = field("next");
  const verify = field("verify");
  if (!state && !next && !verify) return { narrative: head, resume: null };
  return {
    narrative: head,
    resume: {
      state: state ?? "(not stated)",
      next: next ?? "(not stated)",
      verify: verify ?? "(not stated)",
    },
  };
}

export function synthesiseResume(ledger: Ledger): LedgerResume {
  const { state } = ledger;
  const failing = state.failingTests[0];
  return {
    state: state.goal ?? "work in progress",
    next: state.nextSteps[0] ?? "continue the current task",
    verify: failing ? `run the failing test: ${failing}` : "run the project's tests",
  };
}

export interface AssembleInput {
  narrative: string;
  resume: LedgerResume | null;
  ledger: Ledger;
  config: ComposerConfig;
  threadId?: string | null;
  tokensBefore: number;
}

export function assembleSummary(input: AssembleInput): string {
  const { narrative, ledger, config, threadId, tokensBefore } = input;
  const resume = input.resume ?? synthesiseResume(ledger);
  const header = [
    "# Pressed context",
    "",
    `Compacted at ${tokensBefore.toLocaleString()} tokens${threadId ? ` in ${threadId}` : ""}. ` +
      "The blocks below are extracted mechanically; the working summary is written by a model.",
  ].join("\n");
  const parts = [header];
  if (config.ledger) parts.push("", renderLedgerBlock(ledger));
  parts.push("", "## Working summary", narrative.trim() || "(the summariser returned nothing)");
  if (config.resumeContract) {
    parts.push("", "## Resume", `state: ${resume.state}`, `next: ${resume.next}`, `verify: ${resume.verify}`);
  }
  return parts.join("\n");
}

/** Keep the newest part of a conversation that would not fit the summariser's window. */
export function truncateConversation(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; droppedChars: number } {
  if (text.length <= maxChars) return { text, truncated: false, droppedChars: 0 };
  const keep = text.slice(text.length - maxChars);
  const firstBreak = keep.indexOf("\n[");
  const body = firstBreak > 0 ? keep.slice(firstBreak + 1) : keep;
  return {
    text: `[earlier messages omitted: ${text.length - body.length} characters]\n${body}`,
    truncated: true,
    droppedChars: text.length - body.length,
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
