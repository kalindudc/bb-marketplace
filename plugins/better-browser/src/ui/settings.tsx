import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, useRealtime, useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { STATUS_CHANNEL } from "../channel";
import type { RpcContract, Status } from "../rpc";
import { BUTTON, ago, describeSync, isStatus } from "./common";

type BrowserList = PluginRpcResult<RpcContract["browsers"]>;

const HINTS: Partial<Record<NonNullable<Status["error"]>["code"], string>> = {
  keychainPending: "macOS is showing a Keychain prompt. Choose Always Allow so later syncs run without asking.",
  keychainDenied: "Press Sync now and choose Always Allow in the Keychain prompt.",
  noBrowserTab: "Open any page in a bb Browser tab; the sync runs through it.",
  noDesktop: "Sessions sync into the Browser of the bb desktop app, so open the app on this computer.",
  noProfile: "Choose a profile below.",
};

/** True when this bb app runs on macOS, which names the Keychain in the hints and the note below. */
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SettingsSection() {
  const rpc = useRpc<RpcContract>();
  const [list, setList] = useState<BrowserList | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([rpc.call("browsers", null), rpc.call("status", null)]).then(
      ([browsers, next]) => {
        setList(browsers);
        setStatus(next);
        setLoadError(null);
      },
      (error: unknown) => setLoadError(message(error)),
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(STATUS_CHANNEL, (payload) => {
    if (isStatus(payload)) setStatus(payload);
  });

  const choose = (browserId: string, profile: string) => {
    setBusy(true);
    rpc.call("choose", { browserId, profile }).then(
      (next) => {
        setStatus(next);
        setList((current) => (current ? { ...current, chosen: { browser: browserId, profile } } : current));
      },
      (error: unknown) => toast.error(message(error)),
    ).finally(() => setBusy(false));
  };

  const syncNow = () => {
    setBusy(true);
    rpc.call("sync", { mode: "full", reason: "manual" }).then(setStatus, (error: unknown) => toast.error(message(error))).finally(() => setBusy(false));
  };

  if (loadError) return <p className="text-sm text-muted-foreground">Better Browser could not reach the bb app: {loadError}</p>;
  if (!list || !status) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon name="Spinner" className="size-4 animate-spin" aria-hidden /> Looking for browsers…
      </p>
    );
  }

  const installed = list.browsers.filter((browser) => browser.installed);
  const fallback = installed.find((browser) => browser.id === list.defaultBrowserId);
  const chosenId = list.chosen.browser;
  const active = installed.find((browser) => browser.id === (status.browser?.id ?? chosenId));
  const problem = status.error && (!status.lastSync || status.lastSync.at < status.error.at) ? status.error : null;
  const browserName = status.browser?.name ?? "your browser";

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-2 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <Icon name="Globe" className="size-4 text-muted-foreground" aria-hidden />
          <span className="flex-1 font-medium">
            {status.browser ? `Following ${status.browser.name}` : "No supported browser found"}
            {status.profile && active ? ` · ${active.profiles.find((profile) => profile.directory === status.profile)?.name ?? status.profile}` : ""}
          </span>
          <button type="button" className={BUTTON} disabled={busy || status.syncing || !status.supported} onClick={syncNow}>
            <Icon name={status.syncing ? "Spinner" : "ArrowReloadHorizontal"} className={`size-3.5${status.syncing ? " animate-spin" : ""}`} aria-hidden />
            Sync now
          </button>
        </div>
        {!status.supported ? <p className="text-muted-foreground">Session sync works on macOS and Linux for now. Ctrl+click still opens links in your browser.</p> : null}
        {status.lastSync ? <p className="text-muted-foreground">{describeSync(status.lastSync, browserName)}. {status.lastSync.cookies} cookies in the profile{status.lastSync.undecryptable ? `, ${status.lastSync.undecryptable} unreadable` : ""}.</p> : null}
        {problem ? (
          <p className="flex gap-2 text-foreground">
            <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
            <span>
              {problem.message} ({ago(problem.at)}). {HINTS[problem.code] ?? ""}
            </span>
          </p>
        ) : null}
      </div>

      <fieldset className="space-y-1.5" disabled={busy}>
        <legend className="mb-1 font-medium">Browser and profile</legend>
        <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-state-hover">
          <input type="radio" name="better-browser-browser" checked={chosenId === ""} onChange={() => choose("", "")} />
          <span className="flex-1">Your default browser{fallback ? ` (${fallback.name})` : ""}</span>
        </label>
        {installed.map((browser) => {
          const selected = chosenId === browser.id;
          return (
            <div key={browser.id} className="rounded-md px-2 py-1.5 hover:bg-state-hover">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="better-browser-browser" checked={selected} onChange={() => choose(browser.id, "")} />
                <span className="flex-1">
                  {browser.name}
                  {browser.id === list.defaultBrowserId ? <span className="ml-1.5 text-xs text-muted-foreground">default</span> : null}
                </span>
                {!browser.syncable ? <span className="text-xs text-muted-foreground">opens links; sessions do not sync yet</span> : null}
                {browser.syncable && browser.profiles.length === 0 ? <span className="text-xs text-muted-foreground">no profile with cookies yet</span> : null}
              </label>
              {selected && browser.profiles.length > 0 ? (
                <select
                  aria-label={`${browser.name} profile`}
                  className="ml-6 mt-1.5 rounded-md border border-border bg-background px-2 py-1 text-sm"
                  value={list.chosen.profile}
                  onChange={(event) => choose(browser.id, event.target.value)}
                >
                  <option value="">The profile {browser.name} used last</option>
                  {browser.profiles.map((profile) => (
                    <option key={profile.directory} value={profile.directory}>
                      {profile.name}{profile.account ? ` (${profile.account})` : ""}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          );
        })}
      </fieldset>

      <p className="text-xs text-muted-foreground">
        {isMac
          ? 'The first sync from a Chromium browser asks macOS for its "Safe Storage" key in the Keychain. Choose Always Allow so later syncs run without asking.'
          : "On Linux, cookie values are read with the browser's \"Safe Storage\" secret from the Secret Service or KWallet, falling back to the basic password store."}
        {" "}Cookie values stay on this computer; the plugin keeps only hashes of what it synced.
      </p>
    </div>
  );
}
