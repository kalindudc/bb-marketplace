import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { STATUS_CHANNEL } from "../channel";
import type { RpcContract, Status } from "../rpc";
import { BUTTON, ago, isStatus } from "./common";

const HINTS: Partial<Record<NonNullable<Status["error"]>["code"], string>> = {
  keychainPending: "macOS is showing a Keychain prompt. Choose Always Allow so later syncs run without asking.",
  keychainDenied: "Press Sync now and choose Always Allow in the Keychain prompt.",
  noBrowserTab: "Open any page in a bb Browser tab; the sync runs through it.",
  noDesktop: "Sessions sync into the Browser of the bb desktop app, so open the app on this computer.",
  noProfile: "Set a profile override above, or clear it to use the last-used profile.",
};

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SettingsSection() {
  const rpc = useRpc<RpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    rpc.call("status", null).then(
      (next) => {
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

  const syncNow = () => {
    setBusy(true);
    rpc.call("sync", { mode: "full", reason: "manual" }).then(setStatus, (error: unknown) => toast.error(message(error))).finally(() => setBusy(false));
  };

  if (loadError) return <p className="text-sm text-muted-foreground">Better Browser could not reach the bb app: {loadError}</p>;
  if (!status) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon name="Spinner" className="size-4 animate-spin" aria-hidden /> Checking connection…
      </p>
    );
  }

  const problem = status.error && (!status.lastSync || status.lastSync.at < status.error.at) ? status.error : null;

  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-2 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <Icon name="Globe" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 font-medium">
            {status.browser?.name ?? "No supported browser found"}
            {status.profile ? <span className="font-normal text-muted-foreground"> · {status.profile}</span> : null}
          </p>
          <button type="button" className={BUTTON} disabled={busy || status.syncing || !status.supported || status.browser?.syncable !== true} onClick={syncNow}>
            <Icon name={status.syncing ? "Spinner" : "ArrowReloadHorizontal"} className={`size-3.5${status.syncing ? " animate-spin" : ""}`} aria-hidden />
            Sync now
          </button>
        </div>
        <p className="text-muted-foreground">
          {status.syncing ? "Syncing sessions…" : status.lastSync ? `${status.lastSync.status === "synced" ? "Last synced" : "Checked"} ${ago(status.lastSync.at)}.` : "Not synced yet."}
        </p>
        {!status.supported ? <p className="text-muted-foreground">Session sync requires macOS or Linux.</p> : status.browser?.syncable === false ? <p className="text-muted-foreground">This browser can open links, but its sessions cannot be synced.</p> : null}
        {status.lastSync && status.lastSync.undecryptable > 0 ? <p role="status">{status.lastSync.undecryptable} cookies could not be read; some sites may remain signed out.</p> : null}
        {problem ? (
          <p className="flex gap-2 text-foreground">
            <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
            <span>{problem.message} ({ago(problem.at)}). {HINTS[problem.code] ?? ""}</span>
          </p>
        ) : null}
      </div>

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Session access</summary>
        <p className="mt-2">
          {isMac
            ? 'The first Chromium sync asks macOS for the browser’s "Safe Storage" key. Choose Always Allow to avoid repeated Keychain prompts.'
            : 'On Linux, cookie values are read with the browser’s "Safe Storage" secret from the Secret Service or KWallet, or its basic password store.'}
          {" "}Cookie values stay on this computer; the plugin remembers only hashes of what it synced.
        </p>
      </details>
    </div>
  );
}
