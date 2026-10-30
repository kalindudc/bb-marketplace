import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, useSettings } from "@get-bb/plugin-sdk/app";
import type { InboxRule, InboxRuleKind, InboxView as InboxData, NextKind, NextTone, PrView } from "../contract";
import { INBOX_ORDER, ruleMatches } from "../next";
import { NextButton, useActions } from "./actions";
import { BUTTON, BUTTON_GHOST, Dialog, ErrorNote, escapedByTip, ICON_GHOST, ICON_GHOST_SMALL, PAGE, Segmented, Tip, TONE_TEXT } from "./common";
import { INBOX_TAB_LABELS } from "./constants";
import { messageOf, useShuttleQuery } from "./data";
import { atNine, plural, ruleText, timeOfDay, tinyKey, tinyOfKey } from "./format";
import { Picker, PickerAction, PickerGroup, PickerRadio, PickerSeparator } from "./picker";
import { inboxSwipeHint, inboxView, useFolding, type InboxGrouping, type InboxSort } from "./prefs";
import { useStored } from "./remember";
import type { InboxTab, Route } from "./route";
import { InboxRow, mentionsYouOnly, RepoChip, type RowLayout } from "./row";

const HOUR = 60 * 60_000;
const KBD = "rounded border border-b-2 border-border bg-background px-1 font-mono text-[10.5px] leading-[15px] text-muted-foreground";
const NOTE = "px-2.5 pb-1.5 pt-1 text-[11.5px] leading-snug text-muted-foreground";

export interface SnoozeChoice {
  id: "later" | "tomorrow" | "week" | "change";
  label: string;
  /** When it ends, as the menu shows it beside the label. */
  hint: string;
  icon: string;
  until: number | "update";
}

/** Later today is 3 hours from now; tomorrow and next week are 9:00 in the user's time zone, next week on a Monday. */
export function snoozeChoices(now: number): SnoozeChoice[] {
  const later = now + 3 * HOUR;
  const tomorrow = atNine(now, 1);
  const monday = atNine(now, (8 - new Date(now).getDay()) % 7 || 7);
  const weekday = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "short" });
  return [
    { id: "later", label: "Later today", hint: timeOfDay(later), icon: "Clock", until: later },
    { id: "tomorrow", label: "Tomorrow", hint: `${weekday(tomorrow)} ${timeOfDay(tomorrow)}`, icon: "Sun", until: tomorrow },
    { id: "week", label: "Next week", hint: `${weekday(monday)} ${timeOfDay(monday)}`, icon: "Calendar", until: monday },
    { id: "change", label: "Until it changes", hint: "", icon: "RotateCcw", until: "update" },
  ];
}

interface KindGroup {
  id: string;
  title: string;
  kinds: readonly NextKind[];
  icon: string;
  tone: NextTone;
  description(days: number): string;
}

const KIND_GROUPS: readonly KindGroup[] = [
  { id: "needs", title: "Needs you", kinds: ["agent_waiting", "nobody"], icon: "AlertTriangle", tone: "bad", description: () => "An agent waits on your answer, or feedback nobody is handling" },
  { id: "merge", title: "Ready to merge", kinds: ["ready_to_merge"], icon: "GitMerge", tone: "ok", description: () => "Approved, with green checks" },
  { id: "post", title: "AI reviews to post", kinds: ["post", "review_done", "review_failed"], icon: "Sparkles", tone: "info", description: () => "You choose what goes out; nothing is posted yet" },
  { id: "rereview", title: "Updated since your review", kinds: ["rereview"], icon: "RotateCcw", tone: "warn", description: () => "The author pushed or asked again" },
  { id: "new", title: "New review requests", kinds: ["new_request"], icon: "UserRound", tone: "info", description: (days) => `Asked you by name, or mentioned you, in the last ${plural(days, "day")}` },
];
const OTHER_GROUP: KindGroup = { id: "other", title: "Other", kinds: [], icon: "Circle", tone: "neutral", description: () => "" };

const GROUP_LABELS: Record<InboxGrouping, { menu: string; button: string }> = {
  kind: { menu: "What to do", button: "By what to do" },
  repo: { menu: "Repository", button: "By repo" },
  none: { menu: "No groups", button: "No groups" },
};
const SORT_LABELS: Record<InboxSort, string> = { priority: "Priority", newest: "Newest activity", oldest: "Oldest activity", small: "Smallest first" };

