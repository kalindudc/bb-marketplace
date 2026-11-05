import type { BrowserDefinition } from "./browsers";

export interface OpenCommand {
  file: string;
  args: string[];
}

export interface OpenOptions {
  profile?: string;
  /** Absolute path of the synced profile, which Firefox needs because it takes a directory, not a profile-directory name. */
  profilePath?: string;
  /** On Linux, the browser binary to launch, which the host resolves on PATH; without it xdg-open opens the system default. */
  executable?: string;
}

/**
 * The profile a link has to name, or undefined to hand the link straight to the running browser. Naming a profile starts a
 * second copy of the browser that passes the link on to the first, about four seconds on macOS, while the running browser
 * opens a link in the profile it used last within a fraction of a second. So only a different profile is named.
 */
export function profileToName(profile: string | undefined, usedLast: string | undefined): string | undefined {
  return profile === usedLast ? undefined : profile;
}

/**
 * The command that opens `url` in the chosen browser. On macOS a Chrome-style browser is relaunched with
 * --profile-directory, which its single-instance check forwards to the running browser, so the link opens in the same
 * profile the plugin syncs from; other browsers get the URL through `open -b`. On Linux the browser binary is launched
 * the same way, its single-instance check forwarding the arguments the same way.
 */
export function openCommand(platform: NodeJS.Platform, browser: BrowserDefinition, url: string, options: OpenOptions = {}): OpenCommand | null {
  if (browser.engine === "firefox" && options.profilePath) {
    // No -new-instance: a running Firefox forwards the URL to that profile, and forcing a new instance would fail on a
    // profile that is open, which is the normal case for the profile being followed.
    const args = ["-profile", options.profilePath, url];
    return platform === "darwin" ? { file: "/usr/bin/open", args: ["-n", "-b", browser.bundleId, "--args", ...args] } : platform === "linux" && options.executable ? { file: options.executable, args } : null;
  }
  if (platform === "darwin") {
    if (browser.profileArgument && options.profile) {
      return { file: "/usr/bin/open", args: ["-n", "-b", browser.bundleId, "--args", `--profile-directory=${options.profile}`, url] };
    }
    return { file: "/usr/bin/open", args: ["-b", browser.bundleId, url] };
  }
  if (platform === "linux") {
    if (!options.executable) return { file: "xdg-open", args: [url] };
    const args = browser.profileArgument && options.profile ? [`--profile-directory=${options.profile}`, url] : [url];
    return { file: options.executable, args };
  }
  return null;
}

/** The bundle id macOS opens https links with, from LaunchServices' handler list (converted to JSON by plutil). */
export function defaultHttpsHandler(launchServicesJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(launchServicesJson);
  } catch {
    return null;
  }
  const handlers = (parsed as { LSHandlers?: unknown })?.LSHandlers;
  if (!Array.isArray(handlers)) return null;
  for (const handler of handlers as Record<string, unknown>[]) {
    if (String(handler?.LSHandlerURLScheme ?? "").toLowerCase() !== "https") continue;
    const role = handler.LSHandlerRoleAll ?? handler.LSHandlerRoleViewer;
    if (typeof role === "string" && role) return role;
  }
  return null;
}
