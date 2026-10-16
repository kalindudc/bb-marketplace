// A stand-in for the DOM that bb 0.46.1 renders for timeline rows
// (ExpandablePanel, TimelineWorkingIndicator and TimelineReasoningDetail),
// including the click-to-toggle behaviour and the scroll box geometry that
// jsdom does not compute.

const DETAIL_CLASS_NAME =
  "max-h-80 overflow-auto whitespace-pre-wrap break-words ms-1.5 border-l border-border-seam pl-3 text-sm leading-relaxed text-muted-foreground";
const LINE_HEIGHT_PX = 20;
export const DETAIL_CLIENT_HEIGHT_PX = 100;

export interface FakeRowOptions {
  title: string;
  /** Wraps the row in `[data-timeline-row-id]`; null renders the live indicator shape. */
  rowId: string | null;
  /** The leading icon name; null renders no leading icon. */
  icon: string | null;
  text: string;
  expanded?: boolean;
}

export interface FakeRow {
  readonly element: HTMLElement;
  readonly header: HTMLButtonElement;
  detail(): HTMLElement | null;
  isExpanded(): boolean;
  appendText(more: string): void;
}

function installScrollGeometry(detail: HTMLElement): void {
  let scrollTop = 0;
  const scrollHeight = () =>
    Math.max(
      DETAIL_CLIENT_HEIGHT_PX,
      (detail.textContent ?? "").split("\n").length * LINE_HEIGHT_PX,
    );
  Object.defineProperty(detail, "clientHeight", {
    configurable: true,
    get: () => DETAIL_CLIENT_HEIGHT_PX,
  });
  Object.defineProperty(detail, "scrollHeight", {
    configurable: true,
    get: scrollHeight,
  });
  Object.defineProperty(detail, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      const next = Math.min(
        Math.max(0, value),
        scrollHeight() - DETAIL_CLIENT_HEIGHT_PX,
      );
      if (next === scrollTop) return;
      scrollTop = next;
      queueMicrotask(() => detail.dispatchEvent(new Event("scroll")));
    },
  });
}

export function maxScrollTop(detail: HTMLElement): number {
  return detail.scrollHeight - detail.clientHeight;
}

/** What a person does: a wheel gesture, then the browser scrolls. */
export function userScrollTo(detail: HTMLElement, top: number): void {
  detail.dispatchEvent(new WheelEvent("wheel", { deltaY: top - detail.scrollTop }));
  detail.scrollTop = top;
}

export function createRow(options: FakeRowOptions): FakeRow {
  const root = document.createElement("div");
  root.className = "rounded-md text-muted-foreground w-full";

  const headerWrapper = document.createElement("div");
  headerWrapper.className = "group/timeline-row";
  const header = document.createElement("button");
  header.type = "button";
  const summary = document.createElement("span");
  if (options.icon !== null) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("data-icon", options.icon);
    summary.append(icon);
  }
  const title = document.createElement("span");
  title.textContent = options.title;
  summary.append(title);
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("data-icon-root", "");
  header.append(summary, chevron);
  headerWrapper.append(header);

  const body = document.createElement("div");
  body.className = "grid";
  const clip = document.createElement("div");
  clip.className = "overflow-hidden";
  const content = document.createElement("div");
  content.className = "px-2 pb-1 pt-0";
  clip.append(content);
  body.append(clip);
  root.append(headerWrapper, body);

  let text = options.text;
  let detail: HTMLElement | null = null;
  const setExpanded = (expanded: boolean) => {
    header.setAttribute("aria-expanded", String(expanded));
    if (expanded && detail === null) {
      detail = document.createElement("div");
      detail.className = DETAIL_CLASS_NAME;
      detail.append(document.createTextNode(text));
      installScrollGeometry(detail);
      content.append(detail);
    } else if (!expanded && detail !== null) {
      detail.remove();
      detail = null;
    }
  };
  header.addEventListener("click", () => {
    setExpanded(header.getAttribute("aria-expanded") !== "true");
  });
  setExpanded(options.expanded ?? false);

  let element: HTMLElement;
  if (options.rowId === null) {
    element = document.createElement("div");
    element.className = "mt-4";
    element.append(root);
  } else {
    element = document.createElement("div");
    element.setAttribute("data-timeline-row-id", options.rowId);
    element.append(root);
  }

  return {
    element,
    header,
    detail: () => detail,
    isExpanded: () => header.getAttribute("aria-expanded") === "true",
    appendText(more: string) {
      text += more;
      const node = detail?.firstChild;
      if (node) node.nodeValue = text;
    },
  };
}

export function thoughtRow(rowId: string, text = "Compare both render paths."): FakeRow {
  return createRow({ title: "Thought for 12s", rowId, icon: "AiBrain01", text });
}

export function liveThinking(text = "Looking at the timeline."): FakeRow {
  return createRow({ title: "Thinking…", rowId: null, icon: null, text });
}

export function commandRow(rowId: string): FakeRow {
  return createRow({ title: "Ran npm test", rowId, icon: "Terminal", text: "ok" });
}

export function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n");
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
