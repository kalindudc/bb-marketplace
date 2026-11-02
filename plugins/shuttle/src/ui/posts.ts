import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { PostState, PostView, PrView } from "../contract";
import { postText } from "../next";
import { patchPr, useShuttleQuery, useShuttleMutation, type Input } from "./data";
import { tinyKey } from "./format";

// Shared by every surface on the page, so a page and a thread tab open at once say each outcome once.
const known = new Map<number, PostState>();
const told = new Set<number>();

const toastId = (id: number) => `shuttle-post-${id}`;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const pending = (state: PostState | undefined) => state === "queued" || state === "posting";

/** A post this page queued: its outcome gets a toast even if it finishes before the next read of the queue. */
export function expectPost(post: PostView): void {
  known.set(post.id, post.state);
}

export function postedText(post: PostView): string {
  if (post.verdict === "approve" && post.comments === 0) return `Approved ${post.display} on ${post.serverName}.`;
  const where = post.comments > 0 && post.placed !== null && post.inBody !== null ? `: ${post.placed} inline, ${post.inBody} in the body` : "";
  return `Posted your review of ${post.display} on ${post.serverName}${where}.`;
}

/** Tells the user how each review they saw waiting or posting went, once it is done. */
export function usePostToasts(): void {
  const posts = useShuttleQuery("posts", {}).data?.posts;
  useEffect(() => {
    if (posts === undefined) return;
    for (const post of posts) {
      const before = known.get(post.id);
      known.set(post.id, post.state);
      if (!pending(before) || pending(post.state) || told.has(post.id)) continue;
      told.add(post.id);
      if (post.state === "posted") toast.success(postedText(post), { id: toastId(post.id) });
      else if (post.state === "failed") toast.error(`Your review of ${post.display} didn\u2019t post: ${post.error ?? "it failed"}`, { id: toastId(post.id) });
    }
  }, [posts]);
}

/** A review of yours waiting or posting on this PR, so nothing may queue another. */
export const reviewInQueue = (pr: PrView) => pr.post !== null && pr.post.state !== "failed";

/** The PR as the server will have it once the review is queued; its post has no id until the server gives it one. */
function queuedPr(pr: PrView, input: Input<"queueReview">, at: number): PrView {
  const post: PostView = {
    id: 0, key: pr.key, display: `${pr.repo}${pr.sep}${pr.number}`, serverName: pr.serverName, verdict: input.verdict, comments: (input.findings ?? []).length,
    draftId: input.draftId ?? null, state: "queued", error: null, placed: null, inBody: null, at, startedAt: null, finishedAt: null,
  };
  return { ...pr, post, next: { ...pr.next, kind: "posting", tone: "info", label: "Your review is queued to post", why: `${postText(post)}. Queued just now.`, inbox: false, clears: null, primary: null, more: [] } };
}

/** Queues a review and says so; the outcome comes from usePostToasts. The PR shows it queued from the click, not from the next read. */
export function useQueueReview() {
  const at = useRef(0);
  const queue = useShuttleMutation("queueReview", (input, cache) => patchPr(cache, input.key, (pr) => queuedPr(pr, input, at.current), []));
  const run = async (pr: PrView, input: Omit<Input<"queueReview">, "key">) => {
    at.current = Date.now();
    const out = await queue.run({ key: pr.key, ...input });
    if (out === null) return null;
    expectPost(out.post);
    toast(`Queued your review of ${tinyKey(pr)}: ${lowerFirst(postText(out.post))}. Shuttle posts it to ${pr.serverName} in the background.`, { id: toastId(out.post.id) });
    return out;
  };
  return { run, isPending: queue.isPending };
}

export function usePostWrites() {
  const cancel = useShuttleMutation("cancelPost");
  const retry = useShuttleMutation("retryPost");
  const clear = useShuttleMutation("clearPost");
  const cancelPost = async (pr: PrView) => {
    if (pr.post === null) return;
    if ((await cancel.run({ id: pr.post.id })) !== null) toast.success(`Cancelled your review of ${tinyKey(pr)}. Nothing was posted.`, { id: toastId(pr.post.id) });
  };
  const retryPost = async (pr: PrView) => {
    if (pr.post === null) return;
    const out = await retry.run({ id: pr.post.id });
    if (out === null) return;
    expectPost(out.post);
    told.delete(out.post.id);
    toast(`Trying your review of ${tinyKey(pr)} again. Shuttle posts it to ${pr.serverName} in the background.`, { id: toastId(out.post.id) });
  };
  const clearPost = async (pr: PrView) => {
    if (pr.post !== null) await clear.run({ id: pr.post.id });
  };
  return { cancelPost, retryPost, clearPost };
}
