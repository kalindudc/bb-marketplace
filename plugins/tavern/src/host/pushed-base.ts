import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gitRefSchema, hostContract, type Authority, type HostOutput } from "../host-contract";
import { gitOidSchema } from "../shared/placement";
import { assertRepository, hostContext, onCheckout } from "./context";
import { digest } from "./files";
import { git, runGit, withGitDeadline } from "./git";
import { HostError, type HostRegistry } from "./registry";
import { fetchUrl } from "./source-base";
import { fetchBase } from "./transport";
import { assertEffectiveRemote } from "./remote";

export async function pushedBase(registry: HostRegistry, input: Authority, signal?: AbortSignal): Promise<HostOutput<"pushedBase">> {
  return registry.operation(input, signal, combined => withGitDeadline(async bounded => {
    const context = hostContext(registry, input, ["source-read"], bounded);
    if (context.endpoint.registration.git !== "full") throw new HostError("git-unsupported", "Pushed default-branch capture requires the home host's full Git.");
    await assertRepository(context);
    const names = (await context.git(["remote"])).split("\n").filter(Boolean);
    if (names.length !== 1) throw new HostError("source-remote-ambiguous", "Pushed-only capture needs exactly one source remote; configure the selected repository's remote explicitly.");
    const remoteName = names[0]!, remoteUrl = fetchUrl(await context.git(["remote", "get-url", "--", remoteName]));
    if (!remoteUrl || remoteUrl !== context.endpoint.inspection?.fetchRemote)
      throw new HostError("source-remote-invalid", "The source remote no longer matches the URL recorded at inspection.");
    await assertEffectiveRemote(context, remoteUrl, "fetch");
    const advertised = await context.git(["ls-remote", "--symref", "--exit-code", "--", remoteUrl, "HEAD"], { timeoutMs: 120_000, networkRemote: true });
    const rows = advertised.split("\n"), symbolic = rows.filter(row => row.startsWith("ref: ") && row.endsWith("\tHEAD")), tips = rows.filter(row => /^[a-f0-9]+\tHEAD$/u.test(row));
    if (symbolic.length !== 1 || tips.length !== 1) throw new HostError("source-default-unavailable", "The remote did not advertise one symbolic default branch and tip.");
    const fetchRef = gitRefSchema.parse(symbolic[0]!.slice(5, -5)), base = gitOidSchema.parse(tips[0]!.split("\t")[0]);
    if (!fetchRef.startsWith("refs/heads/") || base.length !== (context.endpoint.inspection!.objectFormat === "sha1" ? 40 : 64)) throw new HostError("object-format-mismatch", "The advertised default tip differs from the source repository's object format.");
    const present = (await context.run(["cat-file", "-e", base + "^{commit}"])).code === 0;
    const root = join(registry.dataDir, "pushed-bases", digest(remoteUrl));
    const options = { dataDir: registry.dataDir, signal: bounded, check: context.active };
    await onCheckout(root, bounded, async () => {
      context.active(); mkdirSync(root, { recursive: true, mode: 0o700 });
      if (!existsSync(join(root, ".git"))) await git(root, ["init", "-q", "-b", "tavern-pushed-base", "--object-format=" + context.endpoint.inspection!.objectFormat], options);
      const imported = { transfer: { base }, run: (args: readonly string[], extra?: Partial<Parameters<typeof runGit>[2]>) => runGit(root, args, { ...options, ...extra }) };
      if (!await fetchBase(imported, present ? context.root : remoteUrl, present ? base : fetchRef, 120_000, present)) throw new HostError("base-unavailable", "Home could not fetch the advertised default tip into its private import repository.", true);
      await git(root, ["update-ref", "refs/tavern/pushed-bases/" + base, base], options);
      await git(root, ["update-ref", "refs/heads/tavern-pushed-base", base], options);
    });
    const tree = await git(root, ["rev-parse", "--verify", base + "^{tree}"], { dataDir: registry.dataDir, signal: bounded, check: context.active });
    return hostContract.pushedBase.output.parse({ base, tree, root, fetch: { via: "remote-head", remoteName, remoteUrl, trackingRef: "refs/remotes/" + remoteName + "/" + fetchRef.slice(11), fetchRef } });
  }, combined, 540_000));
}
