// @vitest-environment node
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installFilesystemGuard } from "./isolation";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const base = fs.mkdtempSync(join(tmpdir(), "isolation-")), root = join(base, "temp"), home = join(base, "real-home"), checkout = join(home, "checkout");
  for (const dir of [root, home, checkout]) fs.mkdirSync(dir, { recursive: true });
  const privateFile = join(home, "private"), source = join(checkout, "source.ts");
  fs.writeFileSync(privateFile, "private"); fs.writeFileSync(source, "source");
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const violations: string[] = [];
  const restore = installFilesystemGuard({ root, realHome: home, readRoots: [checkout] }, message => violations.push(message));
  cleanups.push(restore);
  return { base, root, home, checkout, privateFile, source, violations };
}
it("isolates every home, XDG and temporary environment path for workers", () => {
  const root = process.env.TAVERN_TEST_ROOT!;
  expect(root).toBeTruthy();
  for (const key of ["HOME", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]) {
    expect(process.env[key], key).toMatch(new RegExp("^" + root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/"));
  }
});
it("permits temp files and read-only checkout imports, but not checkout writes", () => {
  const f = fixture(), file = join(f.root, "ok");
  fs.writeFileSync(file, "ok"); expect(fs.readFileSync(file, "utf8")).toBe("ok");
  expect(fs.readFileSync(f.source, "utf8")).toBe("source");
  expect(() => fs.writeFileSync(f.source, "bad")).toThrow(/test filesystem escape/i);
  expect(f.violations).toHaveLength(1);
});
it("rejects real-home reads and outside writes even if application code catches them", async () => {
  const f = fixture();
  expect(() => fs.readFileSync(f.privateFile)).toThrow(/test filesystem escape/i);
  await expect(fs.promises.writeFile(join(f.base, "outside"), "bad")).rejects.toThrow(/test filesystem escape/i);
  expect(f.violations).toHaveLength(2);
});
it("guards callback and promise APIs as well as sync calls", async () => {
  const f = fixture();
  expect(() => fs.writeFile(f.source, "bad", () => {})).toThrow(/test filesystem escape/i);
  await expect(fs.promises.readFile(f.privateFile)).rejects.toThrow(/test filesystem escape/i);
  expect(f.violations).toHaveLength(2);
});
it("follows symlinks, including dangling targets, before allowing writes", () => {
  const f = fixture(), alias = join(f.root, "alias"), dangling = join(f.root, "dangling");
  fs.symlinkSync(f.privateFile, alias); fs.symlinkSync(join(f.home, "missing"), dangling);
  expect(() => fs.writeFileSync(alias, "bad")).toThrow(/test filesystem escape/i);
  expect(() => fs.writeFileSync(dangling, "bad")).toThrow(/test filesystem escape/i);
  expect(() => fs.readFileSync(alias)).toThrow(/test filesystem escape/i);
});
it("checks both sides of renames, copies and hard links", () => {
  const f = fixture(), file = join(f.root, "file"); fs.writeFileSync(file, "ok");
  expect(() => fs.renameSync(file, join(f.base, "outside"))).toThrow(/test filesystem escape/i);
  expect(() => fs.copyFileSync(file, f.source)).toThrow(/test filesystem escape/i);
  expect(() => fs.linkSync(f.source, join(f.root, "alias"))).toThrow(/test filesystem escape/i);
  fs.copyFileSync(f.source, join(f.root, "copy"));
});
it("checks recursive copies before following a destination symlink", () => {
  const f = fixture(), source = join(f.root, "source"), target = join(f.root, "target");
  fs.mkdirSync(join(source, "alias"), { recursive: true }); fs.mkdirSync(target);
  fs.writeFileSync(join(source, "alias", "file"), "ok"); fs.symlinkSync(f.checkout, join(target, "alias"));
  expect(() => fs.cpSync(source, target, { recursive: true })).toThrow(/test filesystem escape/i);
});
it("does not follow a symlink when unlinking that link inside the temp root", () => {
  const f = fixture(), alias = join(f.root, "alias"); fs.symlinkSync(f.privateFile, alias);
  fs.unlinkSync(alias); expect(f.violations).toEqual([]);
});
it("guards file descriptors and refuses hard-link aliases when writing contents", async () => {
  const f = fixture(), file = join(f.root, "file"), alias = join(f.root, "alias");
  const fd = fs.openSync(file, "w+"); fs.writeSync(fd, "ok"); fs.closeSync(fd);
  fs.linkSync(file, alias);
  expect(() => fs.writeFileSync(alias, "bad")).toThrow(/test filesystem escape/i);
  expect(() => fs.openSync(f.source, "w")).toThrow(/test filesystem escape/i);
  const handle = await fs.promises.open(join(f.root, "async"), "w");
  try { await handle.writeFile("ok"); } finally { await handle.close(); }
  expect(f.violations).toHaveLength(2);
});
