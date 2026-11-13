import { referenceNumbers } from "../../reference-tokens";

export interface ReferenceRange { number: number; range: Range }
export function scanReferenceText(row: Element): { text: string; urls: string[]; ranges: ReferenceRange[] } {
  const column = row.querySelector("[data-message-column]");
  if (!column) return { text: "", urls: [], ranges: [] };
  const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => node.parentElement?.closest("a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Array<{ node: Text; offset: number }> = [];
  let text = "";
  let previousBlock: Element | null = null;
  while (walker.nextNode() && text.length < 50000) {
    const node = walker.currentNode as Text | Element;
    if (node instanceof Element && !(node instanceof HTMLAnchorElement)) {
      if (node.tagName === "BR") { text += "\n"; previousBlock = null; }
      continue;
    }
    const parent = node instanceof HTMLAnchorElement ? node : node.parentElement;
    // Only a link a number adjoins gives up its repository, so every other message's scanned text, and its saved hash, stays as it was.
    const value = node instanceof HTMLAnchorElement
      ? node.nextSibling instanceof Text && node.nextSibling.data.startsWith("#")
        ? /^(?:[a-z][a-z0-9-]*:)?[\w.-]+\/[\w./-]+$/u.exec(node.textContent ?? "")?.[0] ?? /^https?:\/\/[^/\s?#]+\/([\w.-]+\/[\w./-]+?)\/?(?:[?#].*)?$/u.exec(node.href)?.[1]
        : undefined
      : node.data;
    if (!parent || value === undefined || parent.closest("[data-timeline-row-id]") !== row || parent.closest("code,pre,button,svg,script,style,iframe,[data-shuttle-references],[data-shuttle-card],[data-shuttle-reference-controls],[data-message-directive],[data-code-fence-renderer]")) {
      if (text && !text.endsWith("\n")) text += "\n";
      previousBlock = null;
      continue;
    }
    const block = parent.closest("p,li,td,th,div,blockquote,h1,h2,h3,h4,h5,h6") ?? column;
    const separator = text && previousBlock !== block && !text.endsWith("\n") ? "\n" : "";
    if (text.length + separator.length + value.length > 50000) break;
    text += separator;
    if (node instanceof Text) nodes.push({ node, offset: text.length });
    text += value;
    previousBlock = block;
  }
  const ranges = referenceNumbers(text).filter((ref) => ref.token.startsWith("#")).flatMap((ref) => {
    const start = nodes.find(({ node, offset }) => ref.offset >= offset && ref.offset < offset + node.length);
    const endOffset = ref.offset + ref.token.length;
    const end = nodes.find(({ node, offset }) => endOffset > offset && endOffset <= offset + node.length);
    if (!start || !end) return [];
    const range = document.createRange();
    range.setStart(start.node, ref.offset - start.offset);
    range.setEnd(end.node, endOffset - end.offset);
    return [{ number: ref.number, range }];
  });
  const urls = [...column.querySelectorAll<HTMLAnchorElement>("a[href^='http']")].filter((a) => a.closest("[data-timeline-row-id]") === row && !a.closest("[data-shuttle-references],pre,code,[data-code-fence-renderer]")).map((a) => a.href).filter((url) => url.length <= 2000).slice(0, 100);
  return { text, urls: [...new Set(urls)].sort(), ranges };
}
