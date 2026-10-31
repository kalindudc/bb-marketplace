/** Sign-in pages that need the real browser for passkeys, Okta Verify, device trust or a security key. */
export const DEFAULT_SIGN_IN_PAGES: readonly string[] = [
  "*.okta.com",
  "*.oktapreview.com",
  "*.okta-emea.com",
  "*.okta-gov.com",
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.live.com",
  "accounts.google.com",
  "*.auth0.com",
  "*.onelogin.com",
  "*.duosecurity.com",
  "*.pingone.com",
  "*.pingidentity.com",
  "github.com/login",
  "github.com/session",
];

export interface SignInPattern {
  host: string;
  /** `*.example.com` matches example.com and every subdomain. */
  subdomains: boolean;
  /** A path prefix; empty matches every path. */
  path: string;
}

export function parsePattern(line: string): SignInPattern | null {
  let text = line.trim().toLowerCase();
  if (!text || text.startsWith("#")) return null;
  text = text.replace(/^[a-z]+:\/\//, "");
  const slash = text.indexOf("/");
  const hostPart = slash === -1 ? text : text.slice(0, slash);
  const path = slash === -1 ? "" : text.slice(slash).replace(/\/+$/, "");
  const subdomains = hostPart.startsWith("*.");
  const host = subdomains ? hostPart.slice(2) : hostPart;
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || host.startsWith(".") || host.endsWith(".")) return null;
  return { host, subdomains, path };
}

/** One pattern per line; `#` starts a comment. */
export function pagePatterns(text: string): SignInPattern[] {
  return text.split(/\r?\n/).map(parsePattern).filter((pattern): pattern is SignInPattern => pattern !== null);
}

/** The default pages plus the user's extra lines. */
export function signInPatterns(extra: string): SignInPattern[] {
  return [...pagePatterns(DEFAULT_SIGN_IN_PAGES.join("\n")), ...pagePatterns(extra)];
}

/**
 * Query parameters an access gateway names the protected page in: `rd` is the forward-auth convention (oauth2-proxy,
 * Authelia, Traefik), the others are common spellings. OAuth's `redirect_uri` is left out on purpose: it names the
 * client's callback, which fails without the code the sign-in would add.
 */
const RETURN_PARAMETERS = ["rd", "redirect_url", "return_to", "returnTo", "return_url"] as const;

/**
 * The page an access gateway sends the browser back to once it lets it through: an absolute http(s) URL in one of the
 * return parameters, other than another gateway or sign-in page. Null when the gateway names none.
 */
export function gatewayReturnUrl(url: string, avoid: readonly SignInPattern[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const name of RETURN_PARAMETERS) {
    const value = parsed.searchParams.get(name);
    if (!value) continue;
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      continue;
    }
    if ((target.protocol === "https:" || target.protocol === "http:") && !target.username && !target.password && !isSignInPage(target.href, avoid)) {
      return target.href;
    }
  }
  return null;
}

