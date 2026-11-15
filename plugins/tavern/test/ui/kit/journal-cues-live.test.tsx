// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import type { EntryStatus, Journal } from "../../../src/shared/schema";
import { Tally, useJournalCues } from "../../../src/ui/kit";
import { motion } from "../../../src/ui/kit/motion";
import { fixtureJournal } from "../../../src/ui/thread/fixtures";
import { flush, installAnimations } from "./motion-fakes";

let fx: ReturnType<typeof installAnimations>;
let t = 0;
beforeEach(() => { motion.reset(); t = 1_000_000; motion.now = () => t; fx = installAnimations({ "mo-chalk": 180, "mo-slash": 180, "mo-verified": 260 }); });
afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); });
const base = fixtureJournal.entries[0]!;
let cid = 1;
const change = (id: string, action: string) => ({ id: cid++, threadId: "t1", at: 0, actor: { kind: "agent", threadId: "t1" }, action, entryIds: [id], text: "", seen: true }) as Journal["changes"][number];
function journal(statuses: Record<string, EntryStatus>, current: string, done: number, changes: Journal["changes"] = []) {
  const entries = Object.entries(statuses).map(([id, status]) => ({ ...base, id, status, description: `Entry ${id}` }));
  const cur = entries.find(e => e.id === current)!;
  return { entries, changes, progress: { ...fixtureJournal.progress, done, total: 79, current: { id: cur.id, description: cur.description, status: cur.status } } } as Pick<Journal, "entries" | "changes" | "progress">;
}
function Panel({ data }: { data: ReturnType<typeof journal> }) {
  const root = useRef<HTMLDivElement>(null);
  useJournalCues("t1", data, root, { fetching: false });
  return <div ref={root} className="tavern journal notebook"><Tally done={data.progress.done} total={79} verified={0} maxWidth={400} />
    {data.entries.map(e => <div key={e.id} className="journal-entry" data-entry={e.id} data-entry-state={e.status}><div className="journal-row">{data.progress.current?.id === e.id && <span className="ribbon row" />}</div></div>)}</div>;
}
const cues = () => fx.all.map(a => a.className ?? (a.target as Element).className);

it("the live sequence: an agent moves the ribbon, then 5 s later finishes that entry; the stroke plays", async () => {
  const view = render(<Panel data={journal({ e2: "todo", a4: "todo" }, "e2", 71)} />);
  view.rerender(<Panel data={journal({ e2: "todo", a4: "doing" }, "a4", 71, [change("a4", "start")])} />);
  expect(cues()).toEqual(["ribbon row"]);
  fx.tick(1000); await act(flush); t += 5000;
  view.rerender(<Panel data={journal({ e2: "todo", a4: "done" }, "e2", 72, [change("a4", "start"), change("a4", "done")])} />);
  expect(motion.log.map(l => `${l.kind}:${l.reason}`)).toEqual(["ribbon:rest"]);
  expect(cues()).toContain("mo-chalk");
});
