// The forge boundary learns each checkout's forge host from the calls made there, per machine, so a call that carries no
// URL, such as opening a pull request, still waits out its host's backoff.
import { expect, it } from "vitest";
import { makeCtx } from "./helpers";

const create = { remote: "origin", base: "main", head: "loom/new", title: "t", body: "b", draft: false, forge: { kind: "gh" as const } };

it("learns a checkout's forge host from a batch read, and holds a new pull request while that host is backed off", async () => {
  const h = makeCtx();
  await h.ctx.host.call("host_1", "prBatch", { repo: "/repo", host: "github.com", owner: "acme", name: "shop", numbers: [1], feedback: false });
  h.ctx.forgeBackoffs.set("github.com", { until: h.clock.t + 60_000, delayMs: 60_000, message: "HTTP 429" });
  await h.ctx.host.call("host_1", "prCreate", { repo: "/repo", ...create });
  expect(h.host.callsTo("prCreate")).toHaveLength(0);
});

it("keeps same-named checkouts on different machines to their own forge hosts", async () => {
  const h = makeCtx();
  await h.ctx.host.call("machine-a", "prState", { repo: "/repo", url: "https://github.com/acme/shop/pull/1", forge: { kind: "gh" } });
  await h.ctx.host.call("machine-b", "prState", { repo: "/repo", url: "https://git.example.com/acme/shop/pull/2", forge: { kind: "gh" } });
  h.ctx.forgeBackoffs.set("github.com", { until: h.clock.t + 60_000, delayMs: 60_000, message: "HTTP 429" });
  await h.ctx.host.call("machine-a", "prCreate", { repo: "/repo", ...create });
  expect(h.host.callsTo("prCreate")).toHaveLength(0);
  await h.ctx.host.call("machine-b", "prCreate", { repo: "/repo", ...create });
  expect(h.host.callsTo("prCreate")).toHaveLength(1);
});
