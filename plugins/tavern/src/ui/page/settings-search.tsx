import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { plural } from "../kit";

const ROW = "[data-setting-keys], [data-settings-row]";
const GROUP = ".tv-settings-group, .tv-settings-card, details";

export function SettingsSearch({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const [count, setCount] = useState(0);
  const search = /\blimit:\s+([a-z][\w.]+\.[a-z]\w*)\s*=/i.exec(text)?.[1] ?? text;
  const query = search.trim().toLowerCase().replace(/\s+/g, " ");
  const results = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const clear = () => { setText(""); input.current?.focus(); };

  useLayoutEffect(() => {
    const root = results.current;
    if (!root || !query) return;
    const hidden = new Set<HTMLElement>();
    const folds = new Map<HTMLDetailsElement, boolean>();
    const filter = () => {
      const unmatched = new Set<HTMLElement>();
      const groups = new Map<HTMLElement, boolean>();
      let count = 0;
      for (const row of root.querySelectorAll<HTMLElement>(ROW)) {
        const copy = [...row.querySelectorAll("[data-settings-copy]")].map(el => el.textContent ?? "");
        const match = [row.dataset.settingKeys, row.dataset.settingsRow, ...copy].some(value => value?.toLowerCase().replace(/\s+/g, " ").includes(query));
        if (match) count++;
        else unmatched.add(row);
        for (let group = row.closest<HTMLElement>(GROUP); group && root.contains(group); group = group.parentElement?.closest<HTMLElement>(GROUP) ?? null) {
          groups.set(group, match || groups.get(group) === true);
        }
      }
      const open = new Set<HTMLDetailsElement>();
      for (const group of root.querySelectorAll<HTMLElement>(GROUP)) {
        const match = groups.get(group);
        if (group instanceof HTMLDetailsElement) {
          if (match) open.add(group);
          else if (match === false) unmatched.add(group);
        } else if (!match) unmatched.add(group);
      }
      for (const element of hidden) if (!unmatched.has(element)) { element.hidden = false; hidden.delete(element); }
      for (const element of unmatched) if (!element.hidden) { element.hidden = true; hidden.add(element); }
      for (const [fold, wasOpen] of folds) if (!open.has(fold)) { fold.open = wasOpen; folds.delete(fold); }
      for (const fold of open) {
        if (!folds.has(fold)) folds.set(fold, fold.open);
        fold.open = true;
      }
      setCount(count);
    };
    const keepOpen = (event: Event) => {
      const fold = event.target instanceof Element ? event.target.closest("summary")?.parentElement : null;
      if (fold instanceof HTMLDetailsElement && folds.has(fold)) event.preventDefault();
    };
    filter();
    // Settings and their help can arrive after the search has started.
    const observer = new MutationObserver(filter);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-setting-keys", "data-settings-row"] });
    root.addEventListener("click", keepOpen);
    return () => {
      observer.disconnect();
      root.removeEventListener("click", keepOpen);
      for (const element of hidden) element.hidden = false;
      for (const [fold, wasOpen] of folds) fold.open = wasOpen;
    };
  }, [query]);

  return <div className="tv-settings-page">
    <div className="tavern tv-page tv-settings-search" role="search" aria-label="Tavern settings">
      <label htmlFor={id}>Search settings</label>
      <div className="tv-settings-search-controls">
        <input ref={input} id={id} type="search" className="tv-text" value={text} spellCheck={false}
          onChange={event => setText(event.target.value)} onKeyDown={event => {
            if (event.key !== "Escape" || !text) return;
            event.preventDefault();
            event.stopPropagation();
            clear();
          }} />
        {text && <button className="btn sm" type="button" onClick={clear}>Clear search</button>}
      </div>
      <p role="status">{query ? count ? plural(count, "match", "matches") : "No settings match" : ""}</p>
    </div>
    <div ref={results} className="tv-settings-results">{children}</div>
  </div>;
}
