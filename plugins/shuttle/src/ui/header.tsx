import { useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, experimental_usePluginId, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { BUTTON, ICON_GHOST } from "./common";
import { PANEL_PATH } from "./constants";
import { useShuttleMutation, useShuttleQuery } from "./data";
import { settingsHref } from "./format";
import { formatRoute } from "./route";
import { useViewport } from "./viewport";

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

/** A phone's header has room for two icons: look-up opens its field in their place. */
function PhoneHeader({ onFound, syncing, onSync }: { onFound(key: string): void; syncing: boolean; onSync(): void }) {
  const [searching, setSearching] = useState(false);
  if (searching) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="min-w-0 flex-1">
          <LookupInput placeholder="Paste a PR link or key" onFound={(key) => { setSearching(false); onFound(key); }} />
        </div>
        <button type="button" aria-label="Close look-up" className={ICON_GHOST} onClick={() => setSearching(false)}>
          <Icon name="X" className="size-4" aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" aria-label="Look up a PR" title="Look up a PR" className={ICON_GHOST} onClick={() => setSearching(true)}>
        <Icon name="Search" className="size-4" aria-hidden />
      </button>
      <button type="button" aria-label={syncing ? "Syncing" : "Sync"} title="Sync" className={ICON_GHOST} disabled={syncing} onClick={onSync}>
        <Icon name="ArrowReloadHorizontal" className={`size-4 ${syncing ? "animate-spin" : ""}`} aria-hidden />
      </button>
    </div>
  );
}

export function ShuttleHeader() {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const phone = useViewport() === "phone";
  const overview = useShuttleQuery("overview", {});
  const syncMutation = useShuttleMutation("sync");
  const sync = async () => {
    if (await syncMutation.run({})) toast.success("Syncing every server");
  };
  const syncing = syncMutation.isPending || overview.data?.syncing === true;
  const showPr = (key: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "pr", key }) });
  if (phone) return <PhoneHeader onFound={showPr} syncing={syncing} onSync={() => void sync()} />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="w-56 min-w-0 xl:w-80">
        <LookupInput placeholder="Look up or track any PR: paste a link" onFound={showPr} />
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
