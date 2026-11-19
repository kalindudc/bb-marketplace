// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it, vi } from "vitest";
import { emulatedGit } from "../host/emulated-git";
import { readyGate } from "./placement-e2e-ready";
import { proveWardenStage } from "./placement-e2e-review";
import { proveSubmissionStage } from "./placement-e2e-submission";
import { provePreserveStage } from "./placement-e2e-preserve";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each([proveSubmissionStage, provePreserveStage, readyGate, proveWardenStage])("captures and preserves a member through emulated Git (%#)", async prove => {
  const root = mkdtempSync(join(tmpdir(), "porcelain-placement-")); roots.push(root);
  vi.stubEnv("PATH", emulatedGit(root) + ":" + process.env.PATH);
  await prove();
}, 120_000);
