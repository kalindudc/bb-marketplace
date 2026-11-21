// The full page's warning for archived threads whose recorded edits may be incomplete. The side panel marks each of those
// threads instead, so it leaves this exact text out of its own warnings.
export function incompleteWarning(count: number, target: "tree" | "all"): string {
  const threads = count === 1 ? "1 archived thread" : `${count} archived threads`;
  const action = target === "tree" ? "Select Refresh to continue." : "Open the thread tree and select Refresh.";
  return `Recorded edits may be incomplete for ${threads}. ${action}`;
}
