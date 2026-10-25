import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, experimental_usePluginId, UrlLink, useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { parseKey } from "../keys";
import { BUTTON, ICON_GHOST } from "./common";
import { PANEL_PATH } from "./constants";
import { useShuttleMutation, useShuttleQuery } from "./data";
import { settingsHref } from "./format";
import { routeOf } from "./prefs";
import { formatRoute, type Route } from "./route";
import { useViewport } from "./viewport";

const SEARCH_DELAY_MS = 200;

/** Text that names one PR, for look-up, rather than words to search: a link, or a key such as delta:shop/world#2261179. */
export const isLookupText = (text: string) => /^https?:\/\//iu.test(text.trim()) || parseKey(text) !== null;

/** The look-up field: a link or a key, fetched from its server, then shown on the page. */
export function LookupInput({ placeholder, onFound, icon = "Search", label = "Look up a pull request" }: {
  placeholder: string;
  onFound(key: string): Promise<void> | void;
  icon?: string;
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const lookup = useShuttleMutation("lookup");
  const busy = lookup.isPending;
  const submit = async () => {
    const trimmed = query.trim();
    if (trimmed === "" || busy) return;
    const out = await lookup.run({ query: trimmed });
    if (out === null) return;
    setQuery("");
    await onFound(out.pr.key);
  };
  return (
    <label className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-2">
      <Icon name={busy ? "Loading" : icon} className={`size-3.5 shrink-0 text-muted-foreground ${busy ? "animate-spin" : ""}`} aria-hidden />
      <input aria-label={label} placeholder={placeholder} value={query} disabled={busy}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" />
    </label>
  );
}

/**
 * The page's search field. Words search the PRs Shuttle already has as you type, on the Search page;
 * a pasted link or key is looked up on its server when you press Enter, as before.
 */
function SearchInput({ subPath, placeholder, autoFocus = false }: { subPath: string; placeholder: string; autoFocus?: boolean }) {
  const navigate = useBbNavigate();
  const route = routeOf(subPath);
  const routeQuery = route.view === "search" ? route.query : null;
  const [text, setText] = useState(routeQuery ?? "");
  // The words this field last put in the route: a route change it made itself must not reset what is typed.
  const sent = useRef(routeQuery);
  const onSearch = useRef(routeQuery !== null);
  onSearch.current = routeQuery !== null;
  useEffect(() => {
    if (routeQuery === sent.current) return;
    // Another area, Back, or a deep link moved the page.
    sent.current = routeQuery;
    setText(routeQuery ?? "");
  }, [routeQuery]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  const lookup = useShuttleMutation("lookup");
  const busy = lookup.isPending;

  const show = (next: Route, replace: boolean) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(next), ...(replace ? { replace: true } : {}) });
  const search = (words: string) => {
    cancel();
    const query = words.trim();
    if (query === sent.current || (query === "" && !onSearch.current)) return;
    sent.current = query;
    // The first search pushes, so Back returns to where it started; refining it replaces.
    show({ view: "search", query, key: null }, onSearch.current);
  };
  const change = (value: string) => {
    setText(value);
    cancel();
    if (isLookupText(value)) return;
    timer.current = setTimeout(() => search(value), SEARCH_DELAY_MS);
  };
  const submit = async () => {
    const trimmed = text.trim();
    if (busy) return;
    if (!isLookupText(trimmed)) return search(trimmed);
    cancel();
    const out = await lookup.run({ query: trimmed });
    if (out === null) return;
    setText("");
    show({ view: "pr", key: out.pr.key }, false);
  };
  return (
    <label className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-2">
      <Icon name={busy ? "Loading" : "Search"} className={`size-3.5 shrink-0 text-muted-foreground ${busy ? "animate-spin" : ""}`} aria-hidden />
      <input aria-label="Search pull requests" placeholder={placeholder} value={text} disabled={busy} autoFocus={autoFocus}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape" && text !== "") {
            // bb's "Back to app" also listens for Escape; a field with text only clears.
            event.preventDefault();
            event.stopPropagation();
            change("");
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" />
    </label>
  );
}

/** A phone's header has room for two icons: search opens its field in their place, and stays open on the Search page. */
function PhoneHeader({ subPath, syncing, onSync, onClose }: { subPath: string; syncing: boolean; onSync(): void; onClose(): void }) {
  const [open, setOpen] = useState(false);
  const onSearch = routeOf(subPath).view === "search";
  if (open || onSearch) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="min-w-0 flex-1">
          <SearchInput subPath={subPath} placeholder="Search PRs or paste a link" autoFocus />
        </div>
        <button type="button" aria-label="Close search" className={ICON_GHOST} onClick={() => { setOpen(false); if (onSearch) onClose(); }}>
          <Icon name="X" className="size-4" aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" aria-label="Search PRs" title="Search PRs, or look one up" className={ICON_GHOST} onClick={() => setOpen(true)}>
        <Icon name="Search" className="size-4" aria-hidden />
      </button>
      <button type="button" aria-label={syncing ? "Syncing" : "Sync"} title="Sync" className={ICON_GHOST} disabled={syncing} onClick={onSync}>
        <Icon name="ArrowReloadHorizontal" className={`size-4 ${syncing ? "animate-spin" : ""}`} aria-hidden />
      </button>
    </div>
  );
}

export function ShuttleHeader({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const phone = useViewport() === "phone";
  const overview = useShuttleQuery("overview", {});
  const syncMutation = useShuttleMutation("sync");
  const sync = async () => {
    if (await syncMutation.run({})) toast.success("Syncing every server");
  };
  const syncing = syncMutation.isPending || overview.data?.syncing === true;
  const inbox = () => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "inbox", key: null }) });
  if (phone) return <PhoneHeader subPath={subPath} syncing={syncing} onSync={() => void sync()} onClose={inbox} />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="w-56 min-w-0 xl:w-80">
        <SearchInput subPath={subPath} placeholder="Search PRs, or paste a link to look one up" />
      </div>
      <button type="button" className={BUTTON} disabled={syncing} title="Sync every server now" onClick={() => void sync()}>
        <Icon name="ArrowReloadHorizontal" className={`size-3.5 ${syncing ? "animate-spin" : ""}`} aria-hidden />
        {syncing ? "Syncing" : "Sync"}
      </button>
      <UrlLink href={settingsHref(pluginId)} aria-label="Shuttle settings" title="Shuttle settings: opens Shuttle's page in bb's Settings" className={ICON_GHOST}>
        <Icon name="Settings" className="size-4" aria-hidden />
      </UrlLink>
    </div>
  );
}