interface Section {
  /** What folds it, as `kind:needs` or `repo:<server>:<repo>`. */
  key: string;
  prs: PrView[];
  heading: { group: KindGroup } | { repo: PrView } | null;
}

const rank = (pr: PrView) => {
  const index = INBOX_ORDER.indexOf(pr.next.kind);
  return index < 0 ? INBOX_ORDER.length : index;
};
const updated = (pr: PrView) => pr.updatedAt ?? 0;
const lines = (pr: PrView) => (pr.additions === null || pr.deletions === null ? Number.POSITIVE_INFINITY : pr.additions + pr.deletions);

function compare(sort: InboxSort) {
  return (a: PrView, b: PrView) => {
    const small = lines(a) - lines(b);
    const by = sort === "priority" ? rank(a) - rank(b) || updated(b) - updated(a)
      : sort === "newest" ? updated(b) - updated(a)
        : sort === "oldest" ? updated(a) - updated(b)
          : Number.isNaN(small) ? 0 : small;
    return by || rank(a) - rank(b) || updated(b) - updated(a) || a.key.localeCompare(b.key);
  };
}

function sectionsOf(prs: readonly PrView[], group: InboxGrouping, sort: InboxSort): Section[] {
  const sorted = [...prs].sort(compare(sort));
  if (group === "none") return sorted.length === 0 ? [] : [{ key: "all", prs: sorted, heading: null }];
  if (group === "repo") {
    const repos = [...new Map(sorted.map((pr) => [`${pr.server}:${pr.repo}`, pr])).entries()].sort(([, a], [, b]) => a.repo.localeCompare(b.repo) || a.server.localeCompare(b.server));
    return repos.map(([id, first]) => ({ key: `repo:${id}`, prs: sorted.filter((pr) => `${pr.server}:${pr.repo}` === id), heading: { repo: first } }));
  }
  const groupOf = (pr: PrView) => KIND_GROUPS.find((item) => item.kinds.includes(pr.next.kind)) ?? OTHER_GROUP;
  return [...KIND_GROUPS, OTHER_GROUP]
    .map((item) => ({ key: `kind:${item.id}`, prs: sorted.filter((pr) => groupOf(pr) === item), heading: { group: item } }))
    .filter((section) => section.prs.length > 0);
}

