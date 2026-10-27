import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  experimental_Icon as Icon,
  useRealtime,
  useRpc,
  useSettings,
  type ExperimentalPluginBrowserToolbarActionProps,
} from "@get-bb/plugin-sdk/app";
import { STATUS_CHANNEL } from "../channel";
import { LINK_HANDLER_OFF, LINK_LEASE_MS, SIGN_IN_FORM_PROBE, linkHandlerExpression, parseOpenMessage } from "../links";
import type { RpcContract, Status } from "../rpc";
import { IDLE, concernsPages, isSignInPage, signInPatterns, step, type Effect, type Episode, type SignInEvent, type SignInMode } from "../signin";
import { ICON_BUTTON, PILL, describeSync, isStatus, readSettings } from "./common";

const HEARTBEAT_MS = 30_000;
const LINK_REFRESH_MS = 2_000;
const PROBE_MS = 1_000;
const TICK_MS = 500;

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The Better Browser controls beside a bb Browser tab's address bar. */
export function BrowserToolbarControl({ threadId, tabId, url, isCompactViewport, experimental_page: page }: ExperimentalPluginBrowserToolbarActionProps) {
  const rpc = useRpc<RpcContract>();
  const settings = readSettings(useSettings().values);
  const patterns = useMemo(() => signInPatterns(settings.signInPages), [settings.signInPages]);
  const [status, setStatus] = useState<Status | null>(null);
  const browserName = status?.browser?.name ?? "your browser";

  useRealtime(STATUS_CHANNEL, (payload) => {
    if (isStatus(payload)) setStatus(payload);
  });

  useEffect(() => {
    let stopped = false;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      rpc.call("heartbeat", { threadId, tabId }).then((next) => !stopped && setStatus(next), () => undefined);
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [rpc, threadId, tabId]);

  const openExternal = useCallback(
    (target: string) => {
      rpc.call("openExternal", { url: target }).then(
        (result) => {
          if (!result.ok) toast.error(result.message);
        },
        (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
      );
    },
    [rpc],
  );

  // Cmd+click: keep the page's handler leased while this toolbar shows; the URL dependency reinstalls it after a navigation.
  useEffect(() => {
    if (!page) return;
    if (!settings.modifierClick) {
      page.evaluate(LINK_HANDLER_OFF).catch(() => undefined);
      return;
    }
    const install = () => page.evaluate(linkHandlerExpression(Date.now() + LINK_LEASE_MS)).catch(() => undefined);
    install();
    const timer = setInterval(install, LINK_REFRESH_MS);
    const unsubscribe = page.onMessage((data) => {
      const target = parseOpenMessage(data);
      if (target) openExternal(target);
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [page, url, settings.modifierClick, openExternal]);

  // Sign-in handoff.
  const hostMatches = isSignInPage(url, patterns);
  const [formVisible, setFormVisible] = useState(false);
  useEffect(() => {
    if (!page || !hostMatches || settings.signIn === "off") {
      setFormVisible(false);
      return;
    }
    let stopped = false;
    const probe = () => page.evaluate(SIGN_IN_FORM_PROBE).then((visible) => !stopped && setFormVisible(visible === true), () => undefined);
    probe();
    const timer = setInterval(probe, PROBE_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [page, hostMatches, url, settings.signIn]);

  const urlRef = useRef(url);
  urlRef.current = url;
  const returnUrl = useRef<string | null>(null);
  useEffect(() => {
    if (isWebUrl(url) && !hostMatches) returnUrl.current = url;
  }, [url, hostMatches]);

  const [episode, setEpisode] = useState<Episode>(IDLE);
  const episodeRef = useRef(episode);
  const mode: SignInMode = settings.signIn;
  const dispatchRef = useRef<(event: SignInEvent) => void>(() => undefined);

  const run = useCallback(
    (effect: Effect) => {
      if (effect.kind === "sync") {
        const before = Date.now();
        rpc.call("sync", { threadId, mode: "full", reason: "sign-in" }).then(
          (next) => {
            setStatus(next);
            const failed = next.error !== null && next.error.at >= before && (next.lastSync === null || next.lastSync.at < next.error.at);
            if (failed) return dispatchRef.current({ type: "syncFailed", now: Date.now() });
            const sync = next.lastSync;
            const fresh = sync !== null && sync.at >= before && concernsPages(sync.hosts, [urlRef.current, returnUrl.current]) ? sync.set + sync.removed : 0;
            dispatchRef.current({ type: "synced", set: fresh, now: Date.now() });
          },
          () => dispatchRef.current({ type: "syncFailed", now: Date.now() }),
        );
      } else if (effect.kind === "reload") {
        const target = returnUrl.current;
        page?.evaluate(target ? `(location.assign(${JSON.stringify(target)}), true)` : "(location.reload(), true)").catch(() => undefined);
      } else {
        openExternal(returnUrl.current ?? urlRef.current);
      }
    },
    [rpc, threadId, page, openExternal],
  );

  const dispatch = useCallback(
    (event: SignInEvent) => {
      const result = step(episodeRef.current, event, mode);
      if (result.episode !== episodeRef.current) {
        episodeRef.current = result.episode;
        setEpisode(result.episode);
      }
      result.effects.forEach(run);
    },
    [mode, run],
  );
  dispatchRef.current = dispatch;

  const onSignInPage = hostMatches && formVisible;
  useEffect(() => {
    dispatchRef.current({ type: "url", onSignInPage, now: Date.now() });
  }, [onSignInPage]);

  const phase = episode.phase.kind;
  const ticking = phase === "settling" || phase === "checking" || phase === "waiting";
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => dispatchRef.current({ type: "tick", now: Date.now() }), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  // While the sign-in finishes in the real browser, each sync that brings cookies for this tab's sites reloads it.
  const lastSyncAt = status?.lastSync?.at ?? 0;
  useEffect(() => {
    const current = episodeRef.current.phase;
    const sync = status?.lastSync;
    if (current.kind !== "waiting" || !sync || sync.at <= current.since || sync.status !== "synced") return;
    if (!concernsPages(sync.hosts, [urlRef.current, returnUrl.current])) return;
    dispatchRef.current({ type: "synced", set: sync.set + sync.removed, now: Date.now() });
  }, [lastSyncAt, status?.lastSync]);

  const syncNow = () => {
    rpc.call("sync", { threadId, mode: "full", reason: "manual" }).then(
      (next) => {
        setStatus(next);
        if (next.error && (next.lastSync === null || next.lastSync.at < next.error.at)) toast.error(next.error.message);
        else if (next.lastSync) toast.success(describeSync(next.lastSync, browserName));
      },
      (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
    );
  };

  const problem = status?.error && (!status.lastSync || status.lastSync.at < status.error.at) ? status.error : null;
  const syncTitle = problem
    ? `Better Browser: ${problem.message}`
    : status?.syncing
      ? `Syncing sessions from ${browserName}…`
      : status?.lastSync
        ? `${describeSync(status.lastSync, browserName)}. Click to sync again.`
        : `Sync sessions from ${browserName}`;

  let pill: ReactNode = null;
  if (phase === "offer" || phase === "stalled") {
    pill = (
      <button type="button" className={PILL} title={`Sign in with ${browserName}, where passkeys and Okta Verify work`} onClick={() => dispatch({ type: "start" })}>
        <Icon name="SecurityCheck" className="size-3.5" aria-hidden />
        {isCompactViewport ? null : phase === "stalled" ? `Try ${browserName} again` : `Sign in with ${browserName}`}
      </button>
    );
  } else if (phase === "settling" || phase === "refreshing" || phase === "checking") {
    pill = (
      <span className={PILL} role="status" title={`Checking ${browserName} for a session`}>
        <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
        {isCompactViewport ? null : `Checking ${browserName}…`}
      </span>
    );
  } else if (phase === "waiting") {
    pill = (
      <span className={PILL} role="status" title={`Finish signing in in ${browserName}. This tab reloads when the new session arrives.`}>
        <Icon name="SecurityCheck" className="size-3.5" aria-hidden />
        {isCompactViewport ? null : `Finish signing in in ${browserName}`}
        <button type="button" aria-label="Stop waiting for the sign-in" className="-mr-1 inline-flex size-4 items-center justify-center rounded hover:bg-state-hover" onClick={() => dispatch({ type: "dismiss" })}>
          <Icon name="X" className="size-3" aria-hidden />
        </button>
      </span>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      {pill}
      <button type="button" className={ICON_BUTTON} aria-label={syncTitle} title={syncTitle} disabled={status?.syncing === true} onClick={syncNow}>
        <Icon
          name={status?.syncing ? "Spinner" : problem ? "AlertTriangle" : "ArrowReloadHorizontal"}
          className={`size-4${status?.syncing ? " animate-spin" : ""}${problem ? " text-amber-500" : ""}`}
          aria-hidden
        />
      </button>
    </div>
  );
}
