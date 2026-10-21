// Loom's host entry: runs on the machine that owns the project's checkout. Wiring only; the operations live in src/host/ops.ts.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./src/host-contract";
import * as ops from "./src/host/ops";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    ensureBranch: (input, { signal }) => ops.ensureBranch(input, signal),
    worktreeState: (input, { signal }) => ops.worktreeState(input, signal),
    commitAll: (input, { signal }) => ops.commitAll(input, signal),
    exec: (input, { signal }) => ops.exec(input, signal),
    diff: (input, { signal }) => ops.diff(input, signal),
    ensureWorktree: (input, { signal, experimental_paths }) => ops.ensureWorktree(input, experimental_paths.dataDir, signal),
    merge: (input, { signal }) => ops.merge(input, signal),
    resetHard: (input, { signal }) => ops.resetHard(input, signal),
    push: (input, { signal }) => ops.push(input, signal),
    prCreate: (input, { signal }) => ops.prCreate(input, signal),
    prState: (input, { signal }) => ops.prState(input, signal),
  },
});
