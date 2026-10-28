import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type Engine = "chromium" | "firefox" | "safari";

/** How a browser is found on Linux: data under $HOME, executables on PATH, and the .desktop file xdg-settings names. */
export interface LinuxDefinition {
  /** Path segments under $HOME, such as [".config", "google-chrome"]. */
  directory?: readonly string[];
  /** Executables that open the browser, tried in order. */
  binaries?: readonly string[];
  desktopIds?: readonly string[];
  /** The libsecret "application" attribute the browser stores its Safe Storage password under. */
  keyringApps?: readonly string[];
}

export interface BrowserDefinition {
  id: string;
  name: string;
  engine: Engine;
  bundleId: string;
  appNames: readonly string[];
  /** Under ~/Library/Application Support; absent for a browser bb can only open links in. */
  dataSegments?: readonly string[];
  keychainService?: string;
  keychainAccount?: string;
  /** Chrome-style browsers honour --profile-directory when relaunched, so links open in the synced profile. */
  profileArgument?: boolean;
  /** Linux support; absent for a browser Linux cannot install or bb cannot follow there. */
  linux?: LinuxDefinition;
}

function chromium(input: Omit<BrowserDefinition, "engine">): BrowserDefinition {
  return { ...input, engine: "chromium" };
}

export const BROWSERS: readonly BrowserDefinition[] = [
  chromium({
    id: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", appNames: ["Google Chrome.app"],
    dataSegments: ["Google", "Chrome"], keychainService: "Chrome Safe Storage", keychainAccount: "Chrome", profileArgument: true,
    linux: { directory: [".config", "google-chrome"], binaries: ["google-chrome", "google-chrome-stable"], desktopIds: ["google-chrome.desktop"], keyringApps: ["chrome"] },
  }),
  chromium({
    id: "chromium", name: "Chromium", bundleId: "org.chromium.Chromium", appNames: ["Chromium.app"],
    dataSegments: ["Chromium"], keychainService: "Chromium Safe Storage", keychainAccount: "Chromium", profileArgument: true,
    linux: { directory: [".config", "chromium"], binaries: ["chromium", "chromium-browser"], desktopIds: ["chromium.desktop", "chromium-browser.desktop"], keyringApps: ["chromium"] },
  }),
  chromium({
    id: "arc", name: "Arc", bundleId: "company.thebrowser.Browser", appNames: ["Arc.app"],
    dataSegments: ["Arc", "User Data"], keychainService: "Arc Safe Storage", keychainAccount: "Arc",
  }),
  chromium({
    id: "dia", name: "Dia", bundleId: "company.thebrowser.dia", appNames: ["Dia.app"],
    dataSegments: ["Dia", "User Data"], keychainService: "Dia Safe Storage", keychainAccount: "Dia",
  }),
  chromium({
    id: "brave", name: "Brave", bundleId: "com.brave.Browser", appNames: ["Brave Browser.app"],
    dataSegments: ["BraveSoftware", "Brave-Browser"], keychainService: "Brave Safe Storage", keychainAccount: "Brave", profileArgument: true,
    linux: { directory: [".config", "BraveSoftware", "Brave-Browser"], binaries: ["brave-browser", "brave-browser-stable"], desktopIds: ["brave-browser.desktop"], keyringApps: ["brave"] },
  }),
  chromium({
    id: "edge", name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", appNames: ["Microsoft Edge.app"],
    dataSegments: ["Microsoft Edge"], keychainService: "Microsoft Edge Safe Storage", keychainAccount: "Microsoft Edge", profileArgument: true,
    linux: { directory: [".config", "microsoft-edge"], binaries: ["microsoft-edge", "microsoft-edge-stable"], desktopIds: ["microsoft-edge.desktop"], keyringApps: ["microsoft-edge"] },
  }),
  chromium({
    id: "vivaldi", name: "Vivaldi", bundleId: "com.vivaldi.Vivaldi", appNames: ["Vivaldi.app"],
    dataSegments: ["Vivaldi"], keychainService: "Vivaldi Safe Storage", keychainAccount: "Vivaldi", profileArgument: true,
    linux: { directory: [".config", "vivaldi"], binaries: ["vivaldi", "vivaldi-stable"], desktopIds: ["vivaldi-stable.desktop", "vivaldi.desktop"], keyringApps: ["vivaldi-stable", "vivaldi"] },
  }),
  chromium({
    id: "opera", name: "Opera", bundleId: "com.operasoftware.Opera", appNames: ["Opera.app"],
    dataSegments: ["com.operasoftware.Opera"], keychainService: "Opera Safe Storage", keychainAccount: "Opera",
    linux: { directory: [".config", "opera"], binaries: ["opera"], desktopIds: ["opera.desktop"], keyringApps: ["opera"] },
  }),
  chromium({
    id: "helium", name: "Helium", bundleId: "net.imput.helium", appNames: ["Helium.app"],
    dataSegments: ["net.imput.helium"], keychainService: "Helium Storage Key", keychainAccount: "Helium",
  }),
  {
    id: "firefox", name: "Firefox", engine: "firefox", bundleId: "org.mozilla.firefox", appNames: ["Firefox.app"],
    dataSegments: ["Firefox"],
    linux: { directory: [".mozilla", "firefox"], binaries: ["firefox", "firefox-esr"], desktopIds: ["firefox.desktop", "firefox-esr.desktop", "org.mozilla.firefox.desktop"] },
  },
  {
    id: "zen", name: "Zen", engine: "firefox", bundleId: "app.zen-browser.zen", appNames: ["Zen.app", "Zen Browser.app"],
    dataSegments: ["zen"],
    linux: { directory: [".zen"], binaries: ["zen", "zen-browser"], desktopIds: ["zen.desktop", "zen-browser.desktop", "app.zen_browser.zen.desktop"] },
  },
  { id: "safari", name: "Safari", engine: "safari", bundleId: "com.apple.Safari", appNames: ["Safari.app"] },
];

