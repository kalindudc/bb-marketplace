import { useLayoutEffect, useRef, useState } from "react";
import type { Reading, ReadingPart } from "./reading-state";
import { useRemembered } from "./remember";
import { useShared } from "./session";
import { fileTree, readerFiles, readerFocus, readerTrees } from "./ui-prefs";

const VISIBLE_PART = 48;
// How long the reader must hold a restored place, with the anchored card's diff drawn, before it stops restoring.
const SETTLE_MS = 1_000;
// Anything the person does in the reader takes over from a restore that is still settling.
const TAKE_OVER = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

// A staged card is a placeholder until its body mounts, and its body says when it is still loading the diff.
const drawn = (card: HTMLElement): boolean =>
  card.dataset.bodyDeferred === undefined && card.querySelector("[data-diff-loading]") === null;

const cardsOf = (stream: HTMLElement): HTMLElement[] => [
  ...stream.querySelectorAll<HTMLElement>("[data-file-card][data-reading-part]"),
];

export function returnToFiles(
  root: HTMLElement | null,
  key: string | null,
  toggle: HTMLButtonElement | null,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement) || target.closest("[data-diff-stream]") === null) return false;
  const buttons = [...(root?.querySelectorAll<HTMLButtonElement>("[data-file-nav]") ?? [])];
  const next =
    buttons.find((button) => button.dataset.fileNav === key) ??
    buttons.find((button) => button.dataset.holdsSelection === "true") ??
    buttons.find((button) => button.tabIndex === 0) ??
    toggle;
  next?.focus();
  return next !== null;
}

