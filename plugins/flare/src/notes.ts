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
    "If you have a finding, a decision or a blocker the user should see now, send it with the flare tool (or `bb flare send`), then keep working.",
    "If there is nothing new, ignore this and carry on. Do not reply to this reminder.",
  ].join(" ");
}

export const TOOL_DESCRIPTION =
  "Send up a flare: a short note the user sees right away, while you keep working, in a banner above the message box and the thread's Flares tab. It returns at once and nothing replies, so your turn carries on.";

// The text a model reads as it writes the body, so it says what a body is for, not only what it may hold.
export const BODY_DESCRIPTION =
  "Markdown, drawn like a reply in the Flares tab: one or two sentences, then the evidence as a block (a ui view, a mermaid diagram, a table, an image, or a saved file loaded into a view). Rules that keep blocks to your final message do not apply here.";

export const TOOL_INSTRUCTIONS = `# Flare
\`flare\` posts a short note the user sees while you keep working: a banner above the message box, the thread's Flares tab and, for blockers, a push notification. It is fire and forget: it returns at once, nothing replies, and your turn carries on. Never wait for an answer and never end your turn because you sent one.

Send a flare when:
- the user asked for updates, findings or a summary as you go, or the task will take more than a few minutes;
- you confirmed something the user would want to know now, such as a root cause, a number or a failing test;
- you made a decision they might want to redirect, such as an approach, a trade-off or a part you skipped;
- you are blocked or working around something, such as missing access or a failing service (kind "blocker");
- you finished a phase of a long task (kind "progress", or "summary" for a wrap-up).

Send one flare per real event; one to five in a long turn is typical. Do not flare routine steps such as reading a file.

## Show the evidence, don't describe it
The user glances at a flare, so draw what you found. The title is one line that stands on its own, about 80 characters. The body opens with one or two sentences, because the banner and notifications show only its prose, then shows the evidence as a block.

The Flares tab renders the body as a reply of its own, so every block a reply can hold is drawn there: \`ui\` views, mermaid diagrams, Markdown tables, images, inline-vis pages and plugin directives. A rule that only the message ending your turn may hold a block, or that tool input stays plain text, does not cover a flare's body.

Pick the block the evidence calls for. The views named here are genui's \`ui\` ones; without genui, use Markdown tables and mermaid.
- key numbers: a Metric row; a series: a Chart
- A versus B, before and after, or items with several attributes: a Table
- a flow, an architecture or the branches of a decision: a mermaid diagram
- PRs, commits or phases: Status, Steps or a Table with their state
- a file you saved (JSON, CSV, a log, a test report): \`Load("$BB_THREAD_STORAGE/<path>")\` into its view instead of retyping it
- screenshots: Image or Gallery of their paths
- a blocker: what fails and what the user can do; Steps when there are several

Prose alone is right only when there is nothing to see, such as a one-line status. Never write paragraph-long bullets with bold labels. Wrap a \`ui\` block in one Card. An example body:

    requeue() passes only the job id, so 312 of 2,040 retried jobs ran with no payload.

    \`\`\`ui
    Card("Retries since Monday", [Row([Metric("Retried", "2,040"), Metric("Ran empty", "312", tone: "bad")]), Snippet("src/worker/queue.ts", 80, 95)])
    \`\`\`

When "Flare sent" comes back with a hint about drawing, follow it in your next flare. Name a file in your thread storage as \`$BB_THREAD_STORAGE/<path>\`. The body is cut at 60,000 characters.

Kinds: finding (the default), progress, decision, blocker, summary. Set notify to true only for something the user must see now; blockers notify on their own.

A flare does not replace your final answer. End the turn with your full answer as usual; you may point to earlier flares there instead of repeating them.

If the result says the flare was not sent, carry on with your work and send it again later, once, if it still matters. Never stop or loop over it. \`flare_list\` reads the flares already sent in this thread, for example after your context was compacted. Without the tool, \`bb flare send "<title>" --kind <kind> --body "$(cat body.md)"\` does the same.`;

export const SENT = "Flare sent. Keep working; nothing will reply.";
export const DUPLICATE = "That flare was already sent a moment ago, so it went only once. Keep working.";
export const notSaved = (reason: string): string =>
  `The flare was not saved (${reason}). Carry on with your work, and send it again later if it still matters.`;