export function findBrowser(id: string): BrowserDefinition | undefined {
  return BROWSERS.find((browser) => browser.id === id);
}

export function findBrowserByBundleId(bundleId: string): BrowserDefinition | undefined {
  const wanted = bundleId.toLowerCase();
  return BROWSERS.find((browser) => browser.bundleId.toLowerCase() === wanted);
}

export function dataDirectory(browser: BrowserDefinition, home: string, platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") {
    return browser.dataSegments ? join(home, "Library", "Application Support", ...browser.dataSegments) : undefined;
  }
  if (platform === "linux") return browser.linux?.directory ? join(home, ...browser.linux.directory) : undefined;
  return undefined;
}

export interface Profile {
  directory: string;
  name: string;
  /** The account signed in to the profile, when the browser records one. */
  account?: string;
}

export interface ProfileList {
  profiles: Profile[];
  /** The profile the browser used last, which is the one a sync defaults to. */
  lastUsed?: string;
}

const PROFILE_DIRECTORY = /^[A-Za-z0-9 ._-]{1,128}$/;

/** Chromium's Local State lists its profiles under profile.info_cache and the last one opened under profile.last_used. */
export function parseLocalState(text: string): ProfileList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { profiles: [] };
  }
  const profile = (parsed as { profile?: { info_cache?: unknown; last_used?: unknown } } | null)?.profile;
  const cache = profile?.info_cache;
  const profiles: Profile[] = [];
  if (cache && typeof cache === "object") {
    for (const [directory, info] of Object.entries(cache as Record<string, unknown>)) {
      if (!PROFILE_DIRECTORY.test(directory) || directory.includes("..")) continue;
      const record = (info ?? {}) as { name?: unknown; user_name?: unknown; gaia_name?: unknown };
      const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : directory;
      const account = typeof record.user_name === "string" && record.user_name.trim() ? record.user_name.trim() : undefined;
      profiles.push({ directory, name, ...(account ? { account } : {}) });
    }
  }
  const lastUsed = typeof profile?.last_used === "string" && PROFILE_DIRECTORY.test(profile.last_used) ? profile.last_used : undefined;
  return { profiles, ...(lastUsed ? { lastUsed } : {}) };
}

/** The browser whose .desktop file `xdg-settings get default-web-browser` named, or null. */
export function linuxDefaultBrowser(output: string): string | null {
  const file = output.trim().toLowerCase().replace(/\.desktop$/, "");
  if (!file) return null;
  for (const browser of BROWSERS) {
    if (browser.linux?.desktopIds?.some((id) => id.replace(/\.desktop$/, "") === file)) return browser.id;
  }
  return null;
}

/** Firefox lists profiles in profiles.ini; an [Install…] section's Default= names the one that browser opens. */
export function parseProfilesIni(text: string, root: string): ProfileList {
  const profiles: Profile[] = [];
  let lastUsed: string | undefined;
  let flaggedDefault: string | undefined;
  let section: { kind: "profile" | "install" | "other"; values: Record<string, string> } | null = null;
  const accept = (path: string, isRelative: boolean): string | undefined => {
    if (path.includes("\u0000")) return undefined;
    if (isRelative) {
      if (isAbsolute(path)) return undefined;
      const rel = relative(root, resolve(root, path));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
      return normalize(path);
    }
    return isAbsolute(path) ? normalize(path) : undefined;
  };
  const flush = () => {
    if (!section) return;
    const { kind, values } = section;
    if (kind === "profile" && values.Path) {
      const directory = accept(values.Path, values.IsRelative !== "0");
      if (directory) {
        profiles.push({ directory, name: values.Name?.trim() || directory });
        if (values.Default === "1") flaggedDefault = directory;
      }
    }
    if (kind === "install" && values.Default && !lastUsed) lastUsed = accept(values.Default, true) ?? accept(values.Default, false);
    section = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      flush();
      section = { kind: /^\[Profile\d+\]$/i.test(line) ? "profile" : /^\[Install[0-9A-F]+\]$/i.test(line) ? "install" : "other", values: {} };
      continue;
    }
    const equals = line.indexOf("=");
    if (section && equals > 0) section.values[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  flush();
  const chosen = lastUsed ?? flaggedDefault;
  return { profiles, ...(chosen ? { lastUsed: chosen } : {}) };
}

/** Where a profile keeps its cookies, newest layout first. */
export function cookieDatabaseCandidates(browser: BrowserDefinition, profileRoot: string): string[] {
  if (browser.engine === "firefox") return [join(profileRoot, "cookies.sqlite")];
  if (browser.engine === "chromium") return [join(profileRoot, "Network", "Cookies"), join(profileRoot, "Cookies")];
  return [];
}

/** Resolve a profile directory name under the browser's data directory, refusing anything that escapes it. */
export function profileRoot(browser: BrowserDefinition, home: string, platform: NodeJS.Platform, directory: string): string | undefined {
  const root = dataDirectory(browser, home, platform);
  if (!root) return undefined;
  if (browser.engine === "firefox" && isAbsolute(directory)) return normalize(directory);
  const full = resolve(root, directory);
  const rel = relative(root, full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return full;
}