export function isSignInPage(url: string, patterns: readonly SignInPattern[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.host.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  return patterns.some((pattern) => {
    const hostMatches = host === pattern.host || (pattern.subdomains && host.endsWith(`.${pattern.host}`));
    return hostMatches && (pattern.path === "" || path.startsWith(pattern.path));
  });
}

export type SignInMode = "automatic" | "ask" | "off";

/** The host list a sync reports is cut at this length, so a full list may leave out the page's own site. */
export const HOST_LIST_LIMIT = 100;

/**
 * Whether a sync that changed cookies for `changed` sites can matter to a tab showing `pages`: a cookie for a site,
 * its parent domain or one of its subdomains. A cut-off list counts as relevant, since the missing sites are unknown.
 */
export function concernsPages(changed: readonly string[], pages: readonly (string | null)[]): boolean {
  if (changed.length >= HOST_LIST_LIMIT) return true;
  const hosts = pages.flatMap((page) => {
    if (!page) return [];
    try {
      return [new URL(page).hostname.toLowerCase()];
    } catch {
      return [];
    }
  });
  return changed.some((site) => hosts.some((host) => host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`)));
}

/** How long a tab sits on a sign-in page before the plugin acts; SSO redirects pass through faster than this. */
export const SETTLE_MS = 2_500;
/** How long the plugin waits for the real browser's new session before it gives up. */
export const WAIT_LIMIT_MS = 5 * 60_000;

export type Phase =
  | { kind: "idle" }
  /** On a sign-in page, waiting to see whether it redirects away by itself. */
  | { kind: "settling"; since: number }
  /** "Ask" mode: the toolbar offers to finish signing in in the real browser. */
  | { kind: "offer" }
  /** Pulling the real browser's current sessions into bb before anything else. */
  | { kind: "refreshing"; since: number }
  /** Reloaded with fresh sessions; watching whether the sign-in page goes away. */
  | { kind: "checking"; since: number }
  /** The page is open in the real browser; waiting for its new session to reach bb. */
  | { kind: "waiting"; since: number }
  /** Gave up waiting; the toolbar offers to try again. */
  | { kind: "stalled" };

export interface Episode {
  phase: Phase;
  /** True once this sign-in has been opened in the real browser, so it is opened at most once. */
  opened: boolean;
  /** True once the user pressed the toolbar's button in this episode, which an access gateway needs before it opens. */
  consented: boolean;
  /**
   * True while a gateway's refresh runs because a sync already brought the app's cookies, so the tab retries the app
   * afterwards even when the refresh itself finds nothing more to change.
   */
  arrived: boolean;
  formVisible: boolean | null;
  absentSince: number | null;
}

export type Effect = { kind: "sync" } | { kind: "reload" } | { kind: "open" };

export type SignInEvent =
  | { type: "url"; onSignInPage: boolean; now: number }
  | { type: "form"; visible: boolean | null; now: number }
  | { type: "tick"; now: number }
  | { type: "synced"; set: number; now: number }
  | { type: "syncFailed"; now: number }
  | { type: "start"; now: number }
  /** The user stopped waiting; the toolbar keeps a button to start again. */
  | { type: "dismiss" };

export const IDLE: Episode = { phase: { kind: "idle" }, opened: false, consented: false, arrived: false, formVisible: null, absentSince: null };

/**
 * The sign-in handoff for one Browser tab, as a pure step function. A tab that stays on a sign-in page first gets the
 * real browser's current sessions and a reload, which is enough when the real browser is already signed in. If the page
 * is still there, it opens in the real browser, and each sync that brings new cookies reloads the bb tab until the
 * sign-in page is gone.
 *
 * An access gateway (`gateway`) opens the page it names as its return address, which the page in the tab chose, so the
 * real browser opens it only after the user presses the toolbar's button; the session refresh before that still runs
 * on its own. Because a gateway turns bb away until the app's session reaches bb, by Continue or any other sign-in in
 * the real browser, a sync that brings cookies for the tab's sites refreshes and retries while the button shows too.
 *
 * Leaving the page ends the handoff only after SETTLE_MS away, because each retry's redirect passes back through the
 * application on its way to the sign-in page again.
 */
export function step(episode: Episode, event: SignInEvent, mode: SignInMode, gateway = false): { episode: Episode; effects: Effect[] } {
  const { phase } = episode;
  const to = (next: Phase, effects: Effect[] = [], changes: Partial<Omit<Episode, "phase">> = {}) => ({
    episode: next.kind === "idle" ? IDLE : { ...episode, phase: next, ...changes },
    effects,
  });
  const stay = { episode, effects: [] as Effect[] };
  const handOff = (now: number) => {
    if (episode.opened) return to({ kind: "waiting", since: now });
    if (gateway && !episode.consented) return to({ kind: "offer" });
    return to({ kind: "waiting", since: now }, [{ kind: "open" }], { opened: true });
  };
  switch (event.type) {
    case "url":
      if (mode === "off") return to({ kind: "idle" });
      if (!event.onSignInPage) {
        if (phase.kind === "idle" || episode.absentSince !== null) return stay;
        return to(phase, [], { formVisible: false, absentSince: event.now });
      }
      if (phase.kind !== "idle") {
        return episode.formVisible === true ? stay : to(phase, [], { formVisible: true, absentSince: null });
      }
      return to(mode === "ask" ? { kind: "offer" } : { kind: "settling", since: event.now }, [], { formVisible: true });
    case "form":
      if (mode === "off") return to({ kind: "idle" });
      if (event.visible === true) return step(episode, { type: "url", onSignInPage: true, now: event.now }, mode);
      if (phase.kind === "idle" || episode.formVisible === event.visible) return stay;
      return to(phase, [], { formVisible: event.visible, absentSince: event.visible === false ? event.now : null });
    case "dismiss":
      return phase.kind === "idle" ? stay : to({ kind: "offer" }, [], { opened: false, consented: false });
    case "start":
      if (phase.kind === "refreshing") return stay;
      return to({ kind: "refreshing", since: event.now }, [{ kind: "sync" }], { opened: false, consented: true, arrived: false });
    case "tick":
      if ((phase.kind === "waiting" || phase.kind === "refreshing") && event.now - phase.since >= WAIT_LIMIT_MS) return to({ kind: "stalled" });
      if (episode.formVisible === null) return stay;
      if (episode.absentSince !== null) {
        return event.now - episode.absentSince >= SETTLE_MS ? to({ kind: "idle" }) : stay;
      }
      if (phase.kind === "settling" && event.now - phase.since >= SETTLE_MS) return to({ kind: "refreshing", since: event.now }, [{ kind: "sync" }]);
      if (phase.kind === "checking" && event.now - phase.since >= SETTLE_MS) return handOff(event.now);
      return stay;
    case "synced":
      if (phase.kind === "refreshing") {
        if (event.set > 0 || episode.arrived) return to({ kind: "checking", since: event.now }, [{ kind: "reload" }], { arrived: false });
        if (episode.formVisible !== true) return to({ kind: "checking", since: event.now });
        return handOff(event.now);
      }
      if (gateway && event.set > 0 && (phase.kind === "offer" || phase.kind === "waiting" || phase.kind === "stalled")) {
        return to({ kind: "refreshing", since: event.now }, [{ kind: "sync" }], { arrived: true });
      }
      if (phase.kind === "waiting" && event.set > 0) return to({ kind: "checking", since: event.now }, [{ kind: "reload" }]);
      return stay;
    case "syncFailed":
      if (phase.kind !== "refreshing") return stay;
      if (episode.arrived) return to({ kind: "checking", since: event.now }, [{ kind: "reload" }], { arrived: false });
      if (episode.formVisible !== true) return to({ kind: "checking", since: event.now });
      return handOff(event.now);
  }
}
