import { useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, experimental_usePluginId, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ServerStatus } from "../contract";
import { BUTTON, ICON_GHOST, Pill } from "./common";
import { PANEL_PATH } from "./constants";
import { messageOf, useShuttleMutation, useShuttleQuery } from "./data";
import { ago, settingsHref } from "./format";
import { formatRoute } from "./route";

function Health({ server }: { server: ServerStatus }) {
  if (server.ok === null) return <Pill icon="Circle" title="Not synced yet">{server.name}</Pill>;
  if (server.ok) return <Pill tone="ok" icon="Circle" title={server.login ? `Signed in as ${server.login}` : "Synced"}>{server.name}</Pill>;
  return <Pill tone="bad" icon="AlertTriangle" title={server.error ?? "The last sync failed"}>{server.name}</Pill>;
}

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

export function ShuttleHeader() {
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const overview = useShuttleQuery("overview", {});
  const syncMutation = useShuttleMutation("sync");
  const sync = async () => {
    if (await syncMutation.run({})) toast.success("Syncing every server");
  };
  const servers = overview.data?.servers.filter((server) => server.enabled) ?? [];
  const syncing = syncMutation.isPending || overview.data?.syncing === true;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="hidden items-center gap-1.5 lg:flex">
        {servers.map((server) => <Health key={server.id} server={server} />)}
        {overview.data?.paused === true && <Pill tone="warn" icon="Pause">Paused</Pill>}
        {overview.error !== null && <Pill tone="bad" icon="AlertTriangle" title={messageOf(overview.error)}>Status unavailable</Pill>}
      </div>
      <div className="w-56 min-w-0 xl:w-80">
        <LookupInput placeholder="Look up any PR: paste a link or key"
          onFound={(key) => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "pr", key }) })} />
      </div>
      {overview.data?.syncedAt != null && (
        <span className="hidden whitespace-nowrap text-xs text-muted-foreground md:inline" title={new Date(overview.data.syncedAt).toLocaleString()}>
          synced {ago(overview.data.syncedAt)}
        </span>
      )}
      <button type="button" className={BUTTON} disabled={syncing} onClick={() => void sync()}>
        <Icon name="ArrowReloadHorizontal" className={`size-3.5 ${syncing ? "animate-spin" : ""}`} aria-hidden />
        {syncing ? "Syncing" : "Sync"}
      </button>
      <UrlLink href={settingsHref(pluginId)} aria-label="Shuttle settings" title="Shuttle settings: opens Shuttle's page in bb's Settings" className={ICON_GHOST}>
        <Icon name="Settings" className="size-4" aria-hidden />
      </UrlLink>
    </div>
  );
}
