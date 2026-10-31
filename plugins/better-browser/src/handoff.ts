import { IDLE, WAIT_LIMIT_MS, step, type Effect, type Episode, type SignInEvent, type SignInMode } from "./signin";

export const HANDOFF_SESSION_LIMIT = 256;
export const HANDOFF_SESSION_TTL_MS = WAIT_LIMIT_MS * 2;

export interface HandoffInput {
  threadId: string;
  tabId: string;
  mode: SignInMode;
  event: SignInEvent;
  targetUrl: string | null;
  /**
   * True on an access gateway's page, false on a sign-in page, and left out elsewhere, where the handoff keeps the kind
   * it had: the application a retry passes through belongs to the same handoff.
   */
  gateway?: boolean;
  /** With a `start` event on a gateway: the application the toolbar's button named, the only page it may open. */
  consentUrl?: string;
}

interface HandoffResult {
  episode: Episode;
  effects: Effect[];
  targetUrl: string | null;
  /** Whether this handoff is an access gateway's. */
  gateway: boolean;
  /** The application the user approved opening, kept until the handoff ends or the user stops it. */
  consentUrl: string | null;
}

// Sync helper tabs can unmount the toolbar, so progress belongs to the owning tab rather than a React instance.
export function createHandoffSessions(now: () => number) {
  const sessions = new Map<string, { episode: Episode; targetUrl: string | null; gateway: boolean; consentUrl: string | null; touchedAt: number }>();
  return {
    advance(input: HandoffInput): HandoffResult {
      const at = now();
      for (const [key, session] of sessions) {
        if (at - session.touchedAt >= HANDOFF_SESSION_TTL_MS) sessions.delete(key);
      }
      const key = JSON.stringify([input.threadId, input.tabId]);
      const previous = sessions.get(key);
      const gateway = input.gateway ?? previous?.gateway ?? false;
      // A sign-in that lands on a gateway (or the reverse) is a new handoff: the earlier one may already have opened
      // the real browser, which would keep this one from opening at all.
      const episode = previous && previous.gateway === gateway ? previous.episode : IDLE;
      const result = step(episode, input.event, input.mode, gateway);
      const targetUrl = input.targetUrl ?? previous?.targetUrl ?? null;
      // Consent covers the page the button named when it was pressed, so a page that later steers the tab to another
      // gateway cannot change what opens.
      let consentUrl = episode === previous?.episode ? previous.consentUrl : null;
      if (input.event.type === "start") consentUrl = gateway ? input.consentUrl ?? null : null;
      if (!result.episode.consented) consentUrl = null;
      if (result.episode.phase.kind === "idle" && targetUrl === null) {
        sessions.delete(key);
      } else {
        if (!previous && sessions.size >= HANDOFF_SESSION_LIMIT) throw new Error("Too many active sign-in handoffs");
        sessions.set(key, { episode: result.episode, targetUrl, gateway, consentUrl, touchedAt: at });
      }
      return { ...result, targetUrl, gateway, consentUrl };
    },
    clear() {
      sessions.clear();
    },
  };
}
