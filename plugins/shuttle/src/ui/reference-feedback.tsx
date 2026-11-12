import { useState } from "react";
import { toast } from "sonner";
import { BUTTON, ErrorNote } from "./common";
import { messageOf, useShuttleMutation } from "./data";

export function ReferenceFeedback({ id, url, onDone, showTriage = true }: { id: string; url: string | null; onDone?(): void; showTriage?: boolean }) {
  const [query, setQuery] = useState(url ?? "");
  const [error, setError] = useState<string | null>(null);
  const feedback = useShuttleMutation("referenceFeedback");
  const act = async (action: "flag" | "correct" | "suppress" | "reset" | "confirm" | "dismiss") => {
    setError(null);
    try {
      await feedback.mutate({ id, action, query: action === "correct" ? query : null });
      const messages = { confirm: "Reference marked correct and moved to Handled.", dismiss: "Reference dismissed and moved to Handled.", correct: "Reference corrected; its matched PR panel is updated.", flag: "Reference flagged for review.", suppress: "Reference marked as not a git reference.", reset: "Reference reset to automatic matching." };
      toast.success(messages[action]);
      onDone?.();
    } catch (failure) { setError(messageOf(failure)); }
  };
  return <div className="space-y-2" data-shuttle-reference-controls="">
    <div className="flex flex-wrap gap-2">
      {showTriage && <>
        <button className={BUTTON} disabled={feedback.isPending || !url} onClick={() => void act("confirm")}>Mark correct</button>
        <button className={BUTTON} disabled={feedback.isPending} onClick={() => void act("dismiss")}>Dismiss</button>
      </>}
      <button className={BUTTON} disabled={feedback.isPending} onClick={() => void act("flag")}>Flag incorrect</button>
      <button className={BUTTON} disabled={feedback.isPending} onClick={() => void act("suppress")}>Not a git reference</button>
      <button className={BUTTON} disabled={feedback.isPending} onClick={() => void act("reset")}>Reset to automatic</button>
    </div>
    <details>
      <summary className="cursor-pointer py-1 text-xs text-primary">Correct this reference</summary>
      <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void act("correct"); }}>
        <label className="block text-xs">PR key or PR / issue URL
          <input aria-label="Correct reference target" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={2000}
            className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground" placeholder="github:owner/repo#123 or https://…/issues/123" />
        </label>
        <p className="text-xs text-muted-foreground">Applies only to this number in this message. Saved as your choice; the target is not fetched to verify it.</p>
        <button type="submit" className={BUTTON} disabled={feedback.isPending || !query.trim()}>Save correction</button>
      </form>
    </details>
    {error !== null && <ErrorNote>{error}</ErrorNote>}
  </div>;
}
