// Matches a user message in the timeline to the route the Keeper recorded for it. The server stores the key when the
// message is dispatched; the UI computes it from the rendered message's text. Same text twice matches in order.
export function messageKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200).toLowerCase();
}

/** Agent-only notes Tavern sends start with this, so its dispatch hook can recognise them. */
export const TICK_PREFIX = "[Tavern tick]";
export const JOURNAL_NOTE_PREFIX = "[Journal]";
// added by Builder B: declining an exception is not a new standing prohibition.
export const SCOPE_DENIAL_TEXT = "No widening granted. The existing scope is unchanged; this does not forbid commands already allowed by it.";
