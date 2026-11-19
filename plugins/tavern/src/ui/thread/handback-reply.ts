import { useEffect, useSyncExternalStore } from "react";
import { experimental_useRpcMutation, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import type { KeeperNote } from "../../shared/schema";

type Reply = { noteId: string; quote: string; staged: boolean };
const replies = new Map<string, Reply>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(listener => listener());
export function replyToHandBack(note: KeeperNote) {
  const text = [note.action ?? note.text, note.why, note.action ? note.text : null].filter(Boolean).join("\n");
  replies.set(note.keeperThreadId, { noteId: note.id, quote: text.split("\n").map(line => `> ${line}`).join("\n"), staged: false });
  changed();
}
export function useHandBackReply(threadId: string, composer: PluginComposerApi, onError: (error: unknown) => void) {
  const reply = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => replies.get(threadId), () => undefined);
  const resolve = experimental_useRpcMutation({ contract: rpcContract, method: "resolveHandBack" });
  useEffect(() => {
    if (!reply || reply.staged) return;
    const prefix = `${reply.quote}\n\n`;
    composer.replace(draft => ({ text: prefix + draft.text, mentions: draft.mentions.map(mention => ({ ...mention, from: mention.from + prefix.length, to: mention.to + prefix.length })) }));
    replies.set(threadId, { ...reply, staged: true });
    changed();
    composer.focus();
  }, [threadId, reply, composer]);
  useEffect(() => {
    if (!reply?.staged) return;
    const sent = composer.text;
    return composer.onSubmitted(() => {
      replies.delete(threadId);
      changed();
      if (sent.includes(reply.quote)) void resolve.mutate({ noteId: reply.noteId, how: "replied", reply: sent.slice(0, 24000) }).catch(onError);
    });
  }, [threadId, reply, composer, composer.text, resolve.mutate, onError]);
}
