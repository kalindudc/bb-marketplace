import { useCallback, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../contract";
import type { Intent, PageActions } from "./actions";
import { AgentDialog } from "./agent";
import { Dialog } from "./common";
import { Composer } from "./conversation";
import { openExternal, useShuttleQuery } from "./data";
import { useEditPrs } from "./edit";
import { tinyKey } from "./format";
import { LinkDialog, type LinkRequest } from "./link-dialog";
import { MergeDialog } from "./merge-dialog";
import { ApproveDialog, PresetDialog } from "./review-button";
import { ReviewDialog } from "./review-dialog";
import { usePrWrites } from "./writes";

type DialogState =
  | { kind: "link"; request: LinkRequest }
  | { kind: "customize"; pr: PrView; thread: { threadId: string; title: string } | null; note?: string }
  | { kind: "preset"; pr: PrView }
  | { kind: "merge"; pr: PrView }
  | { kind: "agent"; pr: PrView; start?: "new" }
  | { kind: "approve"; pr: PrView }
  | { kind: "comment"; pr: PrView; text?: string }
  | null;

export interface SurfaceOptions {
  phone: boolean;
  /** A phone's PR screen has no composer of its own, so Comment opens one in a sheet. */
  sheetComposer: boolean;
  selected: string | null;
  select(key: string): void;
  /** Threads whose PR lists a write patches at once. */
  threadIds: readonly string[];
}

/**
 * What every PR card, row and PR view can ask of the surface around it, and the dialogs those
 * asks open. The Shuttle page and the thread tab each host one.
 */
export function useSurface({ phone, sheetComposer, selected, select, threadIds }: SurfaceOptions) {
  const navigate = useBbNavigate();
  const config = useShuttleQuery("getConfig", {});
  const [dialog, setDialog] = useState<DialogState>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const nonce = useRef(0);
  const writes = usePrWrites(threadIds);
  const edits = useEditPrs(threadIds);

  const raise = (key: string, kind: Intent["kind"], fill?: { text: string } | { nudge: true }) => {
    nonce.current += 1;
    setIntent({ key, kind, nonce: nonce.current, ...fill });
  };
  const done = useCallback((handled: Intent) => setIntent((current) => (current?.nonce === handled.nonce ? null : current)), []);

  const actions: PageActions = {
    phone,
    presets: config.data?.config.presets ?? null,
    writes,
    edits,
    selected,
    select,
    open: (pr) => openExternal(navigate, pr.url),
    openThread: (threadId) => navigate.toThread(threadId),
    link: (pr, tab = "existing") => setDialog({ kind: "link", request: { pr, tab } }),
    merge: (pr) => setDialog({ kind: "merge", pr }),
    pickAgent: (pr, start) => setDialog({ kind: "agent", pr, ...(start === undefined ? {} : { start }) }),
    startReview: (pr) => {
      if (config.data === undefined) toast.error("Shuttle's presets have not loaded yet");
      else setDialog({ kind: "preset", pr });
    },
    customize: (pr, threadId) => {
      if (config.data === undefined) return void toast.error("Shuttle's presets have not loaded yet");
      const thread = threadId === undefined ? null : { threadId, title: pr.lastReview?.threadId === threadId ? pr.lastReview.title : pr.links.find((entry) => entry.threadId === threadId)?.title ?? "its review thread" };
      setDialog({ kind: "customize", pr, thread });
    },
    approve: (pr) => setDialog({ kind: "approve", pr }),
    compose: (pr, text) => {
      if (selected !== pr.key) select(pr.key);
      if (sheetComposer) return setDialog({ kind: "comment", pr, ...(text === undefined ? {} : { text }) });
      raise(pr.key, "compose", text === undefined ? undefined : { text });
    },
    showDraft: (pr) => {
      if (selected !== pr.key) select(pr.key);
      raise(pr.key, "draft");
    },
    intent,
    done,
  };

  const close = () => setDialog(null);
  const presets = config.data?.config.presets;
  const dialogs: ReactNode = (
    <>
      {dialog?.kind === "link" && <LinkDialog request={dialog.request} onClose={close} />}
      {dialog?.kind === "customize" && presets !== undefined && <ReviewDialog pr={dialog.pr} presets={presets} thread={dialog.thread} initialNote={dialog.note} onClose={close} />}
      {dialog?.kind === "preset" && presets !== undefined && (
        <PresetDialog pr={dialog.pr} presets={presets} onClose={close}
          onCustomize={(note) => setDialog({ kind: "customize", pr: dialog.pr, note, thread: dialog.pr.next.kind === "rereview" && dialog.pr.lastReview !== null ? { threadId: dialog.pr.lastReview.threadId, title: dialog.pr.lastReview.title } : null })} />
      )}
      {dialog?.kind === "merge" && <MergeDialog pr={dialog.pr} onClose={close} />}
      {dialog?.kind === "agent" && <AgentDialog pr={dialog.pr} start={dialog.start} onClose={close} />}
      {dialog?.kind === "approve" && <ApproveDialog pr={dialog.pr} onClose={close} />}
      {dialog?.kind === "comment" && (
        <Dialog title={`${dialog.pr.can.comment ? "Comment on" : !dialog.pr.mine && dialog.pr.can.review ? "Review" : "Ask the agent of"} ${tinyKey(dialog.pr)}`} leading={<Icon name="MessageSquare" className="size-4" aria-hidden />} onClose={close}>
          <Composer pr={dialog.pr} autoFocus initialText={dialog.text ?? ""} onDone={close} />
        </Dialog>
      )}
    </>
  );

  return { actions, dialogs, dialogOpen: dialog !== null, raise };
}
