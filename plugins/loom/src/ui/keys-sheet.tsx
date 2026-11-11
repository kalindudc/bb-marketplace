// The page's keys (`?`), grouped by where they work. Every key here is handled somewhere on the page; none of them acts on
// its own, so each is safe while rewound.
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { keysSheet, useStore } from "./dispatch";
import { KBD, Sheet } from "./kit";

const GROUPS: ReadonlyArray<{ title: string; keys: ReadonlyArray<{ keys: string[]; text: string }> }> = [
  {
    title: "Anywhere on the Loom page",
    keys: [
      { keys: ["/"], text: "Jump to a ticket, project, view or place" },
      { keys: ["?"], text: "These keys" },
      { keys: ["Esc"], text: "Close what is open, leave a ticket, or go back to now" },
    ],
  },
  {
    title: "On a project",
    keys: [
      { keys: ["1", "–", "5"], text: "Work, Spec, Planner, Ship, History" },
      { keys: ["["], text: "Rewind one moment" },
      { keys: ["]"], text: "Forward one moment" },
    ],
  },
  {
    title: "In Work",
    keys: [
      { keys: ["j", "k"], text: "Next or previous ticket in the list" },
      { keys: ["m"], text: "Map, or back to the list" },
      { keys: ["d"], text: "Show the dependencies beside a narrow list" },
    ],
  },
  {
    title: "In a dependency map",
    keys: [
      { keys: ["←", "→", "↑", "↓"], text: "Move along the edges and down a column" },
      { keys: ["Home", "End"], text: "The first or last node" },
      { keys: ["Enter", "Space"], text: "Open the ticket, or show a column's hidden tickets" },
    ],
  },
  {
    title: "On the time ruler",
    keys: [
      { keys: ["←", "→"], text: "Step a moment" },
      { keys: ["Home"], text: "The first moment" },
      { keys: ["End"], text: "Now" },
      { keys: ["Space"], text: "Play the moments up to now, or pause" },
    ],
  },
  {
    title: "In a row of tabs",
    keys: [
      { keys: ["←", "→"], text: "Move between tabs" },
      { keys: ["Home", "End"], text: "The first or last tab" },
      { keys: ["Enter", "Space"], text: "Open it" },
    ],
  },
  {
    title: "In a list or menu",
    keys: [
      { keys: ["↑", "↓"], text: "Move" },
      { keys: ["Enter"], text: "Open or run" },
    ],
  },
];

export function KeysSheet() {
  const open = useStore(keysSheet);
  return (
    <Sheet open={open} onOpenChange={(next) => keysSheet.set(next)} label="Keys" className="max-w-[30rem]">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Keys</h2>
        <button type="button" aria-label="Close" aria-keyshortcuts="Escape" className="inline-flex h-7 min-w-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-1.5 text-xs text-[var(--loom-muted)] hover:bg-state-hover max-[576px]:size-11 pointer-coarse:size-11" onClick={() => keysSheet.set(false)}>
          <span className="max-[576px]:hidden">
            <kbd className={KBD}>Esc</kbd>
          </span>
          <Icon name="X" aria-hidden className="hidden size-4 max-[576px]:block" />
        </button>
      </div>
      <div className="grid min-h-0 gap-4 overflow-y-auto px-4 py-3">
        {GROUPS.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3 className="mb-1.5 text-xs font-semibold text-[var(--loom-muted)]">{group.title}</h3>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-[13px]">
              {group.keys.map((entry) => (
                <div key={entry.text} className="contents">
                  <dt className="flex gap-1">
                    {entry.keys.map((key) =>
                      key === "–" ? (
                        <span key={key} aria-hidden className="text-[var(--loom-muted)]">
                          –
                        </span>
                      ) : (
                        <kbd key={key} className={KBD}>
                          {key}
                        </kbd>
                      ),
                    )}
                  </dt>
                  <dd>{entry.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
