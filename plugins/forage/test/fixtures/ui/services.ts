import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { CrawlJobService, CrawlJobView } from "../../../src/jobs/model.ts";
import { sourceScopeKey } from "../../../src/web/contracts.ts";
import { CONFIG_DEFAULTS, type WebConfig } from "../../../src/web/config.ts";
import { artifact, attempt, createRepository, threadScope } from "../../sources/helpers.ts";

export function fixtureServices() {
 const { repository, db } = createRepository();
 const host = createFakePluginHost({ pluginId: "forage" });
 host.harness.sdk.stub("projects.get", async ({ projectId }) => {
  if (projectId !== "proj_a") throw new Error("not found");
  return { id: projectId, name: "Fixture project", createdAt: 1, updatedAt: 1, gitRemoteUrl: null, kind: "standard", sources: [] };
 });
 host.harness.sdk.stub("threads.get", async ({ threadId }) => {
  if (threadId === "missing") throw new Error("not found");
  return makeThreadResponse({ id: threadId, projectId: threadId === "foreign" ? "proj_other" : "proj_a" });
 });
 const scope = threadScope();
 const first = repository.recordRetrieval({ scope, origin: "fetch", artifact: artifact("# Docs\n\nFirst line\nSecond line"), attempt: attempt() });
 const second = repository.recordRetrieval({ scope, origin: "fetch", artifact: artifact("# Docs\n\nChanged line\nSecond line"), attempt: attempt({ startedAt: 300, finishedAt: 400 }) });
 let job: CrawlJobView = {
  id: "job_a", scope, state: "paused", rootUrl: "https://example.com/docs", includePaths: [], excludePaths: [], includeSubdomains: false,
  limits: { maxPages: 25, maxDepth: 2, maxBytes: 20 * 1024 * 1024, maxDurationMs: 300000, concurrency: 2 }, backend: "local",
  counts: { queued: 2, fetching: 0, saved: 1, failed: 0, skipped: 0 }, pagesUsed: 1, bytesUsed: 42, activeDurationMs: 100,
  generation: 1, createdAt: 1, startedAt: 1, updatedAt: 2, finishedAt: null, stopReason: null, error: null,
 };
 const visible = (candidate: typeof scope | { kind: "project"; projectId: string }, id: string) => id === job.id && sourceScopeKey(candidate) === sourceScopeKey(job.scope);
 const jobs: CrawlJobService = {
  create: () => job,
  status: (s, id) => visible(s, id) ? job : null,
  list: ({ scope: s }) => ({ jobs: visible(s, job.id) ? [job] : [], nextCursor: null }),
  cancel: (s, id) => { if (!visible(s, id)) throw new Error("not visible"); job = { ...job, state: "cancelled" }; return job; },
  resume: (s, id) => { if (!visible(s, id)) throw new Error("not visible"); job = { ...job, state: "running" }; return job; },
  cancelScope: async () => 1, run: async () => {}, wake: () => {},
 };
 let config: WebConfig = { ...CONFIG_DEFAULTS, warnings: [] };
 let restricted = false;
 return { ...host, repository, db, jobs, scope, first, second,
  getConfig: () => config, allowRestrictedThreadCapture: () => restricted,
  setConfig: (value: Partial<WebConfig>) => { config = { ...config, ...value }; },
  setRestricted: (value: boolean) => { restricted = value; },
  close: async () => { db.close(); await host.harness.lifecycle.dispose(); },
 };
}
