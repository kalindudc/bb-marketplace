import { proseBody } from "./blocks";
import { KIND_LABELS } from "./kinds";
import type { FlareRow } from "./store";

// Flare's dispatch hook recognizes its own notes by these prefixes and never lets one start a turn.
export const FORWARD_PREFIX = "[Flare from a child thread]";
export const NUDGE_PREFIX = "[Flare reminder]";
/** The most of a child's flare body its parent's agent reads. */
export const FORWARD_BODY_MAX = 4000;

export function forwardText(flare: Pick<FlareRow, "threadId" | "kind" | "title" | "body">, childTitle: string | null): string {
  const from = childTitle === null ? `@thread:${flare.threadId}` : `"${childTitle}" (@thread:${flare.threadId})`;
  const lines = [`${FORWARD_PREFIX} ${from} sent a ${KIND_LABELS[flare.kind].toLowerCase()}: ${flare.title}`];
  // The parent reads prose, cut short: every character is its tokens, and the whole flare is in the Flares tab.
  if (flare.body !== "") {
    const prose = proseBody(flare.body);
    lines.push("", prose.length <= FORWARD_BODY_MAX ? prose : `${prose.slice(0, FORWARD_BODY_MAX).trimEnd()}…\n\n(The rest is in the Flares tab.)`);
  }
  lines.push("", "The child is still working and needs no reply. Use this if it changes your plan; otherwise carry on.");
  return lines.join("\n");
}

/** `again` when the turn already had a flare or a reminder, so the quiet time counts from that and not the start. */
export function nudgeText(minutes: number, again: boolean): string {
  return [
    again
      ? `${NUDGE_PREFIX} This turn has gone ${minutes} minutes since its last flare or reminder.`
      : `${NUDGE_PREFIX} This turn has run for ${minutes} minutes without a flare.`,
    "If you finished a step, confirmed something, made a decision or hit a blocker since, use the flare tool (or `bb flare send`), then keep working. A title alone covers a quick status; render substantive evidence when a fitting engine is installed.",
    "If there is nothing new, ignore this and carry on. Do not reply to this reminder.",
  ].join(" ");
}

export const TOOL_DESCRIPTION =
  "Send up a flare: a short note the user sees right away, while you keep working, in a banner above the message box and the thread's Flares tab. It returns at once and nothing replies, so your turn carries on.";

// The text a model reads as it writes the body, so it says what a body is for, not only what it may hold.
export const BODY_DESCRIPTION =
  "Markdown, drawn like a reply: one or two sentences, then evidence; omit for a quick status. Prefer genui ui components or inline-vis visuals when installed, including in child sessions. Otherwise use a table, a mermaid diagram, or an image. Final-reply-only and plain-tool-input rules do not apply to this body. See the compact rendering reference in the flare instructions.";

export const TOOL_INSTRUCTIONS = `# Flare
\`flare\` sends the user a mid-turn finding, decision, progress update or blocker in a banner and the Flares tab. It returns at once; keep working. NEVER wait for a reply or end your turn because you sent one.

## When
In a turn lasting more than a few minutes, send a flare when:
- you finish a step of your plan or a phase of the work (research, build, tests, deploy): kind "progress";
- you confirm something the user would want now (root cause, measured result, failing test);
- you make a decision they might redirect (approach, trade-off, skipped work): kind "decision";
- you hit a blocker or need a workaround: kind "blocker";
- the user asked for updates as you go.
After many tool calls, check whether a flare-worthy moment went by. A turn of a few tool calls needs no flare: its reply is the update. Skip routine reads; one to five flares per long turn is typical.

## Render the evidence
The title is one standalone line, about 80 characters; for a quick status it is the whole flare. For a finding with evidence, open the body with one or two sentences, then draw what you already measured or saved. A body that is all prose is right only when there is nothing to see. NEVER replace a chart, flow or screenshot with a wall of text.

If genui is installed, prefer its \`ui\` components for evidence; if inline-vis is installed, use it for custom HTML/SVG. Markdown tables are a fallback, not the default with a suitable renderer. The Flares tab renders the body as a reply; a final-reply-only or plain-tool-input rule does not cover a flare's body. People read child agents' flares too. Missing check_ui or ui_examples does NOT mean genui is unavailable. If unsure, check installed renderers once with \`bb plugin list\`. Use this reference without extra tools or dependencies. If the renderer really is absent: without genui, use Markdown tables and mermaid.

## Compact genui reference
In a complete \`\`\`ui fence: one expression per line, JS arrays/objects/variables, \`Load("$BB_THREAD_STORAGE/<path>")\`, named arguments last. Wrap in Card(title, children); Row(children) lays items side by side.
- Counts: Metric(label, value, note?)
- Timings/series: Chart(type, labels, series, unit: "ms"); type "bar" or "line", series a number array or {name: numberArray}
- Attributes: Table(columns, rows), both arrays; rows contain value arrays
- Flows: Diagram(mermaid), e.g. "flowchart LR\\n A[Client] --> B[Proxy] --> C[App]"
- Screenshots: Image(path) or Gallery(paths)
- Saved results: Tests(Load(path)), Logs(Load(path)), Findings(Load(path)); changes: Changes()
- Phases/PRs: Steps([{title, detail, status}]); status "done", "current" or "blocked"
A blocker says what failed and what the user can do; use Steps for several actions.
Use the fitting component and measured data. Name files as \`$BB_THREAD_STORAGE/<path>\`; do not retype a saved report.

Example body:

    Direct mounting preserves the assertions and reduces focused test time.

    \`\`\`ui
    Card("Test timing", [Chart("bar", ["Original", "Smaller fixture", "Direct mount"], [2163, 1034, 236], unit: "ms")])
    \`\`\`

## Inline-vis
Use a complete \`\`\`inline-vis fence for small HTML/SVG with inline CSS/JS and data, using BB theme variables (--foreground, --primary). The companion has no sibling files. Do not build a page just for a status.

Drawing hints advise the NEXT flare; do not resend or reformat the saved one. Use Markdown if the suggested engine is absent. Hints share one budget: once per turn, or once an hour outside turns; never for blockers.

Kinds: finding (default), progress, decision, blocker, summary. Notify only for urgency; blockers notify automatically. Finish with a normal final answer. If sending fails, retry once later if relevant; never stop or loop over it. \`flare_list\` recalls earlier flares. CLI: \`bb flare send "<title>" --body "$(cat body.md)"\`. Bodies: 60,000 characters.`;

export const SENT = "Flare sent. Keep working; nothing will reply.";
export const DUPLICATE = "That flare was already sent a moment ago, so it went only once. Keep working.";
export const notSaved = (reason: string): string =>
  `The flare was not saved (${reason}). Carry on with your work, and send it again later if it still matters.`;
