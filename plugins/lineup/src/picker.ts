/**
 * Finds the parts of bb's model menu and adds the places Lineup renders into.
 *
 * bb has no plugin API for this menu, so these selectors follow the markup bb
 * 0.47 draws. When any part is missing, `readPicker` returns null and Lineup
 * leaves the menu alone.
 *
 * On screens narrower than 768px bb draws the same menu inside a bottom
 * drawer in <body>. Its model button then names no menu in `aria-controls`,
 * the drawer has no id, and the drawer stays in the page, closed, after its
 * first open.
 */

export const TRIGGER_SELECTOR =
  'button[aria-haspopup="dialog"][aria-label^="Provider, model and reasoning"]';
const SEARCH_SELECTOR = 'input[aria-label="Search models"]';
const LISTBOX_SELECTOR = '[role="listbox"][aria-label="Models"]';
const NATIVE_TAB_SELECTOR = ':scope > button[title][class*="border-b-2"]';
const DRAWER_ATTR = "data-persistent-drawer-content";
const OPEN_DRAWER_SELECTOR = `[${DRAWER_ATTR}][data-state="open"]`;
/** What a drawer shows on its first open, for a few frames before it draws the menu. */
const DRAWER_PLACEHOLDER_SELECTOR = "[data-responsive-drawer-placeholder]";

export const VIEW_ATTR = "data-lineup-view";
const NATIVE_TABROW_ATTR = "data-lineup-native-tabrow";
const NATIVE_LIST_ATTR = "data-lineup-native-list";
const OWN_TABROW_ATTR = "data-lineup-tabrow";
const TABS_ATTR = "data-lineup-tabs";
const LIST_ATTR = "data-lineup-list";
export const PIN_SLOT_ATTR = "data-lineup-pin-slot";

/** bb's tab row classes, for the row Lineup adds when only one provider is enabled. */
const TABROW_CLASS = "flex shrink-0 items-center gap-0.5 border-b border-border bg-background px-2.5 pt-1";

export interface PickerParts {
  /** The element holding bb's tab row, search box and list: the popover, or the drawer's menu. */
  popover: HTMLElement;
  search: HTMLInputElement;
  listbox: HTMLElement;
  /** bb's provider tab row; null when only one provider is enabled and bb draws none. */
  nativeTabRow: HTMLElement | null;
  /** bb drew the menu in its narrow-screen drawer. */
  drawer: boolean;
}

export interface PickerMounts {
  tabs: HTMLElement;
  list: HTMLElement;
}

/** The element holding the composer the anchor sits in, found by its model button. */
export function findComposerRoot(anchor: Element): Element | null {
  const form = anchor.closest("form");
  if (form?.querySelector(TRIGGER_SELECTOR)) return form;
  for (let node = anchor.parentElement; node !== null; node = node.parentElement) {
    if (node.querySelector(TRIGGER_SELECTOR)) return node;
  }
  return null;
}

/**
 * The menu the composer's model button opened, or null while it is closed:
 * the popover its `aria-controls` names, or else the open drawer that holds
 * bb's model menu (or the placeholder it shows before drawing one).
 */
export function openPopover(root: Element, doc: Document = document): HTMLElement | null {
  const trigger = root.querySelector<HTMLElement>(TRIGGER_SELECTOR);
  if (trigger === null || trigger.getAttribute("aria-expanded") !== "true") return null;
  const id = trigger.getAttribute("aria-controls");
  if (id) return doc.getElementById(id);
  const drawers = Array.from(doc.querySelectorAll<HTMLElement>(OPEN_DRAWER_SELECTOR)).filter(
    (drawer) =>
      !drawer.contains(trigger) && drawer.querySelector(`${SEARCH_SELECTOR}, ${DRAWER_PLACEHOLDER_SELECTOR}`) !== null,
  );
  return drawers.at(-1) ?? null;
}

/** Read bb's parts from the menu `openPopover` found. */
export function readPicker(menu: HTMLElement): PickerParts | null {
  const search = menu.querySelector<HTMLInputElement>(SEARCH_SELECTOR);
  const listbox = menu.querySelector<HTMLElement>(LISTBOX_SELECTOR);
  if (search === null || listbox === null || listbox.parentElement === null) return null;
  const drawer = menu.hasAttribute(DRAWER_ATTR);
  // The drawer puts its drag handle and title before the menu bb draws in a popover.
  const popover = drawer
    ? Array.from(menu.children).find((child): child is HTMLElement => child instanceof HTMLElement && child.contains(search))
    : menu;
  if (popover === undefined) return null;
  const nativeTabRow =
    Array.from(popover.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        !child.hasAttribute(OWN_TABROW_ATTR) &&
        child.querySelector(NATIVE_TAB_SELECTOR) !== null,
    ) ?? null;
  return { popover, search, listbox, nativeTabRow, drawer };
}

