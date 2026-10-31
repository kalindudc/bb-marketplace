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
import {
  IDLE, concernsPages, gatewayReturnUrl, isSignInPage, pagePatterns, signInPatterns, type Effect, type Episode, type SignInEvent, type SignInMode,
} from "../signin";
import { ICON_BUTTON, PILL, describeSync, isStatus, readSettings } from "./common";

const HEARTBEAT_MS = 30_000;
const LINK_REFRESH_MS = 2_000;
const PROBE_MS = 1_000;
const TICK_MS = 500;

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The host a sync may mirror; the RPC accepts plain DNS names only. */
function mirrorHost(url: string | null): string | null {
  if (!url) return null;
  const host = new URL(url).hostname;
  return /^[a-z0-9.-]+$/.test(host) ? host : null;
}

/** The Better Browser controls beside a bb Browser tab's address bar. */
export function BrowserToolbarControl({ threadId, tabId, url, isCompactViewport, experimental_page: page }: ExperimentalPluginBrowserToolbarActionProps) {
  const rpc = useRpc<RpcContract>();
  const settings = readSettings(useSettings().values);
  const patterns = useMemo(() => signInPatterns(settings.signInPages), [settings.signInPages]);
  const gatewayPatterns = useMemo(() => pagePatterns(settings.gatewayPages), [settings.gatewayPages]);
  const [status, setStatus] = useState<Status | null>(null);
  const browserName = status?.browser?.name ?? "your browser";

  useRealtime(STATUS_CHANNEL, (payload) => {
    if (isStatus(payload)) setStatus(payload);
  });

  useEffect(() => {
    let stopped = false;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      // Focus tells the plugin whether this Browser tab is the one on screen: a background sync leases it, and leasing a
      // tab the user is not looking at makes bb switch the side panel to the Browser.
      const focused = page ? page.evaluate("document.hasFocus()").then((value) => value === true, () => true) : Promise.resolve(true);
      void focused.then((isFocused) => rpc.call("heartbeat", { threadId, tabId, focused: isFocused }).then((next) => !stopped && setStatus(next), () => undefined));
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
      // The tab is going away (another panel tab took the panel): stop counting it as focused at once, so no background
      // sync leases a tab the user cannot see.
      rpc.call("heartbeat", { threadId, tabId, focused: false }).catch(() => undefined);
    };
  }, [rpc, threadId, tabId, page]);

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

  // Sign-in handoff. An access gateway's page counts as a sign-in page, and the application it names as its return
  // address is where this tab goes back to and what opens in the real browser. A gateway page that names none is left
  // alone: the only other thing to open would be the gateway URL, with bb's pending request in it.
  const handoffPatterns = useMemo(() => [...patterns, ...gatewayPatterns], [patterns, gatewayPatterns]);
  const onGatewayPage = isSignInPage(url, gatewayPatterns);
  const gatewayTarget = useMemo(() => (onGatewayPage ? gatewayReturnUrl(url, handoffPatterns) : null), [onGatewayPage, url, handoffPatterns]);
  const onGateway = gatewayTarget !== null;
  const hostMatches = onGatewayPage || isSignInPage(url, patterns);
  const pageKindRef = useRef<boolean | undefined>(undefined);
  pageKindRef.current = onGateway ? true : hostMatches ? false : undefined;
  const dispatchRef = useRef<(event: SignInEvent) => void>(() => undefined);
  useEffect(() => {
    if (!hostMatches || settings.signIn === "off") {
      if (!hostMatches && isWebUrl(url)) returnUrl.current = url;
      dispatchRef.current({ type: "url", onSignInPage: false, now: Date.now() });
      return;
    }
    if (!page) return;
    if (onGateway) {
      // The gateway's page is the obstacle itself: there is no form to wait for.
      if (gatewayTarget) returnUrl.current = gatewayTarget;
      dispatchRef.current({ type: "url", onSignInPage: true, now: Date.now() });
      return;
    }
    let stopped = false;
    const probe = () => page.evaluate(SIGN_IN_FORM_PROBE).then((visible) => {
      if (!stopped && (visible === true || visible === false || visible === null)) {
        dispatchRef.current({ type: "form", visible, now: Date.now() });
      }
    }, () => undefined);
    probe();
    const timer = setInterval(probe, PROBE_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [page, hostMatches, onGateway, gatewayTarget, url, settings.signIn]);

  const urlRef = useRef(url);
  urlRef.current = url;
  const returnUrl = useRef<string | null>(null);

  const [episode, setEpisode] = useState<Episode>(IDLE);
  const episodeRef = useRef(episode);
  const [gatewayEpisode, setGatewayEpisode] = useState(false);
  const gatewayEpisodeRef = useRef(false);
  /** The application the user approved with Continue; a gateway handoff opens nothing else. */
  const consentUrlRef = useRef<string | null>(null);
  /** When the phase last changed, so only a sync that arrives later can move a resting handoff on. */
  const phaseSinceRef = useRef(0);
  const mode: SignInMode = settings.signIn;
  /** What a gateway handoff opens: the application, never a sign-in or gateway page. */
  const gatewayOpenUrl = () => {
    const target = returnUrl.current;
    return target && !isSignInPage(target, handoffPatterns) ? target : null;
  };

  const run = useCallback(
    (effect: Effect) => {
      if (effect.kind === "sync") {
        const before = Date.now();
        // A gateway's site keeps only the real browser's cookies, so a request id left by bb's own failed attempt cannot
        // make the site ignore the session that arrives.
        const mirror = gatewayEpisodeRef.current ? mirrorHost(gatewayOpenUrl()) : null;
        rpc.call("sync", { threadId, mode: "full", reason: "sign-in", ...(mirror ? { mirrorHosts: [mirror] } : {}) }).then(
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
        // The page may have steered this tab to a sign-in URL to make the real browser open something of its choosing,
        // so open the sign-in page itself; after sign-in the bb tab reloads to the application on its own. A gateway's
        // application opens instead, and only the one named by the button the user pressed: the tab may have moved to
        // another gateway since. The gateway URL never opens: it can carry bb's request id, and the real browser
        // finishing bb's pending request is what gateways treat as a stolen one.
        if (!gatewayEpisodeRef.current) return openExternal(urlRef.current);
        const target = consentUrlRef.current;
        if (target && !isSignInPage(target, handoffPatterns)) openExternal(target);
      }
    },
    [rpc, threadId, page, openExternal, handoffPatterns],
  );

  const dispatch = useCallback(
    (event: SignInEvent, consentUrl?: string | null) => {
      const gateway = pageKindRef.current;
      rpc.call("handoff", {
        threadId, tabId, event, mode, targetUrl: returnUrl.current, ...(gateway === undefined ? {} : { gateway }), ...(consentUrl ? { consentUrl } : {}),
      }).then(
        (result) => {
          consentUrlRef.current = result.consentUrl;
          if (result.episode.phase.kind !== episodeRef.current.phase.kind) phaseSinceRef.current = Date.now();
          episodeRef.current = result.episode;
          gatewayEpisodeRef.current = result.gateway;
          setEpisode(result.episode);
          setGatewayEpisode(result.gateway);
          if (returnUrl.current === null) returnUrl.current = result.targetUrl;
          result.effects.forEach(run);
        },
        (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
      );
    },
    [mode, run, rpc, threadId, tabId],
  );
  dispatchRef.current = dispatch;

  const phase = episode.phase.kind;
  const ticking = phase !== "idle";
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => dispatchRef.current({ type: "tick", now: Date.now() }), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  // While the sign-in finishes in the real browser, each sync that brings cookies for this tab's sites reloads it. A
  // gateway's handoff also follows them while its button shows, since the real browser may sign in without Continue.
  const lastSyncAt = status?.lastSync?.at ?? 0;
  useEffect(() => {
    const current = episodeRef.current.phase;
    const sync = status?.lastSync;
    const resting = current.kind === "waiting" || (gatewayEpisodeRef.current && (current.kind === "offer" || current.kind === "stalled"));
    const since = current.kind === "waiting" ? current.since : phaseSinceRef.current;
    if (!resting || !sync || sync.at <= since || sync.status !== "synced") return;
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
    const target = gatewayEpisode ? gatewayOpenUrl() : null;
    const title = gatewayEpisode
      ? `Open ${target ? new URL(target).host : "the application"} in ${browserName}, which passes this access check. This tab follows once the new session arrives.`
      : `Sign in with ${browserName}, where passkeys and Okta Verify work`;
    pill = (
      <button type="button" className={PILL} title={title} onClick={() => dispatch({ type: "start", now: Date.now() }, target)}>
        <Icon name="SecurityCheck" className="size-3.5" aria-hidden />
        {isCompactViewport ? null : phase === "stalled" ? `Try ${browserName} again` : gatewayEpisode ? `Continue in ${browserName}` : `Sign in with ${browserName}`}
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
