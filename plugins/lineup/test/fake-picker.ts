/**
 * A stand-in for bb 0.47's composer model button and model menu, built from
 * the markup bb draws. With several providers bb puts icon tabs above the
 * search box; with one provider it draws no tab row.
 */
export interface FakeProvider {
  title: string;
  rows: string[];
}

export interface FakePicker {
  form: HTMLFormElement;
  trigger: HTMLButtonElement;
  popover: HTMLElement;
  search: HTMLInputElement;
  listbox: HTMLElement;
  /** Row titles bb's own click handler selected, in order. */
  picked: string[];
  tabs(): HTMLButtonElement[];
  rows(): HTMLButtonElement[];
  activeTitle(): string;
  open(): void;
  close(): void;
}

const TAB_CLASS = "flex items-center justify-center border-b-2 focus-visible:outline-none transition-none h-7 w-6";

export function buildPicker(providers: FakeProvider[], doc: Document = document): FakePicker {
  const form = doc.createElement("form");
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-label", "Provider, model and reasoning (⇧ ⌘ M)");
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  form.append(trigger);
  doc.body.append(form);

  const popover = doc.createElement("div");
  popover.setAttribute("role", "dialog");
  popover.id = "radix-fake";
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

  return {
    form,
    trigger,
    popover,
    search,
    listbox,
    picked,
    tabs: () => (tabRow === null ? [] : (Array.from(tabRow.querySelectorAll(":scope > button[title]")) as HTMLButtonElement[])),
    rows: () => Array.from(listbox.querySelectorAll('button[role="option"]')) as HTMLButtonElement[],
    activeTitle: () => providers[active]!.title,
    open() {
      doc.body.append(popover);
      trigger.setAttribute("aria-controls", popover.id);
      trigger.setAttribute("aria-expanded", "true");
    },
    close() {
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-controls");
      popover.remove();
    },
  };
}
