import { isAbsolute } from "node:path";
import { gitOidSchema } from "../shared/placement";
import { gitRefSchema, sourceBaseSchema, type SourceBase } from "../host-contract";
import { runGit, type GitOptions } from "./git";
import { abortError } from "./process";

export function fetchUrl(value: string): string | undefined {
  if (!value || value.length > 1024 || value.startsWith("-") || /[\0\r\n]/.test(value) || value !== value.trim()) return;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!["http:", "https:", "ssh:", "git:", "file:"].includes(url.protocol)) return;
      if (url.protocol !== "ssh:") url.username = "";
      url.password = ""; url.search = ""; url.hash = "";
      return url.href.length <= 1024 ? url.href : undefined;
    } catch { return; }
  }
  if (isAbsolute(value) || value.startsWith("./") || value.startsWith("../") || !value.includes(":")) return value;
  const scp = /^((?:[^@/:\s]+@)?(?:\[[a-f0-9:]+\]|[a-z0-9._-]+)):([^\s]+)$/i.exec(value);
  const path = scp?.[2]?.split(/[?#]/)[0];
  if (!scp || !path || path.startsWith(":")) return;
  return scp[1] + ":" + path;
}
function inverseFetchRef(trackingRef: string, specs: string[]): string | undefined {
  const candidates = new Set<string>();
  const validPattern = (pattern: string) => (pattern.match(/\*/g)?.length ?? 0) <= 1 && gitRefSchema.safeParse(pattern.replace("*", "tavern-ref")).success;
  for (const raw of specs) {
    if (raw.startsWith("^")) { if (!validPattern(raw.slice(1))) return; continue; }
    const spec = raw.replace(/^\+/, ""), parts = spec.split(":");
    if (parts.length === 1) { if (!validPattern(spec)) return; continue; }
    if (parts.length !== 2 || !validPattern(parts[0]!) || !validPattern(parts[1]!)) return;
    const [source, target] = parts as [string, string];
    if (source.includes("*") !== target.includes("*")) return;
    if (!target.includes("*")) { if (target === trackingRef) candidates.add(source); continue; }
    const [prefix, suffix] = target.split("*") as [string, string];
    if (!trackingRef.startsWith(prefix) || !trackingRef.endsWith(suffix) || trackingRef.length <= prefix.length + suffix.length) continue;
    candidates.add(source.replace("*", trackingRef.slice(prefix.length, suffix.length ? -suffix.length : undefined)));
  }
  if (candidates.size !== 1) return;
  const candidate = [...candidates][0]!;
  return gitRefSchema.safeParse(candidate).success ? candidate : undefined;
}
export async function inspectSourceBase(root: string, head: string, options: GitOptions, kind: "porcelain" | "full" = "full"): Promise<SourceBase> {
  const unavailable = (code: string, message: string, retryable = false): SourceBase => ({ outcome: "unavailable", code: "source-base-" + code, message, retryable });
  if (kind === "porcelain") return unavailable("record-required", "Member source bases come from Tavern's placement record, never from member refs.");
  const run = (args: string[]) => runGit(root, args, { ...options, timeoutMs: args[0] === "merge-base" ? 30_000 : 3000 });
  const config = async (key: string): Promise<string[]> => {
    const result = await run(["config", "--get-all", key]);
    if (result.code === 1) return [];
    if (result.code !== 0) throw new Error("Source Git configuration unavailable");
    return result.stdout.replace(/\n$/, "").split("\n");
  };
  try {
    const [remotes, symbolic] = await Promise.all([run(["remote"]), run(["symbolic-ref", "-q", "HEAD"])]);
    if (remotes.code !== 0 || ![0, 1].includes(symbolic.code)) return unavailable("unavailable", "The source remote/upstream facts are unavailable; retry inspection.", true);
    const names = remotes.stdout.trim() ? remotes.stdout.trim().split("\n") : [];
    if (names.length > 50 || names.some(name => !name || name.length > 200 || /[\0\r\n]/.test(name))) return unavailable("remote-invalid", "The source remote list cannot be used safely; choose an appropriate Keeper environment.");
    const branchRef = symbolic.code === 0 ? symbolic.stdout.trim() : null;
    if (branchRef !== null && (!branchRef.startsWith("refs/heads/") || !gitRefSchema.safeParse(branchRef).success)) return unavailable("upstream-invalid", "The source branch/upstream ref is unavailable; choose an appropriate Keeper environment.");
    const [branchRemotes, merges] = branchRef ? await Promise.all([config("branch." + branchRef.slice(11) + ".remote"), config("branch." + branchRef.slice(11) + ".merge")]) : [[], []];
    let via: "upstream" | "remote-head", remoteName: string, trackingRef: string, fetchRef: string;
    if (branchRemotes.length || merges.length) {
      if (branchRemotes.length !== 1 || merges.length !== 1 || !names.includes(branchRemotes[0]!) || !gitRefSchema.safeParse(merges[0]).success) return unavailable("upstream-invalid", "The configured source upstream has no unique fetchable remote/ref; fix it or choose an appropriate Keeper environment.");
      via = "upstream"; remoteName = branchRemotes[0]!; fetchRef = merges[0]!;
      const upstream = await run(["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", branchRef!.slice(11) + "@{upstream}"]);
      if (upstream.code !== 0 || !gitRefSchema.safeParse(upstream.stdout.trim()).success) return unavailable("missing-ref", "The configured source upstream ref is missing locally; choose an appropriate Keeper environment. Tavern will not fetch in the source checkout.");
      trackingRef = upstream.stdout.trim();
    } else {
      if (names.length !== 1) return unavailable(names.length ? "ambiguous-remote" : "no-remote", "Without a configured upstream, the source needs exactly one remote with a local symbolic remote HEAD; choose an appropriate Keeper environment.");
      via = "remote-head"; remoteName = names[0]!;
      const remoteHead = await run(["symbolic-ref", "-q", "refs/remotes/" + remoteName + "/HEAD"]);
      if (remoteHead.code !== 0 || !gitRefSchema.safeParse(remoteHead.stdout.trim()).success) return unavailable("missing-ref", "The source remote HEAD ref is missing locally; choose an appropriate Keeper environment. Tavern will not guess a branch or fetch in the source checkout.");
      trackingRef = remoteHead.stdout.trim();
      const specs = await config("remote." + remoteName + ".fetch");
      const mapped = specs.length <= 200 ? inverseFetchRef(trackingRef, specs) : undefined;
      if (!mapped) return unavailable("fetch-ref", "The local remote HEAD ref does not identify one actual remote fetch ref; fix its refspecs or choose an appropriate Keeper environment.");
      fetchRef = mapped;
    }
    const [tip, remote] = await Promise.all([run(["rev-parse", "--verify", trackingRef + "^{commit}"]), run(["remote", "get-url", "--", remoteName])]);
    if (tip.code !== 0 || !gitOidSchema.safeParse(tip.stdout.trim()).success) return unavailable("missing-ref", "The source upstream/remote ref has no locally available commit; choose an appropriate Keeper environment.");
    const remoteUrl = remote.code === 0 ? fetchUrl(remote.stdout.replace(/\n$/, "")) : undefined;
    if (!remoteUrl) return unavailable("remote-invalid", "The source remote has no safe fetch transport URL; choose an appropriate Keeper environment.");
    const merge = await run(["merge-base", "--all", head, tip.stdout.trim()]);
    const bases = merge.stdout.trim() ? merge.stdout.trim().split("\n") : [];
    if (merge.code !== 0 || bases.length !== 1 || !gitOidSchema.safeParse(bases[0]).success || bases[0]!.length !== head.length) return unavailable("no-merge-base", "The local source refs do not have one available common ancestor; choose an appropriate Keeper environment. Tavern will not fetch in the source checkout.");
    return sourceBaseSchema.parse({ outcome: "ok", via, base: bases[0], remoteName, remoteUrl, trackingRef, fetchRef });
  } catch (error) {
    options.check?.();
    if ((error as { code?: string })?.code === "git-timeout") throw error;
    if (options.signal?.aborted) throw abortError();
    return unavailable("unavailable", "The source base/remote inspection is unavailable; retry or choose an appropriate Keeper environment.", true);
  }
}
