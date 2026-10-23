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
    changedFiles: (input, { signal }) => ops.changedFiles(input, signal),
    filePatch: (input, { signal }) => ops.filePatch(input, signal),
    ensureWorktree: (input, { signal, experimental_paths }) => ops.ensureWorktree(input, experimental_paths.dataDir, signal),
    merge: (input, { signal }) => ops.merge(input, signal),
    resetHard: (input, { signal }) => ops.resetHard(input, signal),
    fetchBranch: (input, { signal }) => ops.fetchBranch(input, signal),
    push: (input, { signal }) => ops.push(input, signal),
    prCreate: (input, { signal }) => ops.prCreate(input, signal),
    prState: (input, { signal }) => ops.prState(input, signal),
    remotes: (input, { signal }) => ops.remotes(input, signal),
    ghStatus: (input, { signal }) => ops.ghStatus(input, signal),
    trialWorktree: (input, { signal, experimental_paths }) => ops.trialWorktree(input, experimental_paths.dataDir, signal),
    landedOn: (input, { signal }) => ops.landedOn(input, signal),
  },
});
