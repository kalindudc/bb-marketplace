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
    "If you finished a step, confirmed something, made a decision or hit a blocker since, send a flare with the flare tool (or `bb flare send`); a title alone is enough. Then keep working.",
    "If there is nothing new, ignore this and carry on. Do not reply to this reminder.",
  ].join(" ");
}

export const TOOL_DESCRIPTION =
  "Send up a flare: a short note the user sees right away, while you keep working, in a banner above the message box and the thread's Flares tab. It returns at once and nothing replies, so your turn carries on.";

// The text a model reads as it writes the body, so it says what a body is for, not only what it may hold.
export const BODY_DESCRIPTION =
  "Markdown, drawn like a reply in the Flares tab; leave it out for a quick status. Otherwise one or two sentences, then the evidence as a block (a table, a mermaid diagram, an image, a genui ui view, an inline-vis page, or a saved file loaded into a view). Rules that keep blocks to your final message do not apply here.";

export const TOOL_INSTRUCTIONS = `# Flare
\`flare\` posts a short note the user sees while you keep working: a banner above the message box, the thread's Flares tab and, for blockers, a push notification. It is fire and forget: it returns at once, nothing replies, and your turn carries on. Never wait for an answer and never end your turn because you sent one.

In a turn that runs more than a few minutes, send a flare at each of these moments:
- you finish a step of your plan or a phase of the work, such as research, a build, a test run or a deploy (kind "progress");
- you confirm something the user would want to know now, such as a root cause, a number or a failing test;
- you make a decision they might want to redirect, such as an approach, a trade-off or a part you skipped (kind "decision");
- you are blocked or working around something, such as missing access or a failing service (kind "blocker");
- the user asked for updates as you go.

When many tool calls have passed since your last flare, ask yourself whether one of these moments went by. A turn of a few tool calls needs no flare: its reply is the update. Do not flare routine steps such as reading a file. One to five flares in a long turn is typical.

## Show the evidence, don't describe it
The title is one line that stands on its own, about 80 characters; for a quick status it is the whole flare. Anything more gets a body that opens with one or two sentences, because the banner and notifications show only its prose, then draws the evidence as a block. Draw what you already have, such as numbers you just read, a flow you just traced or a file you saved.

The Flares tab renders the body as a reply of its own, so every block a reply can hold is drawn there: Markdown tables, mermaid diagrams and images always, plus the blocks and directives of installed rendering plugins, such as genui's \`ui\` views and inline-vis pages. A rule that only the message ending your turn may hold a block, or that tool input stays plain text, does not cover a flare's body.

Pick the block the evidence calls for. The views named here are genui's \`ui\` ones; without genui, use Markdown tables and mermaid.
- key numbers: a Metric row; a series: a Chart
- A versus B, before and after, or items with several attributes: a Table
- a flow, an architecture or the branches of a decision: a mermaid diagram
- PRs, commits or phases: Status, Steps or a Table with their state
- a file you saved (JSON, CSV, a log, a test report): \`Load("$BB_THREAD_STORAGE/<path>")\` into its view instead of retyping it
- screenshots: Image or Gallery of their paths
- a blocker: what fails and what the user can do; Steps when there are several

A body that is all prose is right only when there is nothing to see. Never write paragraphs or paragraph-long bullets with bold labels. Wrap a \`ui\` block in one Card. An example body:

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
