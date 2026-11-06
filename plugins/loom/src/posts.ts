// Loom's own posts on a ticket's thread, written in one place so each has Loom as its author and its data as JSON.
import type { PostRow, Store, TicketRow } from "./db/store";
import type { PostKind } from "./states";

/** Adds a post Loom writes itself to the ticket's thread; `data` is what the page and the record read from it. */
export function loomPost(store: Store, ticket: Pick<TicketRow, "id" | "project_id">, post: { kind: PostKind; body: string; data: object }): PostRow {
  return store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: post.kind, body: post.body, data_json: JSON.stringify(post.data) });
}

/** A merge post on its own, not in a transaction that ends with a change: the page hears of it at once. */
export function mergePostNow(store: Store, ticket: Pick<TicketRow, "id" | "project_id">, body: string, data: object): void {
  loomPost(store, ticket, { kind: "merge", body, data });
  store.changed(ticket.project_id);
}
