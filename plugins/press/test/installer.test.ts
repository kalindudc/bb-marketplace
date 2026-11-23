import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  MARKER_NAME,
  composerTargetDir,
  ensureComposerInstalled,
  installDecision,
  resolveComposerSource,
} from "../src/installer";

describe("installDecision", () => {
  it("installs when nothing is at the target", () => {
    expect(installDecision({ markerVersion: null, sourceVersion: "1.0.0", targetExists: false })).toBe("install");
    expect(installDecision({ markerVersion: "1.0.0", sourceVersion: "1.0.0", targetExists: false })).toBe("install");
  });

  it("skips when the marker version equals the source version", () => {
    expect(installDecision({ markerVersion: "1.0.0", sourceVersion: "1.0.0", targetExists: true })).toBe("skip");
  });

  it("updates when the versions differ or the marker is unreadable", () => {
    expect(installDecision({ markerVersion: "0.9.0", sourceVersion: "1.0.0", targetExists: true })).toBe("update");
    expect(installDecision({ markerVersion: null, sourceVersion: "1.0.0", targetExists: true })).toBe("update");
    expect(installDecision({ markerVersion: "1.0.0", sourceVersion: null, targetExists: true })).toBe("update");
  });
});

describe("paths", () => {
  it("resolves the composer next to the module, then one level up", () => {
    const seen: string[] = [];
    const exists = (path: string): boolean => {
      seen.push(path);
      return path === join("/plugin", "composer", "package.json");
    };
    // The built layout: dist/server.js → ../composer
    expect(resolveComposerSource("file:///plugin/dist/server.js", exists)).toBe(join("/plugin", "composer"));
    expect(seen[0]).toBe(join("/plugin", "dist", "composer", "package.json"));
    expect(seen[1]).toBe(join("/plugin", "composer", "package.json"));
  });

  it("prefers ./composer when it exists", () => {
    const exists = (path: string): boolean => path.endsWith("/plugin/composer/package.json");
    expect(resolveComposerSource("file:///plugin/server.ts", exists)).toBe(join("/plugin", "composer"));
  });

  it("returns null when neither layout has a composer", () => {
    expect(resolveComposerSource("file:///nowhere/server.ts", () => false)).toBeNull();
  });

  it("targets ~/.pi/agent/extensions/press-composer", () => {
    expect(composerTargetDir("/home/tester")).toBe(join("/home/tester", ".pi", "agent", "extensions", "press-composer"));
  });
});

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function composerPackage(dir: string, name = "pi-press-composer") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "0.1.0", type: "module",
    pi: { extensions: ["./index.ts"] } }));
  await writeFile(join(dir, "index.ts"), "export default function () {}\n");
}

