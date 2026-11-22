import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pi half of Press: the composer extension. The governor keeps it installed at
 * `~/.pi/agent/extensions/press-composer/` by copying its own `composer/` directory, so pi threads
 * get Press summaries without a manual `pi install`. The decision is a pure function; the copying
 * never throws into the service.
 */

export const MARKER_NAME = ".press-composer.json";

/** The files of the composer that are copied; nothing else is touched in the target. */
const COPY_FILES = ["index.ts", "package.json", "README.md"];

export type InstallDecision = "install" | "skip" | "update";

export interface InstallDecisionInput {
  markerVersion: string | null;
  sourceVersion: string | null;
  targetExists: boolean;
  /** Content digest of the copied files. Preferred over the version when both sides have one, so a
   * change without a version bump still reaches the installed copy. */
  markerDigest?: string | null;
  sourceDigest?: string | null;
}

/**
 * Pure: should the composer be installed? Nothing there → `install`; the marker matches the source
 * version → `skip`; anything else (a different version, a missing or unreadable marker) → `update`.
 */
export function installDecision(input: InstallDecisionInput): InstallDecision {
  if (!input.targetExists) return "install";
  if (input.sourceVersion === null) return "update";
  if (input.sourceDigest) {
    // A marker written before digests existed has no digest; re-copy once so it gets one.
    if (!input.markerDigest) return "update";
    return input.markerDigest === input.sourceDigest ? "skip" : "update";
  }
  return input.markerVersion === input.sourceVersion ? "skip" : "update";
}

/**
 * Where the composer to copy lives: the plugin's own `composer/` directory. Resolved from the
 * module URL so it works both from the built layout (`dist/server.js` → `../composer`) and from the
 * source layout (`server.ts` → `./composer`).
 */
export function resolveComposerSource(
  moduleUrl: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const here = dirname(fileURLToPath(moduleUrl));
  for (const candidate of [join(here, "composer"), join(here, "..", "composer")]) {
    if (exists(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

export function composerTargetDir(home: string = homedir()): string {
  return join(home, ".pi", "agent", "extensions", "press-composer");
}

/** The source and target paths for this machine, or a null source when the composer cannot be found. */
export function composerPaths(moduleUrl: string, home: string = homedir()): { source: string | null; target: string } {
  return { source: resolveComposerSource(moduleUrl), target: composerTargetDir(home) };
}

async function readSourceVersion(sourceDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function readMarker(targetDir: string): { version: string | null; digest: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(join(targetDir, MARKER_NAME), "utf8")) as {
      version?: unknown;
      digest?: unknown;
    };
    return {
      version: typeof parsed.version === "string" ? parsed.version : null,
      digest: typeof parsed.digest === "string" ? parsed.digest : null,
    };
  } catch {
    return { version: null, digest: null };
  }
}

/** sha256 over the copied files, path and content, in a stable order. */
async function digestComposer(sourceDir: string): Promise<string | null> {
  const hash = createHash("sha256");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
      else if (entry.isFile()) {
        hash.update(relative);
        hash.update("\u0000");
        hash.update(await readFile(join(dir, entry.name)));
        hash.update("\u0000");
      }
    }
  };
  try {
    for (const name of COPY_FILES) {
      const path = join(sourceDir, name);
      if (!existsSync(path)) continue;
      hash.update(name);
      hash.update("\u0000");
      hash.update(await readFile(path));
      hash.update("\u0000");
    }
    const src = join(sourceDir, "src");
    if (existsSync(src)) await walk(src, "src");
    return hash.digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) await copyFile(join(from, entry.name), join(to, entry.name));
  }
}

/** Copy the composer: the entry files and `src/**`. Never deletes anything already in the target. */
async function copyComposer(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const name of COPY_FILES) {
    const from = join(sourceDir, name);
    if (existsSync(from)) await copyFile(from, join(targetDir, name));
  }
  const src = join(sourceDir, "src");
  if (existsSync(src)) await copyTree(src, join(targetDir, "src"));
}

export interface ComposerInstallReport {
  action: InstallDecision | "none";
  source: string | null;
  target: string;
  sourceVersion: string | null;
  installedVersion: string | null;
  installedAt: string | null;
  error: string | null;
}

export interface InstallLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Make sure the composer is installed, and report what happened. Never throws: a failure is logged
 * and returned, so the service and the startup path keep running. `readonly` only computes the
 * decision (`--status`); `force` copies even when the marker already matches (`--install`).
 */
export async function ensureComposerInstalled(options: {
  source: string | null;
  target: string;
  force?: boolean;
  readonly?: boolean;
  now?: () => number;
  log?: InstallLogger;
}): Promise<ComposerInstallReport> {
  const now = options.now ?? Date.now;
  const report: ComposerInstallReport = {
    action: "none",
    source: options.source,
    target: options.target,
    sourceVersion: null,
    installedVersion: null,
    installedAt: null,
    error: null,
  };
  try {
    if (options.source === null) {
      report.error = "composer source directory not found next to the plugin";
      options.log?.warn(`press composer: ${report.error}`);
      return report;
    }
    const sourceVersion = await readSourceVersion(options.source);
    report.sourceVersion = sourceVersion;
    const marker = readMarker(options.target);
    const markerVersion = marker.version;
    const sourceDigest = await digestComposer(options.source);
    report.installedVersion = markerVersion;
    const targetExists = existsSync(options.target);
    const decision = options.force === true && options.readonly !== true
      ? targetExists
        ? "update"
        : "install"
      : installDecision({ markerVersion, sourceVersion, targetExists, markerDigest: marker.digest, sourceDigest });
    report.action = decision;
    if (options.readonly === true) return report;
    if (decision === "skip") {
      options.log?.info(`press composer: up to date (version ${markerVersion}) at ${options.target}`);
      return report;
    }
    await copyComposer(options.source, options.target);
    const written = {
      version: sourceVersion,
      digest: sourceDigest,
      installedAt: new Date(now()).toISOString(),
      source: options.source,
    };
    await writeFile(join(options.target, MARKER_NAME), `${JSON.stringify(written, null, 2)}\n`);
    report.installedVersion = sourceVersion;
    report.installedAt = written.installedAt;
    options.log?.info(
      `press composer: ${decision === "install" ? "installed" : "updated"} version ${sourceVersion ?? "unknown"} at ${options.target}`,
    );
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    options.log?.warn(`press composer: install failed: ${report.error}`);
    return report;
  }
}
