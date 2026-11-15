import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "./store";

const MARKER = "// Managed by bb-plugin-tavern guard. Do not edit.";
export { MARKER as GUARD_MARKER };
export interface GuardOptions { agentDir?: string; entryPath?: string }
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir();
  const configured = env.PI_CODING_AGENT_DIR;
  return configured ? resolve(home, configured.replace(/^~(?=\/|$)/, home)) : join(home, ".pi/agent");
}
const shimFile = (options: GuardOptions) => join(options.agentDir ?? piAgentDir(), "extensions/tavern-guard/index.ts");
export const guardLoaderSource = (entryPath: string, artifact?: { exportName: "tavernGuard"; digest: string }) => MARKER + `
const TARGET = ${JSON.stringify(resolve(entryPath))};
export default async function (pi) {
  if (!process.env.TAVERN_SCOPE_FILE) return;
  try {
    const { existsSync } = await import("node:fs");
    if (!existsSync(TARGET)) throw new Error("Tavern guard target is missing");
    ${artifact ? `const { createHash } = await import("node:crypto");\n    const { readFileSync } = await import("node:fs");\n    if (createHash("sha256").update(readFileSync(TARGET)).digest("hex") !== ${JSON.stringify(artifact.digest)}) throw new Error("Tavern guard artifact checksum changed");` : ""}
    ${artifact ? `const { pathToFileURL } = await import("node:url");` : ""}
    return await (await import(${artifact ? "pathToFileURL(TARGET).href" : "TARGET"})).${artifact?.exportName ?? "default"}(pi);
  } catch (error) {
    const { readFileSync } = await import("node:fs");
    const enforcing = () => {
      try { return !["watch", "off"].includes(JSON.parse(readFileSync(process.env.TAVERN_SCOPE_FILE, "utf8")).mode); }
      catch { return !["watch", "off"].includes(process.env.TAVERN_SCOPE_MODE); }
    };
    const permitted = ["journal", "quest", "tavern_report", "tavern_ready"];
    const hidden = new Set();
    const hide = () => {
      const current = pi.getActiveTools(), candidates = [...new Set([...current, ...hidden])];
      const active = candidates.filter(name => !enforcing() || permitted.includes(name));
      hidden.clear(); for (const name of candidates) if (!active.includes(name)) hidden.add(name);
      if (current.join() !== active.join()) pi.setActiveTools(active);
    };
    pi.on("session_start", hide);
    pi.on("before_agent_start", hide);
    pi.on("tool_call", event => !enforcing() || permitted.includes(event.toolName) ? undefined : {
      block: true,
      reason: "[Tavern scope blocked] Guard could not load: " + String(error) + ". Report the need with tavern_report status needs-decision; ask the Keeper to repair the installation."
    });
  }
}
`;
function readShim(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export type GuardInstallResult = "installed" | "updated" | "current" | "no-agent-dir" | "unmarked";
export function ensureGuardInstalled(options: GuardOptions & { entryPath: string }): GuardInstallResult {
  const dir = options.agentDir ?? piAgentDir();
  if (!existsSync(dir)) return "no-agent-dir";
  const file = shimFile(options), previous = readShim(file), wanted = guardLoaderSource(options.entryPath);
  if (previous === wanted) return "current";
  if (previous !== undefined && !previous.startsWith(MARKER + "\n")) return "unmarked";
  mkdirSync(dirname(file), { recursive: true }); atomicWrite(file, wanted);
  return previous === undefined ? "installed" : "updated";
}
export function guardStatus(options: GuardOptions = {}): { installed: boolean; stale: boolean; file: string; entryPath?: string; claude: "phase-2-not-installed"; sandbox: "available" | "missing" | "not-applicable" } {
  const file = shimFile(options), existing = readShim(file);
  const base = { file, claude: "phase-2-not-installed" as const, sandbox: process.platform !== "darwin" ? "not-applicable" as const : existsSync("/usr/bin/sandbox-exec") ? "available" as const : "missing" as const };
  if (!existing?.startsWith(MARKER + "\n")) return { ...base, installed: false, stale: false };
  const match = /^(?:const TARGET = |export \{ default \} from )("(?:[^"\\]|\\.)*");$/m.exec(existing);
  if (!match) return { ...base, installed: true, stale: true };
  const entryPath = JSON.parse(match[1]) as string;
  return { ...base, installed: true, entryPath, stale: !existsSync(entryPath) || !!options.entryPath && resolve(options.entryPath) !== entryPath };
}
export function uninstallGuard(options: GuardOptions = {}): void {
  const file = shimFile(options);
  if (readShim(file)?.startsWith(MARKER + "\n")) {
    rmSync(file);
    try { rmdirSync(dirname(file)); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
}
