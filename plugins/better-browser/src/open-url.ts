import type { BrowserDefinition } from "./browsers";

export interface OpenCommand {
  file: string;
  args: string[];
}

/**
 * The command that opens `url` in the chosen browser. On macOS a Chrome-style browser is relaunched with
 * --profile-directory, which its single-instance check forwards to the running browser, so the link opens in the same
 * profile the plugin syncs from; other browsers get the URL through `open -b`.
 */
export function openCommand(platform: NodeJS.Platform, browser: BrowserDefinition, url: string, profile?: string): OpenCommand | null {
  if (platform === "darwin") {
    if (browser.profileArgument && profile) {
      return { file: "/usr/bin/open", args: ["-n", "-b", browser.bundleId, "--args", `--profile-directory=${profile}`, url] };
    }
    return { file: "/usr/bin/open", args: ["-b", browser.bundleId, url] };
  }
  if (platform === "linux") return { file: "xdg-open", args: [url] };
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
