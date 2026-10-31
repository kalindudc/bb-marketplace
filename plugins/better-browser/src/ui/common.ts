import { DISTRIBUTION_DEFAULTS } from "../distribution";
import type { Status, SyncSummary } from "../rpc";
import type { SignInMode } from "../signin";

export const ICON_BUTTON =
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60";
export const PILL =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-2 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
export const BUTTON =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";

export interface UiSettings {
  signIn: SignInMode;
  signInPages: string;
  gatewayPages: string;
  modifierClick: boolean;
  sync: boolean;
}

/** Settings values arrive untyped from the host; anything unexpected reads as the default. */
export function readSettings(values: Record<string, unknown> | undefined): UiSettings {
  const signIn = values?.signIn;
  return {
    signIn: signIn === "ask" || signIn === "off" ? signIn : "automatic",
    signInPages: typeof values?.signInPages === "string" ? values.signInPages : "",
    gatewayPages: typeof values?.gatewayPages === "string" ? values.gatewayPages : DISTRIBUTION_DEFAULTS.gatewayPages,
    modifierClick: values?.modifierClick !== false,
    sync: values?.sync !== false,
  };
}

export function isStatus(value: unknown): value is Status {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Status>;
  return typeof candidate.supported === "boolean" && typeof candidate.syncing === "boolean" && "lastSync" in candidate && "error" in candidate;
}

export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

export function describeSync(sync: SyncSummary, browserName: string, now = Date.now()): string {
  if (sync.status === "unchanged") return `Sessions match ${browserName} (checked ${ago(sync.at, now)})`;
  const changes = sync.set + sync.removed;
  const what = changes === 0 ? "nothing new" : [sync.set ? `${sync.set} updated` : "", sync.removed ? `${sync.removed} removed` : ""].filter(Boolean).join(", ");
  return `Synced from ${browserName} ${ago(sync.at, now)}: ${what}`;
}
