import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostContract, type HostInput, type HostOutput } from "../host-contract";
import { GUARD_MARKER, guardLoaderSource, piAgentDir } from "../scope/install";
import { atomicWrite } from "../scope/store";
import { hostContext, onCheckout } from "./context";
import { abortError } from "./process";
import { authorityOf, HostError, HostRegistry } from "./registry";

export interface NativeGuardOptions { artifactPath: string; agentDir?: string }
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function status(file: string) {
  try { return lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export class NativeGuard {
  constructor(readonly registry: HostRegistry, private readonly options: NativeGuardOptions) {}
  private installation(agentDir: string): string | undefined {
    for (const file of [agentDir, join(agentDir, "extensions"), join(agentDir, "extensions/tavern-guard")]) {
      const entry = status(file);
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
        throw new HostError("guard-unmarked", "The Pi guard directory is not an ordinary installation path; review its symlink or foreign file. No user extension was changed.");
    }
    const shim = join(agentDir, "extensions/tavern-guard/index.ts"), existing = status(shim);
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size > 64 * 1024))
      throw new HostError("guard-unmarked", "The existing Pi guard is not an ordinary managed file; review the installation. No user extension was changed.");
    const source = existing ? readFileSync(shim, "utf8") : undefined;
    if (source !== undefined && !source.startsWith(GUARD_MARKER + "\n"))
      throw new HostError("guard-unmarked", "The Pi guard file is not marked as Tavern-managed. Keep the user's extension and review the installation.");
    return source;
  }
  private intact(file: string, digest: string): void {
    const parent = status(dirname(file)), entry = status(file);
    if (!parent?.isDirectory() || parent.isSymbolicLink() || !entry?.isFile() || entry.isSymbolicLink() || entry.size > 256 * 1024 * 1024 || hash(readFileSync(file)) !== digest)
      throw new HostError("guard-integrity", "The immutable native guard artifact changed; repair the owned artifact cache rather than silently replacing altered bytes.");
  }
  async prepareGuard(raw: HostInput<"prepareGuard">, signal?: AbortSignal): Promise<HostOutput<"prepareGuard">> {
    const input = hostContract.prepareGuard.input.parse(raw), authority = authorityOf(input), agentDir = resolve(this.options.agentDir ?? piAgentDir());
    let prepared: { file: string; digest: string; shim: string } | undefined;
    const result = await this.registry.operation(authority, signal, combined => onCheckout("guard:" + agentDir, combined, async () => {
      const context = hostContext(this.registry, authority, ["member-write"], combined), check = context.active;
      const scopeDirectory = dirname(this.registry.scopeStatePath(authority, "scope.json"));
      let artifactDigest: string | null = null;
      const reply = (state: HostOutput<"prepareGuard">["state"], warning: string | null): HostOutput<"prepareGuard"> => ({ state, artifactDigest, scopeDirectory, warning: warning?.slice(0, 16_384) ?? null });
      try {
        check(); const previous = this.installation(agentDir);
        if (!input.allowMarkedInstall && previous === undefined) return reply("unavailable", "This rule has not authorized the opt-in guard installation; this member remains detection only.");
        const sourceStatus = status(this.options.artifactPath);
        if (!/\.(?:mjs|js)$/.test(this.options.artifactPath) || !sourceStatus?.isFile() || sourceStatus.isSymbolicLink() || sourceStatus.size > 256 * 1024 * 1024)
          return reply("unavailable", "A regular built Tavern host artifact is unavailable. Source TypeScript or server paths cannot stand in for a portable native guard; this member remains detection only.");
        const bytes = readFileSync(this.options.artifactPath), source = bytes.toString("utf8");
        if (!Buffer.from(source, "utf8").equals(bytes)) return reply("failed", "The built host artifact is not valid UTF-8; repair the artifact before preparing its guard.");
        artifactDigest = hash(bytes);
        check(); const target = this.registry.guardArtifactPath(authority, artifactDigest), wanted = guardLoaderSource(target, { exportName: "tavernGuard", digest: artifactDigest });
        if (!input.allowMarkedInstall && previous !== wanted)
          return reply("unavailable", "This rule has not authorized updating the marked guard artifact; this member remains detection only.");
        const copied = status(target);
        if (copied) this.intact(target, artifactDigest);
        else {
          if (!input.allowMarkedInstall) return reply("unavailable", "The native artifact is missing and this rule has not authorized reinstalling it; this member remains detection only.");
          atomicWrite(target, source, () => { check(); if (status(target)) this.intact(target, artifactDigest!); });
        }
        const module = await import(pathToFileURL(target).href); check(); this.intact(target, artifactDigest);
        if (typeof module.tavernGuard !== "function") return reply("failed", "The native host artifact does not export tavernGuard; rebuild the self-contained artifact before preparing its loader.");
        const unchanged = () => {
          check(); this.intact(target, artifactDigest!);
          if (this.installation(agentDir) !== previous) throw new HostError("guard-unmarked", "The Pi guard installation changed during preparation. Keep the current file and review the installation.");
        };
        unchanged();
        if (previous !== wanted) {
          if (!input.allowMarkedInstall) return reply("unavailable", "Updating the Pi guard requires this rule's installation consent; this member remains detection only.");
          for (const directory of [agentDir, join(agentDir, "extensions"), join(agentDir, "extensions/tavern-guard")]) { unchanged(); mkdirSync(directory, { recursive: true, mode: 0o700 }); }
          atomicWrite(join(agentDir, "extensions/tavern-guard/index.ts"), wanted, unchanged);
        }
        check(); this.intact(target, artifactDigest); prepared = { file: target, digest: artifactDigest, shim: wanted };
        return reply("prepared", null);
      } catch (error) {
        check(); return reply(error instanceof HostError && error.code === "guard-unmarked" ? "unmarked" : "failed", "Native guard preparation failed: " + (error instanceof Error ? error.message : String(error)) + ". This member remains detection only; report the installation need to the Keeper.");
      }
    }));
    if (signal?.aborted) throw abortError();
    this.registry.endpoint(authority, ["member-write"]);
    if (result.state === "prepared" && prepared) {
      try {
        this.intact(prepared.file, prepared.digest);
        if (this.installation(agentDir) !== prepared.shim) throw new HostError("guard-unmarked", "The Pi guard installation changed before preparation could be acknowledged; keep its current file.");
      } catch (error) { return { ...result, state: error instanceof HostError && error.code === "guard-unmarked" ? "unmarked" : "failed", warning: String(error).slice(0, 16_384) }; }
    }
    return hostContract.prepareGuard.output.parse(result);
  }
}
