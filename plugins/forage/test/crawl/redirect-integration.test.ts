import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { startServer, type TestServer } from "../_server.ts";
import { createCrawlService, type CrawlEngine } from "../../src/crawl/engine.ts";
import { FORAGE_MIGRATIONS } from "../../src/crawl/schema.ts";
import { CRAWL_DEFAULT_LIMITS } from "../../src/crawl/repository.ts";
import { configureSourceDatabase } from "../../src/sources/schema.ts";
import { SqliteSourceRepository } from "../../src/sources/repository.ts";
import { resolveConfig } from "../../src/web/config.ts";
import { safeFetch } from "../../src/web/net.ts";
import { threadScope } from "../sources/helpers.ts";
let server: TestServer | undefined, service: CrawlEngine | undefined, db: Database.Database | undefined;
afterEach(async () => { await service?.dispose(); db?.close(); await server?.close(); });
it("follows compliant same-origin redirects and blocks robots/path targets before any target request", async () => {
 server = await startServer({
  "/robots.txt": (_req, res) => { res.end("User-agent: ForageBot\nDisallow: /docs/blocked\n"); },
  "/docs/start": (_req, res) => { res.writeHead(302, { location: "/docs/allowed" }); res.end(); },
  "/docs/start-blocked": (_req, res) => { res.writeHead(302, { location: "/docs/blocked" }); res.end(); },
  "/docs/start-outside": (_req, res) => { res.writeHead(302, { location: "/outside" }); res.end(); },
  "/docs/allowed": (_req, res) => { res.setHeader("content-type", "text/html"); res.end("<main><h1>Allowed</h1><p>Compliant target.</p></main>"); },
  "/docs/blocked": (_req, res) => { res.end("must never request"); },
  "/outside": (_req, res) => { res.end("must never request"); },
 });
 db = new Database(":memory:"); configureSourceDatabase(db); for (const sql of FORAGE_MIGRATIONS) db.exec(sql);
 let sources: SqliteSourceRepository;
 const changes: string[] = [];
 service = createCrawlService(db, { getSources: () => sources, getConfig: () => resolveConfig({ allowPrivateNetwork: true }), allowRestrictedThreadCapture: () => true, onChanged: scope => changes.push(scope.projectId) });
 sources = new SqliteSourceRepository(db, { maintenance: service });
 for (const path of ["/docs/start", "/docs/start-blocked", "/docs/start-outside"]) {
  const job = service.create({ scope: threadScope(), rootUrl: server.url + path, backend: "local", includePaths: ["/docs"], excludePaths: [], includeSubdomains: false, limits: { ...CRAWL_DEFAULT_LIMITS } });
  db.prepare("UPDATE forage_crawl_jobs SET discovered = 1 WHERE id = ?").run(job.id);
  await service.runOnce();
  expect(service.status(job.scope, job.id)!.counts.saved).toBe(path === "/docs/start" ? 1 : 0);
 }
 expect(server.requests.some(request => request.path === "/docs/allowed")).toBe(true);
 expect(server.requests.some(request => request.path === "/docs/blocked" || request.path === "/outside")).toBe(false);
 expect(changes.length).toBeGreaterThan(6);
});
it("bounds an asynchronous redirect policy by the request deadline", async () => {
 server = await startServer({ "/start": (_req, res) => { res.writeHead(302, { location: "/target" }); res.end(); }, "/target": (_req, res) => { res.end("must not request"); } });
 await expect(safeFetch(server.url + "/start", { allowPrivateNetwork: true, timeoutMs: 50, maxBytes: 1000, beforeRedirect: () => new Promise(() => {}) })).rejects.toThrow(/timed out/i);
 expect(server.requests.map(request => request.path)).toEqual(["/start"]);
});