export function useReadingStream({
  surface,
  key,
  initial,
  fallback,
  ready,
}: {
  surface: string;
  key: string;
  initial?: Reading;
  fallback: Reading;
  ready: boolean;
}) {
  const [reading, setReading] = useState(() => initial ?? readerFiles.get(key) ?? fallback);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const focusRef = useRef<HTMLButtonElement | null>(null);
  const pending = useRef(
    reading.anchor ??
      (reading.file === undefined || reading.part === undefined
        ? undefined
        : { file: reading.file, part: reading.part, offset: 0 }),
  );
  const latest = useRef(reading);
  const watch = useRef<{ stream: HTMLElement; observer: ResizeObserver | null; stop(): void } | null>(null);
  const restoring = useRef(false);
  // What the last restore pass left: a pass that finds the same layout has nothing to do.
  const lastPlace = useRef<string | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const legacyTree = useShared(fileTree);
  const treeOn = useRemembered(readerTrees).get(surface) ?? legacyTree;
  const focusMode = useRemembered(readerFocus).get(surface) === true;

  const save = (next: Reading, render = true, chosen = false) => {
    latest.current = next;
    if (render) setReading(next);
    if (ready || chosen) readerFiles.set(key, next);
  };
  const capture = (): Reading["anchor"] => {
    const stream = streamRef.current;
    if (stream === null) return undefined;
    const { top, bottom } = stream.getBoundingClientRect();
    for (const card of cardsOf(stream)) {
      const bounds = card.getBoundingClientRect();
      const offset = Math.round(bounds.top - top);
      if (bounds.bottom > top && bounds.top < bottom && Math.abs(offset) <= 100_000) {
        return { file: card.dataset.fileCard!, part: card.dataset.readingPart as ReadingPart, offset };
      }
    }
    return undefined;
  };
  const rememberAnchor = (anchor: Reading["anchor"]) => {
    if (!ready) return;
    const before = latest.current.anchor;
    if (
      anchor !== undefined &&
      (before?.file !== anchor.file || before.part !== anchor.part || before.offset !== anchor.offset)
    ) {
      save({ ...latest.current, anchor }, false);
    }
  };
  // Scrolls made while a saved place is being restored are the reader's own, not a new place to resume.
  const updateAnchor = () => {
    if (ready && pending.current === undefined) rememberAnchor(capture());
  };
  const preserveAnchor = () => {
    pending.current = capture() ?? pending.current;
    rememberAnchor(pending.current);
  };
  const stopRestoring = () => {
    clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
    lastPlace.current = null;
    watch.current?.stop();
    watch.current = null;
  };
  const cancelRestore = () => {
    pending.current = undefined;
    stopRestoring();
  };
  // The first cards mount as short placeholders, so the reader often cannot scroll to a saved place yet: the browser
  // clamps scrollTop. Keep the place pending, and apply it again as the anchored card and the cards above it grow.
  const restore = () => {
    const anchor = pending.current;
    const stream = streamRef.current;
    if (anchor === undefined || stream === null || restoring.current) return;
    const cards = cardsOf(stream);
    const at = cards.findIndex(
      (node) => node.dataset.fileCard === anchor.file && node.dataset.readingPart === anchor.part,
    );
    const card = cards[at];
    if (card === undefined) return;
    // An observer may report synchronously from observe(); that report is this same pass.
    restoring.current = true;
    try {
      if (watch.current?.stream !== stream) {
        stopRestoring();
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => restore());
        for (const type of TAKE_OVER) stream.addEventListener(type, cancelRestore, { passive: true });
        watch.current = {
          stream,
          observer,
          stop: () => {
            observer?.disconnect();
            for (const type of TAKE_OVER) stream.removeEventListener(type, cancelRestore);
          },
        };
        observer?.observe(stream);
      }
      for (const above of cards.slice(0, at + 1)) watch.current.observer?.observe(above);
      place(stream, card, anchor);
    } finally {
      restoring.current = false;
    }
  };
  const place = (stream: HTMLElement, card: HTMLElement, anchor: NonNullable<Reading["anchor"]>) => {
    const top = stream.getBoundingClientRect().top;
    const layout = () => {
      const { top: cardTop, bottom } = card.getBoundingClientRect();
      return [anchor.file, anchor.part, anchor.offset, cardTop - top, bottom - cardTop, stream.scrollTop]
        .concat(stream.scrollHeight, drawn(card) ? 1 : 0)
        .join("\0");
    };
    if (layout() === lastPlace.current) return;
    const bounds = card.getBoundingClientRect();
    // An offset saved while the card was taller would leave it off screen, and a card off screen never loads its diff.
    const offset = Math.max(anchor.offset, Math.min(0, VISIBLE_PART - (bounds.bottom - bounds.top)));
    const delta = bounds.top - top - offset;
    if (Math.abs(delta) >= 1) stream.scrollTop += delta;
    lastPlace.current = layout();
    clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
    const landed = Math.abs(card.getBoundingClientRect().top - top - offset) < 1;
    if (landed && drawn(card))
      settleTimer.current = setTimeout(() => {
        if (pending.current === anchor) cancelRestore();
      }, SETTLE_MS);
  };
  // Not gated on `ready`: a busy thread's overview is refreshed after every edit and is rarely complete.
  useLayoutEffect(() => restore());
  useLayoutEffect(() => stopRestoring, []);
  useLayoutEffect(() => {
    if (ready && initial !== undefined) readerFiles.set(key, latest.current);
  }, [ready, key, initial]);
  useLayoutEffect(() => () => readerFiles.flush(), [key]);
  const toggleTree = () => {
    preserveAnchor();
    readerTrees.set(surface, !treeOn);
    toggleRef.current?.focus();
  };
  const toggleFocus = (to: "button" | "stream") => {
    preserveAnchor();
    readerFocus.set(surface, focusMode ? undefined : true);
    (to === "stream" ? (streamRef.current ?? focusRef.current) : focusRef.current)?.focus({ preventScroll: true });
  };
  const select = (file: string, part: ReadingPart, jump: boolean) => {
    const anchor = jump ? { file, part, offset: 0 } : latest.current.anchor;
    if (jump) pending.current = anchor;
    else cancelRestore();
    save({ ...latest.current, file, part, ...(anchor === undefined ? {} : { anchor }) }, true, true);
  };
  const setScope = (scope: Reading["scope"]) => {
    cancelRestore();
    save({
      scope,
      ...(latest.current.file === undefined ? {} : { file: latest.current.file, part: latest.current.part }),
    });
  };
  return {
    reading,
    save,
    streamRef,
    toggleRef,
    treeOn,
    toggleTree,
    focusMode,
    focusRef,
    toggleFocus,
    select,
    setScope,
    updateAnchor,
  };
}
