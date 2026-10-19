import type { Ref } from "react";
import { StatusGlyph } from "./status-glyph";
import { STATE_LABEL, type RowState } from "./status";
import type { DragView } from "./use-drag";

export function DropIndicator({ view }: { view: DragView | null }) {
  if (!view?.target || !view.indicator || view.plan?.ok === "noop") return null;
  const { top, left, width } = view.indicator;
  if (view.plan?.ok === false) return <span className="sb-drop-pill sb-drop-pill-bad"
    style={{ top, left: Math.max(0, left), maxWidth: width }} role="status">{view.plan.reason}</span>;
  if (view.target.kind === "row" && view.target.instruction.kind === "child") return null;
  return <span aria-hidden className="sb-indicator" style={{ top, left, width }} />;
}

export function DragGhost({ view, ghostRef, titleOf, stateOf }: {
  view: DragView | null;
  ghostRef: Ref<HTMLDivElement>;
  titleOf(id: string): string;
  stateOf(id: string): RowState;
}) {
  if (!view) return null;
  const ids = view.subject.kind === "threads" ? view.subject.ids : [view.subject.sectionId];
  const state = view.subject.kind === "threads" ? stateOf(ids[0]!) : null;
  return <div ref={ghostRef} aria-hidden className="sb-ghost">
    {state ? <StatusGlyph state={state} label={STATE_LABEL[state]} /> : <span>▦</span>}
    <span className="min-w-0 flex-1 truncate">{titleOf(ids[0]!)}</span>
    {ids.length > 1 && <span className="rounded bg-sidebar-accent px-1 font-mono text-2xs">+{ids.length - 1}</span>}
  </div>;
}
