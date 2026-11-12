const ranges = new Map<symbol, { normal: Range[]; active: Range[] }>();
const NORMAL = "shuttle-inferred-links";
const ACTIVE = "shuttle-inferred-links-active";

export function supportsReferenceHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function paint(): void {
  if (!supportsReferenceHighlights()) return;
  const normal = [...ranges.values()].flatMap((value) => value.normal).filter((range) => range.startContainer.isConnected && range.endContainer.isConnected);
  const active = [...ranges.values()].flatMap((value) => value.active).filter((range) => range.startContainer.isConnected && range.endContainer.isConnected);
  if (normal.length) CSS.highlights.set(NORMAL, new Highlight(...normal)); else CSS.highlights.delete(NORMAL);
  if (active.length) CSS.highlights.set(ACTIVE, new Highlight(...active)); else CSS.highlights.delete(ACTIVE);
}

export function setReferenceHighlights(owner: symbol, normal: Range[], active: Range[] = []): void {
  ranges.set(owner, { normal, active });
  paint();
}

export function clearReferenceHighlights(owner: symbol): void {
  ranges.delete(owner);
  paint();
}