export function nativeTabs(parts: PickerParts): HTMLButtonElement[] {
  return parts.nativeTabRow === null
    ? []
    : Array.from(parts.nativeTabRow.querySelectorAll<HTMLButtonElement>(NATIVE_TAB_SELECTOR));
}

/** The provider tab bb marks as selected, by its underline class. */
export function activeNativeTab(parts: PickerParts): HTMLButtonElement | null {
  return nativeTabs(parts).find((tab) => tab.classList.contains("border-foreground")) ?? null;
}

/**
 * Add Lineup's tab container and list container, or return the ones already
 * there. Idempotent, so it can run after every change bb makes to the menu.
 */
export function ensureMounts(parts: PickerParts): PickerMounts {
  const { popover, listbox, nativeTabRow } = parts;
  let tabRow = nativeTabRow;
  const ownRow = popover.querySelector<HTMLElement>(`:scope > [${OWN_TABROW_ATTR}]`);
  if (tabRow === null) {
    tabRow = ownRow ?? Object.assign(document.createElement("div"), { className: TABROW_CLASS });
    tabRow.setAttribute(OWN_TABROW_ATTR, "");
    if (tabRow.parentElement !== popover) popover.prepend(tabRow);
  } else {
    ownRow?.remove();
    tabRow.setAttribute(NATIVE_TABROW_ATTR, "");
  }
  let tabs = tabRow.querySelector<HTMLElement>(`:scope > [${TABS_ATTR}]`);
  if (tabs === null) {
    tabs = document.createElement("span");
    tabs.setAttribute(TABS_ATTR, "");
    tabs.style.display = "contents";
    tabRow.prepend(tabs);
  }
  listbox.setAttribute(NATIVE_LIST_ATTR, "");
  let list = popover.querySelector<HTMLElement>(`[${LIST_ATTR}]`);
  if (list === null) {
    list = document.createElement("div");
    list.setAttribute(LIST_ATTR, "");
  }
  if (list.previousElementSibling !== listbox) listbox.after(list);
  return { tabs, list };
}

/** Take out everything Lineup added, leaving bb's menu as bb drew it. */
export function removeMounts(popover: HTMLElement) {
  popover.removeAttribute(VIEW_ATTR);
  for (const node of popover.querySelectorAll(`[${VIEW_ATTR}]`)) node.removeAttribute(VIEW_ATTR);
  for (const node of popover.querySelectorAll(`[${OWN_TABROW_ATTR}], [${TABS_ATTR}], [${LIST_ATTR}], [${PIN_SLOT_ATTR}]`)) {
    node.remove();
  }
  for (const node of popover.querySelectorAll(`[${NATIVE_TABROW_ATTR}], [${NATIVE_LIST_ATTR}]`)) {
    node.removeAttribute(NATIVE_TABROW_ATTR);
    node.removeAttribute(NATIVE_LIST_ATTR);
  }
}

export interface NativeRow {
  title: string;
  slot: HTMLElement;
}

/**
 * bb's model rows with a pin slot added before each row's check mark. The
 * label lives on the row's inner `[title]` span.
 */
export function nativeRowSlots(listbox: HTMLElement): NativeRow[] {
  const rows: NativeRow[] = [];
  for (const row of listbox.querySelectorAll<HTMLElement>('button[role="option"]')) {
    const title = row.querySelector<HTMLElement>("[title]")?.getAttribute("title");
    const trailing = row.lastElementChild;
    if (!title || !(trailing instanceof HTMLElement) || trailing.hasAttribute("title")) continue;
    let slot = trailing.querySelector<HTMLElement>(`:scope > [${PIN_SLOT_ATTR}]`);
    if (slot === null) {
      slot = document.createElement("span");
      slot.setAttribute(PIN_SLOT_ATTR, "");
      slot.style.display = "contents";
      trailing.prepend(slot);
    }
    rows.push({ title, slot });
  }
  return rows;
}
