import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { experimental_defineHostEntry, type ExperimentalHostRpcContext, type ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk";
import {
  BROWSERS, cookieDatabaseCandidates, dataDirectory, findBrowser, findBrowserByBundleId, linuxDefaultBrowser, parseLocalState, parseProfilesIni, profileRoot,
  type BrowserDefinition, type ProfileList,
} from "./src/browsers";
import { withLeasedPage } from "./src/cdp";
import { deriveLinuxKey, encryptedSamples, needsKey, readChromiumCookies, schemaVersion, workingKey } from "./src/chromium";
import { MAX_CHANGED_HOSTS, hostContract, hostSignals, type BrowserInfo } from "./src/contract";
import { keptMemory, planSync, sourceChanged, toCdpParam, type JarCookie, type SourceCookie, type SyncMemory } from "./src/cookies";
import { SyncError, describeError } from "./src/errors";
import { readFirefoxCookies } from "./src/firefox";
import { createKeychain, runCommand } from "./src/keychain";
import { createLinuxKeyring } from "./src/keyring";
import { defaultHttpsHandler, openCommand } from "./src/open-url";
import { withSnapshot } from "./src/snapshot";

type Context = ExperimentalHostRpcContext<typeof hostSignals>;

const home = homedir();
const keychain = createKeychain();
const keyring = createLinuxKeyring();

function syncSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}
const SET_BATCH = 200;
/** Profile subdirectories that churn constantly and never hold cookies. */
const WATCH_IGNORES = [
  "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker", "IndexedDB", "Local Storage",
  "Session Storage", "Sessions", "blob_storage", "File System", "Extension State", "Extensions", "shared_proto_db", "WebStorage",
  "cache2", "startupCache", "storage", "datareporting", "saved-telemetry-pings", "crashes", "sessionstore-backups",
];

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function linuxExecutable(browser: BrowserDefinition): Promise<string | undefined> {
  for (const binary of browser.linux?.binaries ?? []) {
    const result = await runCommand("which", [binary]);
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return undefined;
}

async function isInstalled(browser: BrowserDefinition): Promise<boolean> {
  const data = dataDirectory(browser, home, process.platform);
  if (data && (await isDirectory(data))) return true;
  if (process.platform === "linux") return (await linuxExecutable(browser)) !== undefined;
  for (const app of browser.appNames) {
    if ((await isDirectory(join("/Applications", app))) || (await isDirectory(join(home, "Applications", app)))) return true;
  }
  return false;
}

async function cookieDatabase(browser: BrowserDefinition, directory: string): Promise<string | undefined> {
  const root = profileRoot(browser, home, process.platform, directory);
  if (!root) return undefined;
  for (const candidate of cookieDatabaseCandidates(browser, root)) if (await isFile(candidate)) return candidate;
  return undefined;
}

async function listProfiles(browser: BrowserDefinition): Promise<ProfileList> {
  const root = dataDirectory(browser, home, process.platform);
  if (!root || browser.engine === "safari") return { profiles: [] };
  const listed = browser.engine === "chromium"
    ? parseLocalState((await readText(join(root, "Local State"))) ?? "")
    : parseProfilesIni((await readText(join(root, "profiles.ini"))) ?? "", root);
  if (browser.engine === "chromium" && listed.profiles.length === 0) listed.profiles.push({ directory: "Default", name: "Default" });
  const profiles = [];
  for (const profile of listed.profiles) if (await cookieDatabase(browser, profile.directory)) profiles.push(profile);
  const lastUsed = profiles.some((profile) => profile.directory === listed.lastUsed) ? listed.lastUsed : profiles[0]?.directory;
  return { profiles, ...(lastUsed ? { lastUsed } : {}) };
}

async function defaultBrowserId(): Promise<string | null> {
  if (process.platform === "linux") {
    const result = await runCommand("xdg-settings", ["get", "default-web-browser"]);
    return result.code === 0 ? linuxDefaultBrowser(result.stdout) : null;
  }
  if (process.platform !== "darwin") return null;
  const plist = join(home, "Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist");
  if (!(await isFile(plist))) return null;
  const result = await runCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
  if (result.code !== 0) return null;
  const bundleId = defaultHttpsHandler(result.stdout);
  return bundleId ? findBrowserByBundleId(bundleId)?.id ?? null : null;
}

interface ResolvedSource {
  browser: BrowserDefinition;
  profile: string;
  database: string;
  /** The directory a watch observes: the one holding the cookie database. */
  folder: string;
}

async function resolveSource(browserId: string, requested: string | undefined): Promise<ResolvedSource> {
  if (!syncSupported()) throw new SyncError("unsupportedPlatform", `Session sync does not support ${process.platform} yet`);
  const browser = findBrowser(browserId);
  if (!browser) throw new SyncError("unsupportedBrowser", `Better Browser does not know the browser "${browserId}"`);
  if (browser.engine === "safari") {
    throw new SyncError("unsupportedBrowser", `${browser.name} links open there, but its sessions cannot sync yet`);
  }
  if (!(await isInstalled(browser))) throw new SyncError("notInstalled", `${browser.name} is not installed`);
  const { profiles, lastUsed } = await listProfiles(browser);
  const profile = requested ?? lastUsed;
  if (!profile || !profiles.some((entry) => entry.directory === profile)) {
    throw new SyncError("noProfile", requested
      ? `${browser.name} has no profile "${requested}" with cookies; choose another in Better Browser's settings`
      : `${browser.name} has no profile with cookies yet`);
  }
  const database = await cookieDatabase(browser, profile);
  if (!database) throw new SyncError("noProfile", `${browser.name}'s profile "${profile}" has no cookie database`);
  return { browser, profile, database, folder: dirname(database) };
}

interface SourceRead {
  cookies: SourceCookie[];
  undecryptable: number;
  partitioned: number;
}

/**
 * The Chromium key that decrypts this database, derived from the passwords the platform keeps the browser's Safe
 * Storage under. Linux cannot know which store a browser used, so each candidate proves itself against real
 * ciphertext; macOS has exactly one, so a missing or refused Keychain item is an error the user can act on.
 */
async function chromiumKey(browser: BrowserDefinition, database: DatabaseSync): Promise<Buffer | null> {
  if (process.platform === "darwin") {
    if (!browser.keychainService || !browser.keychainAccount) throw new Error("No Keychain item is known for this browser");
    return await keychain.key(browser.keychainService, browser.keychainAccount);
  }
  const samples = encryptedSamples(database);
  if (samples.length === 0) return null;
  const secrets = await keyring.secrets(browser.linux?.keyringApps ?? [], browser.keychainService ?? browser.name);
  const candidates = secrets.map(deriveLinuxKey);
  return workingKey(samples, schemaVersion(database), candidates);
}

async function readSource(source: ResolvedSource, context: Context): Promise<SourceRead> {
  const { browser } = source;
  try {
    return await withSnapshot(source.database, context.experimental_paths.tempDir, async (database) => {
      if (browser.engine === "firefox") return { cookies: readFirefoxCookies(database), undecryptable: 0, partitioned: 0 };
      if (!needsKey(database)) return readChromiumCookies(database, null);
      return readChromiumCookies(database, await chromiumKey(browser, database));
    });
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("readFailed", `Could not read ${browser.name}'s cookies: ${describeError(error)}`, { cause: error });
  }
}

function memoryPath(source: ResolvedSource, context: Context): string {
  const id = createHash("sha256").update(source.database).digest("hex").slice(0, 16);
  return join(context.experimental_paths.dataDir, "memory", `${source.browser.id}-${id}.json`);
}

async function loadMemory(source: ResolvedSource, context: Context): Promise<SyncMemory | null> {
  const text = await readText(memoryPath(source, context));
  if (text === undefined) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SyncMemory) : null;
  } catch {
    return null;
  }
}

