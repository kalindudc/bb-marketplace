import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitConfigRevision } from "../shared/git-safety";
import { metadataStamp } from "../shared/git-config-cache";
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
  const options = (extra?: Partial<GitOptions>): GitOptions => ({ ...extra, dataDir: registry.dataDir, signal, check: active, kind: endpoint.registration.git, metadata: endpoint.inspection });
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
type Facts = { config: object; fingerprint: string };
const repositories = new WeakMap<HostRegistry, Map<string, Facts>>();
function repositoryKey(endpoint: RegisteredEndpoint) {
  return JSON.stringify([endpoint.registration.placementId, endpoint.registration.endpointId]);
}
function repositoryFingerprint(endpoint: RegisteredEndpoint): string | undefined {
  const { realRoot, inspection, registration } = endpoint;
  if (!inspection) return;
  const { gitDir, commonDir, objectFormat } = inspection;
  const stamps = [metadataStamp(join(realRoot, ".git"), true), metadataStamp(gitDir, true), metadataStamp(commonDir, true),
    metadataStamp(join(gitDir, "commondir")), metadataStamp(join(gitDir, "gitdir"))];
  if (stamps.every(stamp => stamp !== null))
    return JSON.stringify([registration.generation, realRoot, gitDir, commonDir, objectFormat, stamps]);
}
export function rememberRepository(registry: HostRegistry, endpoint: RegisteredEndpoint, config: object | undefined, fingerprint = repositoryFingerprint(endpoint)) {
  if (!config || !fingerprint) return;
  let records = repositories.get(registry);
  if (!records) repositories.set(registry, records = new Map());
  records.set(repositoryKey(endpoint), { config, fingerprint });
}

export async function assertRepository(context: HostContext): Promise<void> {
  const { endpoint, root } = context, inspection = endpoint.inspection;
  if (!inspection) throw new HostError("endpoint-uninspected", "Inspect this repository before using it.");
  const kind = endpoint.registration.git, options = { dataDir: context.registry.dataDir, signal: context.signal, check: context.active, kind, metadata: inspection };
  const fingerprint = repositoryFingerprint(endpoint), cached = repositories.get(context.registry)?.get(repositoryKey(endpoint));
  const verified = cached && cached.fingerprint === fingerprint && gitConfigRevision(root, options) === cached.config;
  const head = await context.git(["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]+$/.test(head) || head.length !== (inspection.objectFormat === "sha1" ? 40 : 64))
    throw new HostError("object-format-mismatch", "The repository returned object ids inconsistent with its declared object format.");

  if (!verified) {
    const config = gitConfigRevision(root, options);
    // Porcelain endpoints may only allow the individual, capability-probed commands.
    const [bare, ...paths] = kind === "full"
      ? (await context.git(["rev-parse", "--is-bare-repository", "--git-dir", "--git-common-dir"])).split("\n")
      : [await context.git(["rev-parse", "--is-bare-repository"]), await context.git(["rev-parse", "--git-dir"])];
    const actualRoot = await context.git(["rev-parse", bare === "true" ? "--absolute-git-dir" : "--show-toplevel"]);
    if (realpathSync(resolve(root, actualRoot)) !== root)
      throw new HostError("source-root-required", "The source checkout must be a repository root; choose an appropriate Keeper environment. Tavern will not expand it to a parent repository.");
    const [gitDir, reportedCommonDir] = paths, commonDir = kind === "porcelain" ? gitDir : reportedCommonDir;
    if (!gitDir || !commonDir || realpathSync(resolve(root, gitDir)) !== inspection.gitDir || realpathSync(resolve(root, commonDir)) !== inspection.commonDir)
      throw new HostError("repository-replaced", "The endpoint's Git metadata changed after inspection.");
    const format = await repositoryObjectFormat(root, options, head);
    if (format !== inspection.objectFormat) throw new HostError("object-format-mismatch", "The repository object format changed after inspection.");
    if (config === gitConfigRevision(root, options) && fingerprint === repositoryFingerprint(endpoint))
      rememberRepository(context.registry, endpoint, config, fingerprint);
  }
  if (endpoint.registration.access === "member-write") {
    const branch = await context.git(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!endpoint.registration.allowedRefs.includes("refs/heads/" + branch)) throw new HostError("branch-mismatch", "The checkout changed away from its registered private branch.");
  }
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