/** Every word must be in the title, repo or author; "#12" matches a number that starts with 12. */
function matcher(query: string) {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return (pr: PrView) => {
    const hay = `${pr.title} ${pr.repo} ${pr.author} ${tinyKey(pr)}`.toLowerCase();
    return words.every((word) => {
      if (/^[#!]\d/u.test(word)) return String(pr.number).startsWith(word.slice(1));
      return hay.includes(word.replace(/^@/u, ""));
    });
  };
}

const RULE_ICONS: Record<InboxRuleKind, string> = { author: "UserRound", repo: "Folder", mention: "AtSign" };

function Note({ children }: { children: ReactNode }) {
  return <div className={NOTE}>{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div data-empty className="rounded-lg border border-border bg-card px-3.5 py-3 text-[13px] text-muted-foreground">{children}</div>;
}

/** Later today, tomorrow, next week or until it changes, for one PR or the selection. */
function SnoozeMenu({ prs, phone, open, onOpenChange, trigger, triggerClassName, triggerLabel, tip, onPick }: {
  prs: readonly PrView[];
  phone: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactNode;
  triggerClassName: string;
  triggerLabel: string;
  tip: { text: string; keys?: string };
  onPick(): void;
}) {
  const { writes } = useActions();
  const title = prs.length > 1 ? `Snooze ${plural(prs.length, "PR")} until…` : "Snooze until…";
  return (
    <Picker phone={phone} title={title} trigger={trigger} triggerClassName={triggerClassName} triggerLabel={triggerLabel} tip={tip} open={open} onOpenChange={onOpenChange}>
      {!phone && <PickerGroup>{title}</PickerGroup>}
      {snoozeChoices(Date.now()).map((choice) => (
        <PickerAction key={choice.id} onSelect={() => { onPick(); void writes.snoozePrs(prs, choice.until); }}>
          <Icon name={choice.icon} fallback="Clock" className="size-3.5 text-muted-foreground" aria-hidden />
          {choice.label}
          {choice.hint !== "" && <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">{choice.hint}</span>}
        </PickerAction>
      ))}
      <Note>Something new brings it back sooner.</Note>
    </Picker>
  );
}

/** A row's ⋯ menu: Snooze and Dismiss for this PR, then rules that keep every PR like it out of the Inbox. */
function RowMenu({ pr, inbox, phone, open, onOpenChange, onSnooze, onDismiss }: {
  pr: PrView;
  inbox: readonly PrView[];
  phone: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSnooze(): void;
  onDismiss(): void;
}) {
  const { writes } = useActions();
  // The snooze menu can only take focus once this menu has given it up, or it would close at once.
  const handOff = useRef<(() => void) | null>(null);
  const snooze = () => {
    if (phone) return void window.setTimeout(onSnooze, 0);
    handOff.current = onSnooze;
  };
  const onCloseAutoFocus = (event: Event) => {
    const next = handOff.current;
    if (next === null) return;
    handOff.current = null;
    event.preventDefault();
    next();
  };
  const choices: { kind: InboxRuleKind; value: string; label: string }[] = [
    ...(pr.mine ? [] : [{ kind: "author" as const, value: pr.author, label: `Every PR by @${pr.author}` }]),
    { kind: "repo", value: pr.repo, label: `Every PR from ${pr.repo}` },
    ...(mentionsYouOnly(pr) ? [{ kind: "mention" as const, value: pr.repo, label: `Mentions in ${pr.repo} unless I'm asked` }] : []),
  ];
  const leaving = (kind: InboxRuleKind, value: string) =>
    inbox.filter((item) => ruleMatches({ kind, server: pr.server, value }, { ...item, reasons: item.reasons.map((reason) => reason.reason) })).length;
  return (
    <Picker phone={phone} title={tinyKey(pr)} triggerLabel={`More for ${tinyKey(pr)}`} triggerClassName={ICON_GHOST} open={open} onOpenChange={onOpenChange} onCloseAutoFocus={onCloseAutoFocus}
      tip={{ text: "More: snooze, dismiss, or keep PRs like this out" }} trigger={<Icon name="MoreHorizontal" className="size-4" aria-hidden />}>
      <PickerAction onSelect={snooze}>
        <Icon name="Clock" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />Snooze…
      </PickerAction>
      <PickerAction onSelect={onDismiss}>
        <Icon name="ArchiveX" fallback="Archive" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />Dismiss from the Inbox
      </PickerAction>
      <PickerSeparator />
      <PickerGroup>Keep PRs like this out</PickerGroup>
      {choices.map((choice) => {
        const count = leaving(choice.kind, choice.value);
        return (
          <PickerAction key={choice.kind} onSelect={() => void writes.addRule({ kind: choice.kind, server: pr.server, value: choice.value })}>
            <Icon name={RULE_ICONS[choice.kind]} fallback="Circle" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 break-words">{choice.label}</span>
            <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">{count} in the Inbox</span>
          </PickerAction>
        );
      })}
      <Note>They stay in My PRs and Reviews. Rules are listed under Dismissed, where you can remove them.</Note>
    </Picker>
  );
}

function ViewMenu({ phone }: { phone: boolean }) {
  const prefs = useStored(inboxView);
  return (
    <Picker phone={phone} title="Group and sort" triggerClassName={BUTTON} tip={{ text: "Group and sort the Inbox" }} trigger={(
      <span data-view-button className="inline-flex items-center gap-1.5">
        <Icon name="Layers" fallback="ListView" className="size-3.5" aria-hidden />
        <span className="max-w-[190px] truncate @max-[560px]:hidden">{GROUP_LABELS[prefs.group].button} · {SORT_LABELS[prefs.sort]}</span>
        <Icon name="ChevronDown" className="size-3" aria-hidden />
      </span>
    )}>
      <PickerGroup>Group by</PickerGroup>
      {(Object.keys(GROUP_LABELS) as InboxGrouping[]).map((group) => (
        <PickerRadio key={group} checked={prefs.group === group} onSelect={() => inboxView.set({ ...inboxView.get(), group })}>{GROUP_LABELS[group].menu}</PickerRadio>
      ))}
      <PickerSeparator />
      <PickerGroup>Sort by</PickerGroup>
      {(Object.keys(SORT_LABELS) as InboxSort[]).map((sort) => (
        <PickerRadio key={sort} checked={prefs.sort === sort} onSelect={() => inboxView.set({ ...inboxView.get(), sort })}>{SORT_LABELS[sort]}</PickerRadio>
      ))}
    </Picker>
  );
}

const SHORTCUTS: readonly [readonly string[], string][] = [
  [["J", "K"], "Next and previous PR"],
  [["Enter"], "Open it"],
  [["X"], "Select it; Shift-click selects a range"],
  [["E"], "Dismiss the selected PRs, or this one"],
  [["S"], "Snooze the selected PRs, or this one"],
  [["U"], "Undo the last change"],
  [["/"], "Search"],
  [["Esc"], "Close the menu, then clear the selection"],
];

function ShortcutsDialog({ onClose }: { onClose(): void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className="grid grid-cols-[90px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[13px]">
        {SHORTCUTS.map(([keys, text]) => (
          <div key={text} className="contents">
            <dt className="flex gap-1">{keys.map((key) => <kbd key={key} className={KBD}>{key}</kbd>)}</dt>
            <dd className="m-0 text-muted-foreground">{text}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

function SectionHeading({ section, days, folded, onFold }: { section: Section; days: number; folded: boolean; onFold(): void }) {
  const heading = section.heading;
  if (heading === null) return null;
  const description = "group" in heading ? heading.group.description(days) : "";
  const what = description === "" ? "" : `${description}. `;
  return (
    <div className="mb-1.5 mt-3.5 flex min-h-6 items-center">
      <Tip text={`${what}${folded ? "Show this section" : "Fold this section"}`} side="right">
        <button type="button" aria-expanded={!folded} onClick={onFold}
          className="-ml-1 inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&:hover_b]:underline [&:hover_b]:underline-offset-2">
          <Icon name={folded ? "ChevronRight" : "ChevronDown"} className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          {"group" in heading ? (
            <>
              <Icon name={heading.group.icon} fallback="Circle" className={`size-3.5 shrink-0 ${TONE_TEXT[heading.group.tone]}`} aria-hidden />
              <b className="text-[11.5px] font-bold uppercase tracking-wider">{heading.group.title}</b>
            </>
          ) : <RepoChip pr={heading.repo} />}
          <span className="text-[11.5px] font-medium text-muted-foreground">{section.prs.length}</span>
        </button>
      </Tip>
    </div>
  );
}

type Menu = { kind: "snooze" | "more"; key: string } | null;
/** The selection bar's snooze menu, as opposed to one row's. */
const SELECTION = "";

/** The Inbox tab: search, View, sections of rows, and the keys that move through them. */
function InboxList({ data, layout, onGo, onShortcuts }: { data: InboxData; layout: RowLayout; onGo(route: Route): void; onShortcuts(): void }) {
  const { writes } = useActions();
  const phone = layout.phone;
  const prefs = useStored(inboxView);
  const hint = useStored(inboxSwipeHint);
  const folding = useFolding("inbox");
  const setting = useSettings().values?.inboxRequestDays;
  const days = typeof setting === "number" ? setting : 3;
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const anchor = useRef<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const all = data.prs.filter((pr) => pr.next.inbox);
  const shown = query.trim() === "" ? all : all.filter(matcher(query));
  const sections = sectionsOf(shown, prefs.group, prefs.sort);
  const visible = sections.filter((section) => !folding.folded(section.key)).flatMap((section) => section.prs);
  const order = visible.map((pr) => pr.key);
  const selection = [...visible, ...all.filter((pr) => !order.includes(pr.key))].filter((pr) => checked.has(pr.key));
  const selecting = selection.length > 0;
  // A cursor on a row that search, folding or a write took off screen is no cursor.
  const onScreen = cursor !== null && order.includes(cursor) ? cursor : null;

  const open = (key: string) => {
    setCursor(key);
    layout.onSelect(key);
  };
  /** PRs leave the list at once: the cursor moves on to the next one, and they leave the selection. */
  const leave = (keys: readonly string[]) => {
    if (cursor !== null && keys.includes(cursor)) {
      const after = order.slice(order.indexOf(cursor) + 1).find((key) => !keys.includes(key));
      setCursor(after ?? order.filter((key) => !keys.includes(key)).at(-1) ?? null);
    }
    setChecked((current) => new Set([...current].filter((key) => !keys.includes(key))));
    setMenu(null);
  };
  const dismiss = (prs: readonly PrView[]) => {
    if (prs.length === 0) return;
    leave(prs.map((pr) => pr.key));
    void writes.dismissPrs(prs, true);
  };
  const toggle = (key: string, range: boolean) => {
    setCursor(key);
    const from = anchor.current === null ? -1 : order.indexOf(anchor.current);
    setChecked((current) => {
      const next = new Set(current);
      if (range && from >= 0) {
        const to = order.indexOf(key);
        for (const item of order.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(item);
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    anchor.current = key;
  };
  const move = (step: number) => {
    if (order.length === 0) return;
    const at = onScreen === null ? -1 : order.indexOf(onScreen);
    const key = order[at < 0 ? 0 : Math.max(0, Math.min(order.length - 1, at + step))]!;
    setCursor(key);
    if (layout.selected !== null) layout.onSelect(key);
    const node = [...document.querySelectorAll<HTMLElement>("[data-row]")].find((item) => item.dataset.row === key);
    // A focused row answers Enter itself, so focus has to follow the cursor or Enter and E would act on different rows.
    if (node !== undefined && document.activeElement?.closest("[data-row]") != null) node.focus({ preventScroll: true });
    node?.scrollIntoView?.({ block: "nearest" });
  };

  const onKey = useRef<(event: KeyboardEvent) => void>(() => {});
  onKey.current = (event) => {
    const layerOpen = document.querySelector("[role=menu], [role=dialog]") !== null;
    // Closing a tooltip is no reason to ignore Escape.
    if (event.defaultPrevented && !(escapedByTip.has(event) && !layerOpen)) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = target !== null && (target.isContentEditable || target.matches("textarea, select, input:not([type=checkbox]):not([type=radio])"));
    // An open menu or dialog owns its keys, Escape included.
    if (layerOpen) return;
    if (event.key === "Escape") {
      if (typing) {
        target.blur();
        event.preventDefault();
      } else if (selecting) {
        setChecked(new Set());
        event.preventDefault();
      }
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    const onControl = target !== null && target !== document.body && target.closest("button, a, input, [role=menuitem], [data-row]") !== null;
    const handled = () => event.preventDefault();
    switch (event.key.length === 1 ? event.key.toLowerCase() : event.key) {
      case "j": case "ArrowDown": handled(); return move(1);
      case "k": case "ArrowUp": handled(); return move(-1);
      case "Enter": case "o":
        if (onScreen === null || (event.key === "Enter" && onControl)) return;
        handled();
        return open(onScreen);
      case "x":
        if (onScreen === null) return;
        handled();
        return toggle(onScreen, false);
      case "e":
        handled();
        return dismiss(selecting ? selection : visible.filter((pr) => pr.key === onScreen));
      case "s":
        if (!selecting && onScreen === null) return;
        handled();
        return setMenu({ kind: "snooze", key: selecting ? SELECTION : onScreen! });
      case "u":
        handled();
        if (!writes.undoLast()) toast("Nothing to undo.");
        return;
      case "/":
        handled();
        return search.current?.focus();
      case "?":
        handled();
        return onShortcuts();
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  // A closing menu clears only itself, so a menu opened as another closes (⋯ › Snooze…) stays open.
  const menuOf = (kind: "snooze" | "more", key: string) => ({
    open: menu?.kind === kind && menu.key === key,
    onOpenChange: (next: boolean) => setMenu((current) => (next ? { kind, key } : current?.kind === kind && current.key === key ? null : current)),
  });

  const toolbar = selecting ? (
    <div data-selection-bar className="sticky top-0 z-10 flex min-h-11 flex-wrap items-center gap-1.5 bg-background py-2">
      <Tip text={order.every((key) => checked.has(key)) ? "Clear the selection" : "Select every PR shown"}>
        <input type="checkbox" aria-label="Select every PR shown" checked={order.length > 0 && order.every((key) => checked.has(key))} readOnly
          onClick={() => setChecked(order.every((key) => checked.has(key)) ? new Set() : new Set([...checked, ...order]))}
          className="ml-2.5 mr-1 size-[15px] cursor-pointer accent-foreground" />
      </Tip>
      <b className="mr-1 text-[12.5px] font-semibold">{selection.length} selected</b>
      <SnoozeMenu prs={selection} phone={phone} {...menuOf("snooze", SELECTION)} triggerClassName={BUTTON} triggerLabel={`Snooze ${plural(selection.length, "PR")}`}
        tip={{ text: `Snooze the ${plural(selection.length, "selected PR")} until a time you pick`, keys: "S" }}
        trigger={<><Icon name="Clock" className="size-3.5" aria-hidden />Snooze<Icon name="ChevronDown" className="size-3" aria-hidden /></>}
        onPick={() => leave(selection.map((pr) => pr.key))} />
      <Tip text={`Dismiss the ${plural(selection.length, "selected PR")} from the Inbox for good`} keys="E">
        <button type="button" className={BUTTON} onClick={() => dismiss(selection)}>
          <Icon name="ArchiveX" fallback="Archive" className="size-3.5" aria-hidden />Dismiss
        </button>
      </Tip>
      <span className="flex-1" />
      <Tip text="Clear the selection">
        <button type="button" className={BUTTON_GHOST} onClick={() => setChecked(new Set())}>Clear{!phone && <kbd aria-hidden className={KBD}>Esc</kbd>}</button>
      </Tip>
    </div>
  ) : (
    <div data-toolbar className="sticky top-0 z-10 flex min-h-11 items-center gap-1.5 bg-background py-2">
      <label className="flex h-7 w-80 min-w-0 shrink items-center gap-1.5 rounded-md border border-input bg-background px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring @max-[560px]:flex-1">
        <Icon name="Search" className="size-3.5 shrink-0" aria-hidden />
        <input ref={search} type="search" aria-label="Search the Inbox" placeholder="Title, repo, author or #number" value={query} autoComplete="off" onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground" />
        {!phone && <kbd aria-hidden className={KBD}>/</kbd>}
      </label>
      <span className="flex-1 @max-[560px]:hidden" />
      <ViewMenu phone={phone} />
    </div>
  );

  const rowOf = (pr: PrView) => {
    const snooze = (
      <SnoozeMenu prs={[pr]} phone={phone} {...menuOf("snooze", pr.key)} triggerClassName={ICON_GHOST} triggerLabel={`Snooze ${tinyKey(pr)}`}
        tip={{ text: "Snooze: hide it until a time you pick", keys: selecting ? undefined : "S" }} trigger={<Icon name="Clock" className="size-4" aria-hidden />} onPick={() => leave([pr.key])} />
    );
    const more = <RowMenu pr={pr} inbox={all} phone={phone} {...menuOf("more", pr.key)} onDismiss={() => dismiss([pr])} onSnooze={() => setMenu({ kind: "snooze", key: pr.key })} />;
    return (
      <InboxRow key={pr.key} pr={pr} mode="inbox" phone={phone} selected={layout.selected === pr.key} checked={checked.has(pr.key)} selecting={selecting}
        cursor={cursor === pr.key} active={menu !== null && menu.key === pr.key} kindChip={prefs.group !== "kind"} repoChip={prefs.group !== "repo"}
        onOpen={() => open(pr.key)} onCheck={(range) => toggle(pr.key, range)} onFocus={() => setCursor(pr.key)}
        overlay={(
          <>
            {pr.next.primary !== null && <span className="inline-flex @max-[720px]:hidden"><NextButton pr={pr} action={pr.next.primary} primary small /></span>}
            {snooze}
            <Tip text="Dismiss: keep it out of the Inbox for good" keys={selecting ? undefined : "E"}>
              <button type="button" aria-label={`Dismiss ${tinyKey(pr)} from the Inbox`} className={ICON_GHOST} onClick={() => dismiss([pr])}>
                <Icon name="ArchiveX" fallback="Archive" className="size-4" aria-hidden />
              </button>
            </Tip>
            {more}
          </>
        )}
        menu={phone ? <>{more}<span className="hidden">{snooze}</span></> : undefined}
        onSwipe={phone ? { left: () => dismiss([pr]), right: () => setMenu({ kind: "snooze", key: pr.key }) } : undefined} />
    );
  };

  const foot: ReactNode[] = [];
  if (data.olderRequests > 0) {
    foot.push(
      <span key="older">
        {plural(data.olderRequests, "older request")} by name{" "}
        <button type="button" className="cursor-pointer text-primary hover:underline" onClick={() => onGo({ view: "reviews", source: "asked", key: null })}>wait in Reviews</button>
      </span>,
    );
  }
  if (data.handled > 0) {
    foot.push(
      <span key="handled">
        Automation did {plural(data.handled, "thing")} today:{" "}
        <button type="button" className="cursor-pointer text-primary hover:underline" onClick={() => onGo({ view: "insights", tab: "log" })}>Automation log</button>
      </span>,
    );
  }

  return (
    <>
      {toolbar}
      {phone && hint && (
        <div data-swipe-hint className="mb-1.5 mt-0.5 flex items-center gap-2 rounded-lg border border-dashed border-border py-1.5 pl-2.5 pr-1.5 text-xs text-muted-foreground">
          <Icon name="Info" className="size-3.5 shrink-0" aria-hidden />
          <span className="flex-1">Swipe a row left to dismiss it, or right to snooze it.</span>
          <button type="button" aria-label="Got it" title="Got it" className={ICON_GHOST_SMALL} onClick={() => inboxSwipeHint.set(false)}>
            <Icon name="X" className="size-3" aria-hidden />
          </button>
        </div>
      )}
      {all.length === 0 && (
        <div data-all-clear className="mt-3.5 flex items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-3 text-[13px] text-muted-foreground">
          <Icon name="CircleCheck" fallback="Check" className="size-4 shrink-0 text-success" aria-hidden />
          <span><b className="font-semibold text-foreground">All clear.</b> Nothing waits on you.</span>
        </div>
      )}
      {all.length > 0 && shown.length === 0 && (
        <div className="mt-3.5 flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-3 text-[13px] text-muted-foreground">
          <span>Nothing matches “{query.trim()}”.</span>
          <button type="button" className="cursor-pointer text-primary hover:underline" onClick={() => setQuery("")}>Clear</button>
        </div>
      )}
      {sections.map((section) => {
        const folded = folding.folded(section.key);
        return (
          <section key={section.key} data-section={section.key} aria-label={section.heading === null ? "Pull requests" : "group" in section.heading ? section.heading.group.title : section.heading.repo.repo} className={section.heading === null ? "mt-2" : ""}>
            <SectionHeading section={section} days={days} folded={folded} onFold={() => folding.toggle(section.key)} />
            {!folded && <ul className="overflow-hidden rounded-lg border border-border bg-card">{section.prs.map(rowOf)}</ul>}
          </section>
        );
      })}
      {foot.length > 0 && (
        <div data-foot className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">{foot}</div>
      )}
    </>
  );
}

function keepsText(rule: InboxRule): string {
  if (rule.keeps.length === 0) return "Keeps nothing out right now";
  const named = rule.keeps.slice(0, 3).map(tinyOfKey).join(", ");
  return `Keeps out ${named}${rule.keeps.length > 3 ? ` and ${rule.keeps.length - 3} more` : ""}`;
}

function Rules({ rules }: { rules: readonly InboxRule[] }) {
  const { writes } = useActions();
  return (
    <section aria-label="Rules" className="mt-5">
      <div className="mb-1.5 flex min-h-6 items-center gap-2">
        <b className="text-[11.5px] font-bold uppercase tracking-wider">Rules</b>
        <span className="text-[11.5px] font-medium text-muted-foreground">{rules.length}</span>
      </div>
      {rules.length === 0 ? <Empty>No rules. A row's ⋯ menu makes one.</Empty> : (
        <ul className="overflow-hidden rounded-lg border border-border bg-card">
          {rules.map((rule) => (
            <li key={rule.id} data-rule={rule.id} className="flex items-center gap-2.5 border-t border-border py-2.5 pl-3 pr-2.5 first:border-t-0">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-recessed text-muted-foreground">
                <Icon name={RULE_ICONS[rule.kind]} fallback="Circle" className="size-3.5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div data-rule-text title={`On ${rule.serverName}`} className="break-words text-[13px] font-semibold">{ruleText(rule)}</div>
                <div className="mt-0.5 break-words text-xs text-muted-foreground">{keepsText(rule)}</div>
              </div>
              <Tip text={rule.keeps.length > 0 ? `Remove the rule; ${plural(rule.keeps.length, "PR")} it keeps out come back to the Inbox` : "Remove the rule"}>
                <button type="button" className={BUTTON} onClick={() => void writes.removeRule(rule)}>Remove</button>
              </Tip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Snoozed or the Dismissed tab: what is out of the Inbox for now, or for good, and the way back. */
function OutList({ tab, data, layout }: { tab: InboxTab; data: InboxData; layout: RowLayout }) {
  const { writes } = useActions();
  const back = (pr: PrView) => pr.snoozedUntil ?? Number.POSITIVE_INFINITY;
  const prs = tab === "snoozed"
    ? data.snoozed.slice().sort((a, b) => back(a) - back(b))
    : data.dismissed.slice().sort((a, b) => (b.dismissed?.at ?? 0) - (a.dismissed?.at ?? 0));
  const note = tab === "snoozed"
    ? "They come back at the time shown, or sooner if something new happens."
    : "They stay out of the Inbox, even when they change. My PRs and Reviews still list them.";
  return (
    <>
      <p className="mb-2.5 mt-2 text-[12.5px] text-muted-foreground">{note}</p>
      {prs.length === 0 ? <Empty>{tab === "snoozed" ? "Nothing is snoozed." : "Nothing is dismissed."}</Empty> : (
        <ul className="overflow-hidden rounded-lg border border-border bg-card">
          {prs.map((pr) => (
            <InboxRow key={pr.key} pr={pr} mode={tab} phone={layout.phone} selected={layout.selected === pr.key} checked={false} selecting={false} cursor={false} active={false} kindChip={false}
              onOpen={() => layout.onSelect(pr.key)} onCheck={() => {}}
              trailing={tab === "snoozed"
                ? <Tip text="Bring it back to the Inbox now"><button type="button" className={BUTTON} onClick={() => void writes.snoozePrs([pr], null)}>Wake now</button></Tip>
                : <Tip text="Bring it back to the Inbox"><button type="button" className={BUTTON} onClick={() => void writes.dismissPrs([pr], false)}><Icon name="RotateCcw" className="size-3.5" aria-hidden />Restore</button></Tip>} />
          ))}
        </ul>
      )}
      {tab === "dismissed" && <Rules rules={data.rules} />}
    </>
  );
}

/** What waits on you, one row each under what to do; then what is snoozed, and what you dismissed. */
export function InboxView({ tab, layout, onGo }: { tab: InboxTab | "inbox"; layout: RowLayout; onGo(route: Route): void }) {
  const { writes } = useActions();
  const inbox = useShuttleQuery("inbox", {});
  const [shortcuts, setShortcuts] = useState(false);
  const data = inbox.data;
  const fresh = data?.dismissed.filter((pr) => pr.dismissed?.activity).length ?? 0;
  const unseen = data?.prs.filter((pr) => pr.next.inbox && pr.unseen).map((pr) => pr.key) ?? [];
  const tabs = [
    { value: "inbox" as const, label: "Inbox", tip: "What waits on you" },
    { value: "snoozed" as const, tip: "What you snoozed, and when each comes back", label: <>{INBOX_TAB_LABELS.snoozed}{data !== undefined && <>{" "}<b className="font-semibold">{data.snoozed.length}</b></>}</> },
    {
      value: "dismissed" as const,
      tip: fresh > 0 ? `What you dismissed, and your rules; ${plural(fresh, "dismissed PR")} changed since` : "What you dismissed, and your rules",
      label: (
        <>
          {INBOX_TAB_LABELS.dismissed}{data !== undefined && <>{" "}<b className="font-semibold">{data.dismissed.length}</b></>}
          {fresh > 0 && <span data-activity-dot role="img" aria-label={`${plural(fresh, "dismissed PR")} with new activity`} title={`${plural(fresh, "dismissed PR")} with new activity`} className="size-1.5 rounded-full bg-foreground" />}
        </>
      ),
    },
  ];
  return (
    <div className={PAGE}>
      <div className="mb-1 flex min-h-8 flex-wrap items-center gap-x-3.5 gap-y-2">
        <h2 className="text-lg font-semibold">Inbox</h2>
        {/* In a narrow page the tabs take a line of their own under the title and ⋯, instead of pushing ⋯ onto one. */}
        <div className="@max-[440px]:order-3 @max-[440px]:basis-full">
          <Segmented label="Inbox tabs" value={tab} options={tabs} onChange={(next) => onGo(next === "inbox" ? { view: "inbox", key: null } : { view: "inbox", tab: next, key: null })} />
        </div>
        <span className="flex-1" />
        <Picker phone={layout.phone} title="Inbox options" triggerClassName={ICON_GHOST} tip={{ text: "Mark all as seen, or see the keyboard shortcuts" }} trigger={<Icon name="MoreHorizontal" className="size-4" aria-hidden />}>
          <PickerAction onSelect={() => void writes.markSeen(unseen)}><Icon name="Eye" fallback="Check" className="size-3.5 text-muted-foreground" aria-hidden />Mark all as seen</PickerAction>
          {!layout.phone && (
            <PickerAction onSelect={() => setShortcuts(true)}>
              <Icon name="Keyboard" fallback="Info" className="size-3.5 text-muted-foreground" aria-hidden />Keyboard shortcuts<kbd aria-hidden className={`ml-auto ${KBD}`}>?</kbd>
            </PickerAction>
          )}
        </Picker>
      </div>
      {inbox.error !== null && <ErrorNote>Could not load the Inbox: {messageOf(inbox.error)}</ErrorNote>}
      {data === undefined && inbox.error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
      {data !== undefined && (tab === "inbox"
        ? <InboxList data={data} layout={layout} onGo={onGo} onShortcuts={() => setShortcuts(true)} />
        : <OutList tab={tab} data={data} layout={layout} />)}
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
    </div>
  );
}
