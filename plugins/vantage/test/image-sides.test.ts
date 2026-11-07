// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host";
import { IMAGE_LIMIT } from "../src/images";
import type { HostInput, HostOutput } from "../src/contract";

type Sides = Extract<HostOutput<"imageSides">, { outcome: "available" }>;

const harness = experimental_createHostEntryHarness(hostEntry);
const ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com",
};
const saved: Record<string, string | undefined> = {};
let root: string;

const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const put = (path: string, content: string | Buffer): void => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
};
const sides = (path: string, target: HostInput<"imageSides">["target"], extra: Partial<HostInput<"imageSides">> = {}): Promise<HostOutput<"imageSides">> =>
  harness.experimental_call("imageSides", { root, path, previousPath: null, untracked: false, target, ...extra }) as Promise<HostOutput<"imageSides">>;
const available = (output: HostOutput<"imageSides">): Sides => {
  if (output.outcome !== "available") throw new Error(`unavailable: ${output.message}`);
  return output;
};
const bytesOf = (base64: string): Buffer => Buffer.from(base64, "base64");

// A real one-pixel PNG, so the bytes survive the base64 round trip unchanged.
const FIRST = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SECOND = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) { saved[key] = process.env[key]; process.env[key] = value; }
  root = realpathSync(mkdtempSync(join(tmpdir(), "vantage-images-")));
  git("init", "-q", "-b", "main");
  put("shot.png", FIRST);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  put("shot.png", SECOND);
  put("added.png", SECOND);
  git("add", "-A");
  git("commit", "-q", "-m", "work");
  put("shot.png", FIRST.subarray(0, 40));
  put("untracked.png", SECOND);
  put("big.png", Buffer.concat([FIRST, Buffer.alloc(IMAGE_LIMIT)]));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe("imageSides", () => {
  it("reads the committed bytes and the working tree for an uncommitted change", async () => {
    const result = available(await sides("shot.png", { type: "uncommitted" }));
    expect(bytesOf(result.old!)).toEqual(SECOND);
    expect(bytesOf(result.new!)).toEqual(FIRST.subarray(0, 40));
    expect(result.truncated).toBe(false);
  });

  it("reads the merge base and HEAD for the committed change", async () => {
    const result = available(await sides("shot.png", { type: "committed", base: "main" }));
    expect(bytesOf(result.old!)).toEqual(FIRST);
    expect(bytesOf(result.new!)).toEqual(SECOND);
  });

  it("reads the working tree alone for an untracked image, with no old side", async () => {
    const result = available(await sides("untracked.png", { type: "uncommitted" }, { untracked: true }));
    expect(result.old).toBeNull();
    expect(bytesOf(result.new!)).toEqual(SECOND);
  });

  it("answers a deleted image with only its old side", async () => {
    execFileSync("git", ["-C", root, "rm", "-q", "added.png"]);
    const result = available(await sides("added.png", { type: "uncommitted" }));
    expect(bytesOf(result.old!)).toEqual(SECOND);
    expect(result.new).toBeNull();
    git("reset", "-q", "--hard");
  });

  it("leaves a side out that is over the byte limit, and says so", async () => {
    const result = available(await sides("big.png", { type: "uncommitted" }));
    expect(result.old).toBeNull();
    expect(result.new).toBeNull();
    expect(result.truncated).toBe(true);
  });

  it("answers a file that is not an image or not there with no sides, not an error", async () => {
    const absent = available(await sides("missing.png", { type: "uncommitted" }));
    expect(absent.old).toBeNull();
    expect(absent.new).toBeNull();
    expect(absent.truncated).toBe(false);
  });

  it("refuses a path outside the repository", async () => {
    expect((await sides("../outside.png", { type: "uncommitted" })).outcome).toBe("unavailable");
  });
});
