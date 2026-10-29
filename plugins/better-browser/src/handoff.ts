import { IDLE, WAIT_LIMIT_MS, step, type Effect, type Episode, type SignInEvent, type SignInMode } from "./signin";

export const HANDOFF_SESSION_LIMIT = 256;
export const HANDOFF_SESSION_TTL_MS = WAIT_LIMIT_MS * 2;

export interface HandoffInput {
  threadId: string;
  tabId: string;
  mode: SignInMode;
  event: SignInEvent;
  targetUrl: string | null;
}

interface HandoffResult {
  episode: Episode;
  effects: Effect[];
  targetUrl: string | null;
}

// Sync helper tabs can unmount the toolbar, so progress belongs to the owning tab rather than a React instance.
export function createHandoffSessions(now: () => number) {
  const sessions = new Map<string, { episode: Episode; targetUrl: string | null; touchedAt: number }>();
  return {
    advance(input: HandoffInput): HandoffResult {
      const at = now();
      for (const [key, session] of sessions) {
        if (at - session.touchedAt >= HANDOFF_SESSION_TTL_MS) sessions.delete(key);
      }
      const key = JSON.stringify([input.threadId, input.tabId]);
      const previous = sessions.get(key);
      const result = step(previous?.episode ?? IDLE, input.event, input.mode);
      const targetUrl = input.targetUrl ?? previous?.targetUrl ?? null;
      if (result.episode.phase.kind === "idle" && targetUrl === null) {
        sessions.delete(key);
      } else {
        if (!previous && sessions.size >= HANDOFF_SESSION_LIMIT) throw new Error("Too many active sign-in handoffs");
        sessions.set(key, { episode: result.episode, targetUrl, touchedAt: at });
      }
      return { ...result, targetUrl };
    },
    clear() {
      sessions.clear();
    },
  };
}
