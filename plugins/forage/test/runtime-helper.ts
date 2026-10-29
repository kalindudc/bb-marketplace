import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createForageRuntime, type RuntimeDependencies } from "../src/operations.ts";
import { SqliteSourceRepository } from "../src/sources/repository.ts";
import { configureSourceDatabase, SOURCE_MIGRATIONS } from "../src/sources/schema.ts";
import type { WebConfig } from "../src/web/config.ts";

export function fixtureRuntime(bb: BbPluginApi, getConfig: () => Promise<WebConfig>, overrides: Partial<RuntimeDependencies> = {}) {
 const db = bb.storage.database(); configureSourceDatabase(db); bb.storage.migrate(db, [...SOURCE_MIGRATIONS]);
 const unsupported = (): never => { throw new Error("Crawl not installed in this fetch-only fixture"); };
 const runtime = createForageRuntime({ getConfig, sources: new SqliteSourceRepository(db), resolveScope: async scope => scope, allowRestrictedThreadCapture: () => false,
  jobs: { create: unsupported, status: unsupported, list: unsupported, cancel: unsupported, resume: unsupported, cancelScope: unsupported, run: unsupported, wake: unsupported }, ...overrides });
 bb.onDispose(() => runtime.dispose());
 return runtime;
}
