import { useState } from "react";
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { composeReview, useComments, type CommentStore } from "./comments";

export function DraftInspection({
  store,
  draftKey,
  root,
  recipient,
}: {
  store: CommentStore;
  draftKey: string;
  root: string | null;
  recipient?: string;
}) {
  const comments = useComments(store, draftKey);
  const [preview, setPreview] = useState(false);
  if (comments.length === 0) return null;
  const attributed = recipient !== undefined;
  const message = composeReview(comments, root, attributed);
  return (
    <section
      aria-label={attributed ? `Draft for ${recipient}` : "Unattributed draft"}
      className="my-2 space-y-2 rounded-md border border-border-seam bg-card p-3 text-xs"
    >
      <p>
        {attributed
          ? `Draft for ${recipient}. Sending is unavailable from this evidence.`
          : "Unattributed draft from this checkout. No recipient is known; this draft cannot be sent."}
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="min-h-7 underline" aria-pressed={preview} onClick={() => setPreview(!preview)}>
          {attributed ? "Preview" : "Preview unattributed draft"}
        </button>
        <button
          type="button"
          className="min-h-7 underline"
          onClick={() => {
            void experimental_copyToClipboard({ text: message }).then(
              (copied) => (copied ? toast("Copied as Markdown") : toast.error("Could not copy")),
              () => toast.error("Could not copy"),
            );
          }}
        >
          Copy as Markdown
        </button>
      </div>
      {preview && <pre className="whitespace-pre-wrap break-words font-sans">{message}</pre>}
    </section>
  );
}
