// @vitest-environment node
import Sqlite from "better-sqlite3";
import { expect, it } from "vitest";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { fixtureMember } from "../../src/ui/thread/fixtures";
it.each(["ready", "merged", "closed"] as const)("keeps %s on same-URL reuse, resets a new URL to draft, and transfers open ownership", state => {
  const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join("\n"));
  try {
    const store = new KeeperStore(db as never);
    store.put("members", "smith", { ...fixtureMember, threadId: "smith", classId: "smith", keeperThreadId: "keeper" });
    const input = { keeperThreadId: "keeper", boardQuestId: "quest", projectId: "project", url: "https://forge.example/pr/1", forge: "forge", head: "member-work", base: "main", owner: "smith", memberHead: "a".repeat(40), pushedHead: "b".repeat(40), verifiedCommit: null, state: "draft" as const };
    const pr = store.recordPullRequest(input, 1);
    expect(store.recordPullRequest(input, 2).id).toBe(pr.id);
    expect(store.all("pullRequests")).toHaveLength(1);
    expect(store.roomEvents().filter(event => event.type === "pull-request.changed")).toHaveLength(1);
    expect(() => store.recordPullRequest({ ...input, owner: "other" }, 3)).toThrow();
    store.put("pullRequests", pr.id, { ...pr, state });
    expect(store.recordPullRequest(input, 3).state).toBe(state);
    const reused = store.recordPullRequest({ ...input, url: "https://forge.example/pr/2" }, 4);
    expect(reused).toMatchObject({ id: pr.id, url: "https://forge.example/pr/2", state: "draft" });
    expect(store.roomEvents().some(event => event.type === "pull-request.changed" && event.at === 4 && event.data.url === reused.url && event.data.state === "draft")).toBe(true);
    expect(() => store.recordPullRequest({ ...input, base: "other" }, 5)).toThrow("This branch\u0027s draft targets main; moving it comes later");
    store.patch("smith", { released: { reason: "Work returned", decisionId: "decision" } }, 99);
    expect(store.get("pullRequests", pr.id)).toMatchObject({ owner: "keeper", state: "draft" });
    expect(store.roomEvents().some(event => event.type === "pull-request.changed" && event.data.owner === "keeper" && event.at === 99)).toBe(true);
  } finally { db.close(); }
});
