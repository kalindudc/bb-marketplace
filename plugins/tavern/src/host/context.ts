import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Authority, EndpointRegistration, TransferAuthority, TransferRegistration } from "../host-contract";
import { git, runGit, type GitOptions } from "./git";
import { authorityOf, HostError, HostRegistry, type RegisteredEndpoint } from "./registry";
import { abortError } from "./process";
import { repositoryObjectFormat } from "./git-capabilities";

export interface HostContext {
  registry: HostRegistry; authority: Authority; signal: AbortSignal; endpoint: RegisteredEndpoint; root: string;
  active(): void;
  git(args: readonly string[], options?: Partial<GitOptions>): Promise<string>;
  run(args: readonly string[], options?: Partial<GitOptions>): ReturnType<typeof runGit>;
}
export interface TransferContext extends HostContext { authority: TransferAuthority; transfer: TransferRegistration }
export function hostContext(registry: HostRegistry, authority: Authority, access: EndpointRegistration["access"][], signal: AbortSignal): HostContext {
  const endpoint = registry.endpoint(authorityOf(authority), access), root = endpoint.realRoot;
  const active = () => { if (signal.aborted) throw abortError(); registry.endpoint(authorityOf(authority), access); };
  const options = (extra?: Partial<GitOptions>): GitOptions => ({ ...extra, dataDir: registry.dataDir, signal, check: active });
  const portable = (args: readonly string[]) => {
    if (endpoint.registration.git === "full") return;
    const commands = new Set(["rev-parse", "symbolic-ref", "status", "diff", "show", "cat-file", "ls-files", "add", "commit", "remote", "for-each-ref", "fetch", "push", "config"]);
    const command = args.find((arg, at) => !arg.startsWith("-") && (at === 0 || args[at - 1] !== "-c"));
    const sparseRemoval = command === "rm" && endpoint.inspection?.sparse && args.includes("--cached") && args.includes("--sparse");
    const treeRead = command === "ls-tree" && args.includes("-z");
    if (!command || !commands.has(command) && !sparseRemoval && !treeRead || command === "ls-files" && !args.includes("--unmerged") && !args.includes("--stage"))
      throw new HostError("git-unsupported", "This endpoint grants porcelain Git only; refused " + (command ?? args[0]) + ".");
  };
  return { registry, authority, signal, endpoint, root, active, git: (args, extra) => { portable(args); return git(root, args, options(extra)); }, run: (args, extra) => { portable(args); return runGit(root, args, options(extra)); } };
}
export function transferContext(registry: HostRegistry, authority: TransferAuthority, access: EndpointRegistration["access"][], signal: AbortSignal): TransferContext {
  const context = hostContext(registry, authority, access, signal), { registration } = registry.transfer(authority);
  return { ...context, authority, transfer: registration };
}
export async function assertRepository(context: HostContext): Promise<void> {
  const { endpoint, root } = context, inspection = endpoint.inspection;
  if (!inspection) throw new HostError("endpoint-uninspected", "Inspect this repository before using it.");
  const bare = await context.git(["rev-parse", "--is-bare-repository"]);
  const actualRoot = await context.git(["rev-parse", bare === "true" ? "--absolute-git-dir" : "--show-toplevel"]);
  if (realpathSync(resolve(root, actualRoot)) !== root)
    throw new HostError("source-root-required", "The source checkout must be a repository root; choose an appropriate Keeper environment. Tavern will not expand it to a parent repository.");
  const [paths, format, branch] = await Promise.all([
    context.git(["rev-parse", "--git-dir", ...(endpoint.registration.git === "full" ? ["--git-common-dir"] : [])]), repositoryObjectFormat(root, { dataDir: context.registry.dataDir, signal: context.signal, check: context.active }),
    endpoint.registration.access === "member-write" ? context.git(["symbolic-ref", "--short", "-q", "HEAD"]) : Promise.resolve(null),
  ]);
  const [gitDir, reportedCommonDir] = paths.split("\n");
  const commonDir = endpoint.registration.git === "porcelain" ? gitDir : reportedCommonDir;
  if (!gitDir || !commonDir || realpathSync(resolve(root, gitDir)) !== inspection.gitDir || realpathSync(resolve(root, commonDir)) !== inspection.commonDir)
    throw new HostError("repository-replaced", "The endpoint's Git metadata changed after inspection.");
  if (format !== inspection.objectFormat) throw new HostError("object-format-mismatch", "The repository object format changed after inspection.");
  if (branch !== null && !endpoint.registration.allowedRefs.includes("refs/heads/" + branch)) throw new HostError("branch-mismatch", "The checkout changed away from its registered private branch.");
  context.active();
}

const tails = new Map<string, Promise<void>>();
export function onCheckout<T>(root: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(root) ?? Promise.resolve();
  let started = false;
  const result = previous.then(() => { if (signal.aborted) throw abortError(); started = true; return work(); });
  const done = result.then(() => undefined, () => undefined);
  tails.set(root, done);
  void done.then(() => { if (tails.get(root) === done) tails.delete(root); });
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => { if (!started) reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void result.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
