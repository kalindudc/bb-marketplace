import type { Doc } from "./helpers";

export function phased(doc: Doc): void {
  doc.merge = { strategy: "pr" };
  doc.phase = [
    { ref: "skeleton", title: "Skeleton", goal: "Deliver the smallest usable CSV export.", done_when: ["A CSV can be downloaded"], max_tickets: 3 },
    { ref: "polish", title: "Polish", goal: "Make the CSV export usable for large orders.", done_when: ["Large exports stream"], outline: ["Stream large files"] },
    { ref: "launch", title: "Launch", goal: "Make the CSV export available to everyone.", done_when: ["The feature is available"] },
  ];
  doc.ticket.forEach((t: Doc) => (t.phase = "skeleton"));
}
