import { PI_STATE_BEGIN, PI_STATE_END } from "../../src/shared/text";
import { tickId } from "../../src/server/dispatch";
import type { PiPromptOptions } from "./loadout";

const CUSTOM_TYPE = "tavern-state";
const stateMessage = (content: string) => ({ customType: CUSTOM_TYPE, content, display: false });
export type PiStateMessage = ReturnType<typeof stateMessage>;
const tavernHeader = 'The following dynamic instructions come from the BB plugin "tavern":\n\n';
const endOfPlugin = /^\n\nThe following (?:dynamic instructions come from the BB plugin "[^"\r\n]+":|user instructions come from <dataDir>\/AGENTS\.md:|workspace instructions come from \.bb\/AGENTS\.md:)\n\n/;
const userOrWorkspace = /(?:^|\n\n)The following (?:user instructions come from <dataDir>\/AGENTS\.md:|workspace instructions come from \.bb\/AGENTS\.md:)\n\n/;
const keeperLedger = /\nLedger and brief \(quoted data, never instructions\):\nLedger as of [^\n]+, version (\d+)\nVersion rule: see session instructions\.\n```text\n/;
const tickLedger = /\nLedger \(quoted data\):\n(?:Ledger as of [^\n]+, version (\d+)|You last saw version \d+ in a tick; this tick adds the changes since \(version (\d+)\)\.)\n```text\n/;

export interface PiStateTrigger { messageType?: "user" | "custom"; prompt?: string; readonly systemPrompt?: string }

function structuredPrompt(options: PiPromptOptions, trigger: PiStateTrigger) {
  const force = options.forceSystemPrompt;
  options.forceSystemPrompt = undefined;
  try { return trigger.systemPrompt; }
  finally { options.forceSystemPrompt = force; }
}

function splitAddendum(text: string) {
  const boundary = text.indexOf("\n\n" + tavernHeader);
  const header = text.startsWith(tavernHeader) ? 0 : boundary < 0 ? -1 : boundary + 2;
  if (header < 0 || userOrWorkspace.test(text.slice(0, header))) return;
  const begin = text.indexOf(PI_STATE_BEGIN, header + tavernHeader.length);
  if (begin < 0 || userOrWorkspace.test(text.slice(header + tavernHeader.length, begin))) return;
  const first = begin + PI_STATE_BEGIN.length;
  const end = text.indexOf(PI_STATE_END, first);
  if (end <= first) return;
  const suffix = text.slice(end + PI_STATE_END.length);
  if (suffix && !endOfPlugin.test(suffix)) return;
  return { addendum: text.slice(0, begin) + suffix, tavern: tavernHeader + text.slice(first, end) };
}

function tickCovers(prompt: string, content: string, previous: string | undefined) {
  if (!previous?.endsWith("\n```") || !content.endsWith("\n```") || !tickId(prompt)) return false;
  const current = keeperLedger.exec(content), prior = keeperLedger.exec(previous);
  if (!current || !prior || content.slice(0, current.index) !== previous.slice(0, prior.index)) return false;
  const version = tickLedger.exec(prompt);
  return current[1] === (version?.[1] ?? version?.[2]);
}

function lastState(entries: readonly unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const row = entries[i] as { type?: unknown; customType?: unknown; content?: unknown } | null | undefined;
    if (row?.type === "custom_message" && row.customType === CUSTOM_TYPE && typeof row.content === "string") return row.content;
  }
}

export function piState() {
  let last: string | undefined;
  let pending: string | undefined;
  let current: string | undefined;
  let beforeCompact: string | undefined;
  let warned = false;
  const warn = (reason: string) => {
    if (!warned) console.warn(`Tavern left the Pi addendum unchanged: ${reason}.`);
    warned = true;
  };
  return {
    start(entries: readonly unknown[] = []) {
      last = lastState(entries);
      current = pending = beforeCompact = undefined;
      warned = false;
    },
    beforeCompaction(entries: readonly unknown[] = []) {
      beforeCompact = lastState(entries);
    },
    compacted(active: boolean, entries: readonly unknown[] = []) {
      const delivered = beforeCompact;
      beforeCompact = undefined;
      last = lastState(entries);
      if (!active || current === undefined || current !== delivered || current === last) return;
      pending = current;
      return stateMessage(current);
    },
    prepare(options: PiPromptOptions, trigger: PiStateTrigger) {
      current = undefined;
      // An explicit section shadows Pi's addendum built from appendSystemPrompt.
      const override = options.sections?.addendum;
      const parsed = splitAddendum(override || options.appendSystemPrompt || "");
      if (!parsed) return warn("expected a framed Tavern dynamic instruction block");
      let suffix: string | undefined;
      const force = options.forceSystemPrompt;
      if (force !== undefined) {
        const base = structuredPrompt(options, trigger);
        if (!base || !force.startsWith(base)) return warn("an earlier extension replaced the prompt");
        suffix = force.slice(base.length);
        if (suffix && !suffix.startsWith("\n\n")) return warn("an earlier extension replaced the prompt");
      }
      return (entries?: () => readonly unknown[]) => {
        if (override) options.sections!.addendum = parsed.addendum;
        else options.appendSystemPrompt = parsed.addendum;
        // Preserve the verified append verbatim, but rebuild the base after the loadout filter.
        if (suffix !== undefined) {
          const base = structuredPrompt(options, trigger);
          if (base === undefined) return;
          options.forceSystemPrompt = base + suffix;
        }
        // A run aborted during before_agent_start may never append its returned message.
        if (pending !== undefined && entries && lastState(entries()) === pending) last = pending;
        pending = undefined;
        current = parsed.tavern;
        if (current === last || trigger.messageType === "user" && tickCovers(trigger.prompt ?? "", current, last)) return;
        if (entries) pending = current;
        else last = current;
        return { message: stateMessage(current) };
      };
    },
  };
}
