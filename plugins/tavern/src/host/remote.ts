import type { HostContext } from "./context";
import { HostError } from "./registry";
import { fetchUrl } from "./source-base";

export function isNetworkGitRemote(remote: string) {
  return fetchUrl(remote) === remote && (/^(?:git|https?|ssh):\/\//i.test(remote)
    || !remote.includes("://") && !remote.startsWith("/") && remote.includes(":"));
}
export async function assertEffectiveRemote(context: Pick<HostContext, "run">, remote: string, purpose: "fetch" | "push", privateFile = false) {
  if (!privateFile && !isNetworkGitRemote(remote))
    throw new HostError("remote-not-network", "Tavern needs a registered network remote; local file transports are not allowed for this operation.");
  const refused = () => new HostError("remote-rewrite", "Tavern refused the remote because the effective URL differs from the registered remote.");
  const options = { timeoutMs: 3000, networkRemote: !privateFile, readOnly: true };
  const resolved = await context.run(["ls-remote", "--get-url", "--", remote], options);
  if (resolved.code !== 0 || resolved.stdout.replace(/\n$/, "") !== remote) throw refused();
  if (purpose !== "push") return;
  const config = await context.run(["config", "--null", "--get-regexp", "^(url\\..*\\.pushinsteadof|remote\\..*\\.pushurl)$"], options);
  if (config.code !== 0 && config.code !== 1) throw refused();
  const pushUrls: string[] = [];
  let rewrite: { prefix: string; replacement: string } | undefined;
  for (const row of config.stdout.split("\0").filter(Boolean)) {
    const split = row.indexOf("\n"), key = row.slice(0, split), value = row.slice(split + 1);
    if (split < 0) throw refused();
    if (key === `remote.${remote}.pushurl`) pushUrls.push(value);
    else if (key.startsWith("url.") && key.endsWith(".pushinsteadof") && remote.startsWith(value) && (!rewrite || value.length > rewrite.prefix.length))
      rewrite = { prefix: value, replacement: key.slice(4, -".pushinsteadof".length) };
  }
  if (pushUrls.length ? pushUrls.length !== 1 || pushUrls[0] !== remote : rewrite && rewrite.replacement + remote.slice(rewrite.prefix.length) !== remote)
    throw refused();
}
