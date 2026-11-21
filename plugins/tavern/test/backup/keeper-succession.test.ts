// @vitest-environment node
import { expect, it } from "vitest";
import { KeeperStore } from "../../src/server/keeper/store";
import { KeeperSuccessionStore } from "../../src/server/keeper/succession-store";
import { setup } from "../server/runtime-fixture";
import { fixture } from "./helpers";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";

it.each(["proposed", "recovering", "done"] as const)("does not resume an unattested %s operation after a portable restore", state => {
  const f = setup();
  const dest = fixture();
  const op = f.k.succession.propose("lead", { kind: "user" }, "Fresh context");
  if (state !== "proposed") {
    f.k.succession.prepare(op.id, [], { projectId: "project", environmentId: "env", providerId: "pi", at: f.time() });
    f.k.succession.bindCandidate(op.id, "successor");
    if (state === "done") f.k.succession.cutover(op.id, [({ successor }) => { f.k.bind(successor, "keeper", null, "project"); }]);
    else f.k.succession.recovering(op.id, "Lost host reply");
  }
  const source = new BackupRecords(f.k.store.db, new SettingsStore(f.k.store.db, f.time), f.time);
  const captured = source.capture();
  const snapshotRow = captured.tables.tavern_records!.rows.find(row => row.kind === "keeperSuccessions" && row.id === op.id)!;
  expect(JSON.parse(String(snapshotRow.data))).not.toHaveProperty("spawnIntent");
  dest.backup.records.restore(captured);
  const succession = new KeeperSuccessionStore(new KeeperStore(dest.db), () => 1000);
  expect(succession.get(op.id)).toMatchObject({ state: state === "done" ? "done" : "failed", restored: true });
  expect(succession.current("lead")).toBe(state === "done" ? "successor" : "lead");
  if (state === "recovering") expect(succession.fence("successor")).toEqual({ kind: "candidate" });
  if (state !== "done") expect(succession.fence("lead")).toBeNull();
  f.k.store.db.close();
});
