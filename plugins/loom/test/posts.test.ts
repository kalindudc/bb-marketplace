import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store";
import { loomPost, mergePostNow } from "../src/posts";
import { Clock, makeDb } from "./helpers";

describe("Loom's posts on a ticket", () => {
  it("are Loom's, on the ticket's thread, with their data as JSON", () => {
    const store = new Store(makeDb(), new Clock().now);
    const project = store.createProject({ slug: "csv", name: "CSV", key: "CSV", bb_project_id: "proj_1" }, "human");
    const ticket = store.createTicket({ project_id: project.id, seq: 1, key: "CSV-1", ref: "one", title: "One", body: "Do it.", acceptance_json: "[]", verify_json: "[]", scope_json: "[]", deps_json: "[]", priority: 2 }, "human");
    loomPost(store, ticket, { kind: "block", body: "Blocked.", data: { reason: "Blocked.", needs: "" } });
    mergePostNow(store, ticket, "Merged.", { outcome: "merged" });
    expect(store.posts(ticket.id).map((post) => ({ author: post.author_kind, thread: post.author_thread_id, kind: post.kind, body: post.body, data: JSON.parse(post.data_json) }))).toEqual([
      { author: "loom", thread: null, kind: "block", body: "Blocked.", data: { reason: "Blocked.", needs: "" } },
      { author: "loom", thread: null, kind: "merge", body: "Merged.", data: { outcome: "merged" } },
    ]);
  });
});
