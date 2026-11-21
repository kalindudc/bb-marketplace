import { ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { expect, vi } from "vitest";

export function settleGitConfigClock() {
  const now = Date.now;
  return vi.spyOn(Date, "now").mockImplementation(() => now() + 1000);
}

export function countGitLaunches() {
  const child = ChildProcess.prototype as unknown as {
    spawn(options: { file: string; args: string[] }): unknown;
  };
  const calls = vi.spyOn(child, "spawn");
  let start = calls.mock.calls.length;
  return (label: string, max: number, listings?: number) => {
    const launches = calls.mock.calls.slice(start).flatMap(([{ file, args }]) => {
      if (basename(file) === "git") return [args.slice(1)];
      return basename(file) === "sandbox-exec" && basename(args[3] ?? "") === "git" ? [args.slice(4)] : [];
    });
    start = calls.mock.calls.length;
    const config = launches.filter(args => args.includes("config") && args.includes("--list")).length;
    const readArgs = launches.filter(args => ["rev-parse", "symbolic-ref", "cat-file", "ls-files", "ls-tree", "status", "diff", "show", "for-each-ref"].some(command => args.includes(command)));
    const repeatedReads = readArgs.length - new Set(readArgs.map(args => JSON.stringify(args))).size;
    const report = `${label}: ${launches.length} Git launches, ${config} configuration listings, ${repeatedReads} repeat read arguments`;
    console.info(report);
    (globalThis as { __p020?: (record: object) => void }).__p020?.({ marker: report, pid: process.pid });
    expect.soft(launches.length, label).toBeLessThanOrEqual(max);
    if (listings !== undefined) expect.soft(config, label + " configuration listings").toBe(listings);
  };
}
