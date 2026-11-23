import { experimental_useRpcMutation, useComposer } from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { rpcContract } from "../contract";
import { FEEDBACK_MS } from "./live";
import { isCompactDraft, isCompactSubmitKey } from "./manual-command";

// bb markup, used only to tell which element an event came from; whether Enter would send comes from the composer API.
const ROOT = "[data-follow-up-composer]";
const EDITOR = '[contenteditable="true"][role="textbox"][enterkeyhint="send"]';
const SEND = "button[data-promptbox-submit-action]";

export function PressManualCommand() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; threadId: string } | null>(null);
  const busy = useRef(false);
  const { mutate } = experimental_useRpcMutation({ contract: rpcContract, method: "compactNow" });

  // A result describes the moment it was given: clear it after a while, or once the person types something else.
  useEffect(() => {
    if (feedback === null) return;
    const timer = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [feedback]);
  const typingElse = composer.draft.text.trim() !== "" && !isCompactDraft(composer.draft);
  useEffect(() => {
    if (typingElse) setFeedback(null);
  }, [typingElse]);

  useLayoutEffect(() => {
    if (!threadId || !anchor) return;
    const pane = anchor.closest("[data-split-pane-id]");
    if (!(pane instanceof HTMLElement)) return;
    const capture = (event: MouseEvent | KeyboardEvent) => {
      if (!(event.target instanceof Element) || event.defaultPrevented) return;
      const root = event.target.closest(ROOT);
      if (!root || root.closest("[data-split-pane-id]") !== pane) return;
      if (anchor.closest(ROOT) !== root && pane.querySelectorAll(ROOT).length !== 1) return;
      if (composer.isSubmittingBlocked || !isCompactDraft(composer.draft)) return;
      if (event instanceof KeyboardEvent) {
        if (!isCompactSubmitKey(event) || !event.target.closest(EDITOR)) return;
      } else if (event.button !== 0 || !event.target.closest(SEND)) return;

      event.preventDefault();
      event.stopPropagation();
      if (busy.current || (event instanceof KeyboardEvent && event.repeat)) return;
      busy.current = true;
      setFeedback({ text: "Requesting compaction…", threadId });
      void (async () => {
        try {
          const result = await mutate({ threadId });
          setFeedback({ text: result.message, threadId });
          if (result.ok) {
            try {
              composer.replace((latest) => isCompactDraft(latest) ? { text: "", mentions: [] } : latest);
            } catch {
              // The command was accepted even if this composer has gone away.
            }
          }
        } catch (error) {
          setFeedback({ text: error instanceof Error ? error.message : "Press could not request compaction.", threadId });
        } finally {
          busy.current = false;
        }
      })();
    };
    pane.addEventListener("keydown", capture, true);
    pane.addEventListener("click", capture, true);
    return () => {
      pane.removeEventListener("keydown", capture, true);
      pane.removeEventListener("click", capture, true);
    };
  }, [anchor, composer, mutate, threadId]);

  const message = feedback?.threadId === threadId ? feedback.text : "";
  // Always mounted, so screen readers announce the text when it arrives (F44).
  return <span ref={setAnchor} data-press-manual-command className="text-xs text-muted-foreground" role="status">{message}</span>;
}
