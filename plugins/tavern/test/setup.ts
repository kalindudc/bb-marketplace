import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach } from "vitest";
import { installFilesystemGuard } from "./isolation";

if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/react");
  // findBy* and waitFor wait 1 s by default, too short under full-suite load.
  configure({ asyncUtilTimeout: 5_000 });
  const { notifyManager } = await import("@tanstack/react-query");
  const view = document.defaultView!;
  // jsdom cancels its window's timers when Vitest tears down the DOM, unlike Node timers.
  notifyManager.setScheduler(callback => { if (view.document) view.setTimeout(callback, 0); });
}

const root = process.env.TAVERN_TEST_ROOT, realHome = process.env.TAVERN_TEST_REAL_HOME;
if (!root || !realHome) throw new Error("Vitest must initialize Tavern test environment isolation");
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const violations: string[] = [];
const restore = installFilesystemGuard({ root, realHome, readRoots: [checkout, process.env.TAVERN_TEST_PI_MODULES!, ...(process.env.TAVERN_SCOPE_REPLAY ? [process.env.TAVERN_SCOPE_REPLAY] : [])] }, message => violations.push(message));
afterEach(() => { if (violations.length) throw new Error(violations.splice(0).join("\n")); });
afterAll(restore);