describe("ensureComposerInstalled", () => {
  it("reports another extensions directory and logs one warning when installing, not on status", async () => {
    const home = await mkdtemp(join(tmpdir(), "press-installer-"));
    roots.push(home);
    const source = join(home, "bundled");
    const target = composerTargetDir(home);
    const manual = join(dirname(target), "manual-copy");
    await composerPackage(source);
    await composerPackage(manual);
    await composerPackage(join(dirname(target), "other"), "unrelated");
    await composerPackage(join(dirname(target), ".disabled"));
    await symlink(manual, join(dirname(target), "manual-link"), "junction");
    const warnings: string[] = [];
    const log = { info: () => {}, warn: (m: string) => warnings.push(m) };

    const status = await ensureComposerInstalled({ source, target, readonly: true, log });
    expect(status.duplicateCopies).toEqual([manual]);
    expect(warnings).toEqual([]);
    await expect(readFile(join(target, "index.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const installed = await ensureComposerInstalled({ source, target, log });
    expect(installed).toMatchObject({ action: "install", duplicateCopies: [manual], error: null });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(manual);
    expect(await readFile(join(manual, "index.ts"), "utf8")).toBe("export default function () {}\n");
  });

  it("resolves local package settings relative to the agent or home and deduplicates aliases", async () => {
    const home = await mkdtemp(join(tmpdir(), "press-installer-"));
    roots.push(home);
    const target = composerTargetDir(home);
    const agent = dirname(dirname(target));
    const relativeCopy = join(home, "checkout");
    const homeCopy = join(home, "another-copy");
    await composerPackage(target);
    await composerPackage(relativeCopy);
    await composerPackage(homeCopy);
    await symlink(target, join(home, "bundled-link"), "junction");
    await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [
      "../../checkout",
      { source: "~/another-copy", extensions: ["./index.ts"] },
      pathToFileURL(join(relativeCopy, "index.ts")).href,
      "~/bundled-link",
      "~/missing-copy",
    ] }));
    const status = await ensureComposerInstalled({ source: null, target, readonly: true });
    expect(status.duplicateCopies).toEqual([homeCopy, relativeCopy]);
  });

  it("checks cached npm and git packages without installing packages or scanning unconfigured checkouts", async () => {
    const home = await mkdtemp(join(tmpdir(), "press-installer-"));
    roots.push(home);
    const target = composerTargetDir(home);
    const agent = dirname(dirname(target));
    const npm = join(agent, "npm", "node_modules", "pi-press-composer");
    const git = join(agent, "git", "github.com", "example", "composer");
    await composerPackage(npm);
    await composerPackage(git);
    await composerPackage(join(agent, "git", "github.com", "example", "other-copy"));
    await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [
      "npm:pi-press-composer@0.1.0", "git:git@github.com:example/composer.git@v0.1.0",
    ] }));
    const status = await ensureComposerInstalled({ source: null, target, readonly: true });
    expect(status.duplicateCopies).toEqual([git, npm]);
  });

  it("installs, skips on the second run, updates on a version change, keeps unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "press-installer-"));
    roots.push(root);
    const source = join(root, "composer");
    const target = join(root, "extensions", "press-composer");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "pi-press-composer", version: "1.0.0" }));
    await writeFile(join(source, "index.ts"), "export {};\n");
    await writeFile(join(source, "src", "config.ts"), "export {};\n");

    const logs: string[] = [];
    const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };

    const installed = await ensureComposerInstalled({ source, target, log });
    expect(installed.action).toBe("install");
    expect(installed.installedVersion).toBe("1.0.0");
    expect(await readFile(join(target, "index.ts"), "utf8")).toBe("export {};\n");
    expect(await readFile(join(target, "src", "config.ts"), "utf8")).toBe("export {};\n");
    const marker = JSON.parse(await readFile(join(target, MARKER_NAME), "utf8")) as Record<string, unknown>;
    expect(marker.version).toBe("1.0.0");
    expect(typeof marker.installedAt).toBe("string");
    expect(marker.source).toBe(source);
    expect(logs).toHaveLength(1);

    const skipped = await ensureComposerInstalled({ source, target, log });
    expect(skipped.action).toBe("skip");
    expect(logs).toHaveLength(2);

    await writeFile(join(target, "unrelated.txt"), "keep me\n");
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "pi-press-composer", version: "1.1.0" }));
    const updated = await ensureComposerInstalled({ source, target, log });
    expect(updated.action).toBe("update");
    expect(updated.installedVersion).toBe("1.1.0");
    expect(await readFile(join(target, "unrelated.txt"), "utf8")).toBe("keep me\n");

    const forced = await ensureComposerInstalled({ source, target, force: true, log });
    expect(forced.action).toBe("update");

    const status = await ensureComposerInstalled({ source, target, readonly: true, log });
    expect(status.action).toBe("skip");
    expect(logs).toHaveLength(4);
  });

  it("reports instead of throwing when the source is missing", async () => {
    const logs: string[] = [];
    const report = await ensureComposerInstalled({
      source: null,
      target: "/tmp/nowhere-press-composer",
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    expect(report.action).toBe("none");
    expect(report.error).toContain("not found");
    expect(logs).toHaveLength(1);
  });
});

it("a content change without a version bump still updates", () => {
  expect(
    installDecision({
      markerVersion: "0.1.0",
      sourceVersion: "0.1.0",
      targetExists: true,
      markerDigest: "aaaa",
      sourceDigest: "bbbb",
    }),
  ).toBe("update");
  expect(
    installDecision({
      markerVersion: "0.1.0",
      sourceVersion: "0.1.0",
      targetExists: true,
      markerDigest: "aaaa",
      sourceDigest: "aaaa",
    }),
  ).toBe("skip");
});

it("a marker from before digests existed is updated once", () => {
  expect(
    installDecision({
      markerVersion: "0.1.0",
      sourceVersion: "0.1.0",
      targetExists: true,
      markerDigest: null,
      sourceDigest: "bbbb",
    }),
  ).toBe("update");
});

it("without a source digest the version still decides", () => {
  expect(installDecision({ markerVersion: "0.1.0", sourceVersion: "0.1.0", targetExists: true })).toBe("skip");
});
