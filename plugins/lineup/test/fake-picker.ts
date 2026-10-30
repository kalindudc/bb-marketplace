/**
 * A stand-in for bb 0.47's composer model button and model menu, built from
 * the markup bb draws. With several providers bb puts icon tabs above the
 * search box; with one provider it draws no tab row. On screens narrower than
 * 768px bb draws the same menu inside a bottom drawer instead of a popover.
 */
export interface FakeProvider {
  title: string;
  rows: string[];
}

export interface FakePickerOptions {
  /**
   * Draw the menu as bb does on a narrow screen: inside a drawer in <body>
   * that the button names no id for. The drawer's first open shows a
   * placeholder until `realize`, and closing keeps the drawer in the page.
   */
  drawer?: boolean;
}

export interface FakePicker {
  form: HTMLFormElement;
  trigger: HTMLButtonElement;
  /** The element holding bb's tab row, search box and list. */
  popover: HTMLElement;
  /** What the open button leads to: the popover itself, or the drawer around it. */
  menu: HTMLElement;
  search: HTMLInputElement;
  listbox: HTMLElement;
  /** Row titles bb's own click handler selected, in order. */
  picked: string[];
  tabs(): HTMLButtonElement[];
  rows(): HTMLButtonElement[];
  activeTitle(): string;
  open(): void;
  /** Swap the drawer's placeholder for the menu, as bb does a few frames after the first open. */
  realize(): void;
  close(): void;
}

const TAB_CLASS = "flex items-center justify-center border-b-2 focus-visible:outline-none transition-none h-7 w-6";

export function buildPicker(providers: FakeProvider[], options: FakePickerOptions = {}, doc: Document = document): FakePicker {
  const form = doc.createElement("form");
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-label", "Provider, model and reasoning (⇧ ⌘ M)");
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  form.append(trigger);
  doc.body.append(form);

  const popover = doc.createElement("div");
  if (options.drawer) {
    popover.className = "flex min-h-0 flex-col p-0 flex-1 overflow-y-hidden";
  } else {
    popover.setAttribute("role", "dialog");
    popover.id = "radix-fake";
  }
  const drawer = options.drawer ? buildDrawer(doc) : null;
  const picked: string[] = [];
  let active = 0;

  let tabRow: HTMLElement | null = null;
  if (providers.length > 1) {
    tabRow = doc.createElement("div");
    tabRow.className = "flex shrink-0 items-center gap-0.5 border-b border-border bg-background px-2.5 pt-1";
    providers.forEach((provider, index) => {
      const tab = doc.createElement("button");
      tab.title = provider.title;
      tab.addEventListener("click", () => {
        active = index;
        paint();
      });
      tabRow!.append(tab);
    });
    popover.append(tabRow);
  }
  const searchRow = doc.createElement("div");
  searchRow.className = "shrink-0 border-b border-border px-1.5 py-1";
  const search = doc.createElement("input");
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-label", "Search models");
  searchRow.append(search);
  popover.append(searchRow);

  const wrapper = doc.createElement("div");
  wrapper.className = "flex min-h-0 flex-1 flex-col overflow-hidden";
  const listbox = doc.createElement("div");
  listbox.setAttribute("role", "listbox");
  listbox.setAttribute("aria-label", "Models");
  wrapper.append(listbox);
  popover.append(wrapper);
  const reasoning = doc.createElement("div");
  reasoning.textContent = "Reasoning";
  popover.append(reasoning);

  function paint() {
    if (tabRow !== null) {
      Array.from(tabRow.querySelectorAll<HTMLButtonElement>(":scope > button[title]")).forEach((tab, index) => {
        tab.className = `${TAB_CLASS} ${index === active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground"}`;
      });
    }
    listbox.replaceChildren();
    const header = doc.createElement("div");
    header.textContent = "Model";
    listbox.append(header);
    for (const title of providers[active]!.rows) {
      const row = doc.createElement("button");
      row.setAttribute("role", "option");
      const label = doc.createElement("span");
      label.title = title;
      label.textContent = title;
      const trailing = doc.createElement("span");
      trailing.className = "flex shrink-0 items-center gap-1.5";
      trailing.append(doc.createElementNS("http://www.w3.org/2000/svg", "svg"));
      row.append(label, trailing);
      row.addEventListener("click", () => picked.push(title));
      listbox.append(row);
    }
  }
  paint();

  const realize = () => {
    if (drawer !== null && !popover.isConnected) drawer.placeholder.replaceWith(popover);
  };

  return {
    form,
    trigger,
    popover,
    menu: drawer?.dialog ?? popover,
    search,
    listbox,
    picked,
    tabs: () => (tabRow === null ? [] : (Array.from(tabRow.querySelectorAll(":scope > button[title]")) as HTMLButtonElement[])),
    rows: () => Array.from(listbox.querySelectorAll('button[role="option"]')) as HTMLButtonElement[],
    activeTitle: () => providers[active]!.title,
    open() {
      if (drawer === null) {
        doc.body.append(popover);
        trigger.setAttribute("aria-controls", popover.id);
      } else {
        if (!drawer.dialog.isConnected) doc.body.append(drawer.backdrop, drawer.dialog);
        drawer.setOpen(true);
        if (!popover.isConnected) setTimeout(realize, 10);
      }
      trigger.setAttribute("aria-expanded", "true");
    },
    realize,
    close() {
      trigger.setAttribute("aria-expanded", "false");
      if (drawer === null) {
        trigger.removeAttribute("aria-controls");
        popover.remove();
      } else {
        drawer.setOpen(false);
      }
    },
  };
}

/** bb's persistent bottom drawer: a backdrop and a dialog with a drag handle and a hidden title. */
function buildDrawer(doc: Document) {
  const backdrop = doc.createElement("div");
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.setAttribute("data-persistent-drawer-backdrop", "");
  const dialog = doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("data-bb-portaled-overlay", "");
  dialog.setAttribute("data-persistent-drawer-content", "");
  dialog.setAttribute("aria-labelledby", "fake-drawer-title");
  const handle = doc.createElement("div");
  handle.setAttribute("data-persistent-drawer-handle", "");
  const title = doc.createElement("h2");
  title.id = "fake-drawer-title";
  title.className = "sr-only";
  title.textContent = "Model";
  const placeholder = doc.createElement("div");
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.setAttribute("data-responsive-drawer-placeholder", "");
  dialog.append(handle, title, placeholder);
  const setOpen = (open: boolean) => {
    for (const node of [backdrop, dialog]) node.setAttribute("data-state", open ? "open" : "closed");
    if (open) {
      dialog.removeAttribute("aria-hidden");
      dialog.removeAttribute("inert");
      dialog.setAttribute("aria-modal", "true");
    } else {
      dialog.setAttribute("aria-hidden", "true");
      dialog.setAttribute("inert", "");
      dialog.removeAttribute("aria-modal");
    }
  };
  return { backdrop, dialog, placeholder, setOpen };
}