async function saveMemory(source: ResolvedSource, context: Context, memory: SyncMemory): Promise<void> {
  const path = memoryPath(source, context);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(memory), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function failure(error: unknown) {
  if (error instanceof SyncError) return { ok: false as const, code: error.code, message: error.message.slice(0, 2000) };
  return { ok: false as const, code: "readFailed" as const, message: describeError(error).slice(0, 2000) };
}

interface SetOutcome {
  set: number;
  rejected: number;
}

/** Write cookies in batches; a batch CDP refuses is retried one cookie at a time so one bad cookie costs only itself. */
async function writeCookies(page: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> }, cookies: SourceCookie[]): Promise<SetOutcome> {
  let set = 0;
  let rejected = 0;
  for (let start = 0; start < cookies.length; start += SET_BATCH) {
    const batch = cookies.slice(start, start + SET_BATCH).map(toCdpParam);
    try {
      await page.send("Network.setCookies", { cookies: batch });
      set += batch.length;
    } catch {
      for (const cookie of batch) {
        try {
          await page.send("Network.setCookies", { cookies: [cookie] });
          set += 1;
        } catch {
          rejected += 1;
        }
      }
    }
  }
  return { set, rejected };
}

let watched: { key: string; subscription: ExperimentalHostWatchSubscription } | null = null;

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async browsers() {
      const supported = syncSupported();
      if (!supported) return { supported, defaultBrowserId: null, browsers: [] };
      const browsers: BrowserInfo[] = [];
      for (const browser of BROWSERS) {
        const installed = await isInstalled(browser);
        const syncable = browser.engine !== "safari";
        const { profiles, lastUsed } = installed && syncable ? await listProfiles(browser) : { profiles: [], lastUsed: undefined };
        browsers.push({
          id: browser.id, name: browser.name, engine: browser.engine, installed, syncable, profiles,
          ...(lastUsed ? { lastUsedProfile: lastUsed } : {}),
        });
      }
      return { supported, defaultBrowserId: await defaultBrowserId(), browsers };
    },

    async inspect({ browserId, profile }, context) {
      try {
        const source = await resolveSource(browserId, profile);
        const read = await readSource(source, context);
        const changed = sourceChanged(read.cookies, await loadMemory(source, context), Date.now() / 1000);
        return { ok: true as const, changed, profile: source.profile, cookies: read.cookies.length, undecryptable: read.undecryptable, partitioned: read.partitioned };
      } catch (error) {
        return failure(error);
      }
    },

    async apply({ browserId, profile, wsEndpoint, mode }, context) {
      try {
        const source = await resolveSource(browserId, profile);
        const read = await readSource(source, context);
        const previous = await loadMemory(source, context);
        const outcome = await withLeasedPage(wsEndpoint, context.signal, async (page) => {
          const { cookies: jar } = await page.send<{ cookies: JarCookie[] }>("Network.getAllCookies");
          const plan = planSync({ source: read.cookies, previous, jar, mode, nowSeconds: Date.now() / 1000, allowRemovals: read.undecryptable === 0 });
          const written = await writeCookies(page, plan.set);
          let removed = 0;
          for (const cookie of plan.remove) {
            try {
              await page.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path });
              removed += 1;
            } catch {
              written.rejected += 1;
            }
          }
          const hosts = new Set<string>();
          for (const cookie of [...plan.set.map((entry) => entry.host), ...plan.remove.map((entry) => entry.domain)]) {
            if (hosts.size >= MAX_CHANGED_HOSTS) break;
            hosts.add(cookie.replace(/^\./, "").toLowerCase());
          }
          return { ...written, removed, hosts: [...hosts], memory: plan.memory };
        }).catch((error: unknown) => {
          if (error instanceof SyncError) throw error;
          throw new SyncError("writeFailed", `Could not write cookies into bb's Browser: ${describeError(error)}`, { cause: error });
        });
        // A partial read cannot see the cookies it could not decrypt; keep their remembered hashes so a later sync can
        // still drop them when the real browser really loses them.
        await saveMemory(source, context, keptMemory(previous, outcome.memory, read.undecryptable === 0));
        return {
          ok: true as const, set: outcome.set, removed: outcome.removed, rejected: outcome.rejected, hosts: outcome.hosts, profile: source.profile,
          cookies: read.cookies.length, undecryptable: read.undecryptable, partitioned: read.partitioned,
        };
      } catch (error) {
        return failure(error);
      }
    },

    async watch({ browserId, profile }, context) {
      try {
        const source = await resolveSource(browserId, profile);
        const key = `${source.browser.id}\u0000${source.database}`;
        if (watched?.key === key) return { ok: true as const, profile: source.profile };
        const previous = watched;
        watched = null;
        await previous?.subscription.dispose();
        const database = basename(source.database);
        const subscription = await context.experimental_watch(
          { rootPath: source.folder, ignoredPaths: WATCH_IGNORES, debounceMs: 1_000, maxWaitMs: 5_000 },
          async (event) => {
            const relevant = event.kind !== "changed" || event.changes.some((change) => basename(change.path).startsWith(database));
            if (event.kind === "watch-error" || !relevant) return;
            await context.experimental_emitSignal("changed", { browserId: source.browser.id, profile: source.profile });
          },
        );
        watched = { key, subscription };
        return { ok: true as const, profile: source.profile };
      } catch (error) {
        return failure(error);
      }
    },

    async openUrl({ url, browserId, profile }) {
      const browser = findBrowser(browserId);
      if (!browser) return failure(new SyncError("unsupportedBrowser", `Better Browser does not know the browser "${browserId}"`));
      const executable = process.platform === "linux" ? await linuxExecutable(browser) : undefined;
      // profileRoot keeps an already-absolute profile path (a moved Firefox profile) instead of nesting it under the data dir.
      const profilePath = profile && browser.engine === "firefox" ? profileRoot(browser, homedir(), process.platform, profile) : undefined;
      const command = openCommand(process.platform, browser, url, {
        ...(profile ? { profile } : {}),
        ...(profilePath ? { profilePath } : {}),
        ...(executable ? { executable } : {}),
      });
      if (!command) return failure(new SyncError("unsupportedPlatform", "Opening links in another browser works on macOS and Linux"));
      const result = await runCommand(command.file, command.args);
      if (result.code !== 0) {
        return failure(new SyncError("notInstalled", `Could not open the link in ${browser.name}: ${result.stderr.trim().slice(0, 500)}`));
      }
      return { ok: true as const };
    },
  },
  async dispose() {
    const current = watched;
    watched = null;
    await current?.subscription.dispose();
    keychain.forget();
    keyring.forget();
  },
});
