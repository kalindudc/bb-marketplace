import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createCli } from "./src/cli";
import { buildOverview, type CollectDeps, type HostCall } from "./src/collect";
import { hostContract, rpcContract, type HostInput, type HostMethod, type HostOutput } from "./src/contract";
import { createEditIndex, findRecordedEdits, type EventsSdk } from "./src/edits";
import { loadCommitFiles, loadPatch } from "./src/sources";

const HOST_TIMEOUT_MS = 25_000;
const MAX_RECORDED_EDITS = 50;

export default function vantage(bb: BbPluginApi): void {
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  // HostCall's generic method name is what the client's per-method return type cannot see through.
  const host: HostCall = <M extends HostMethod>(method: M, input: HostInput<M>, options: { hostId: string; signal?: AbortSignal }) =>
    hostClient.call(method, input, { ...options, timeoutMs: HOST_TIMEOUT_MS }) as Promise<HostOutput<M>>;
  // bb.sdk only works while the plugin is bound, so it is read inside calls, never at load.
  const events: EventsSdk = { threads: { events: { list: (args) => bb.sdk.threads.events.list(args) } } };
  const edits = createEditIndex(events);
  const deps = (): CollectDeps => ({ sdk: bb.sdk, host, edits });

  bb.rpc.register(rpcContract, {
    overview: (input) => buildOverview(deps(), input),
    patch: (input) => loadPatch(deps(), input),
    commitFiles: (input) => loadCommitFiles(deps(), input),
    recordedEdits: async ({ threadIds, rawPaths }) => ({
      edits: await findRecordedEdits(events, threadIds, new Set(rawPaths), MAX_RECORDED_EDITS),
    }),
  });
  // `ancestorIds` runs from the parent up to the tree's root.
  const rootOf = async (threadId: string, signal: AbortSignal): Promise<string> => {
    const found = await bb.sdk.threads.experimental_listAncestors({ threadIds: [threadId], signal });
    return found.threads.find((entry) => entry.threadId === threadId)?.ancestorIds.at(-1) ?? threadId;
  };
  bb.cli.register(createCli((input, signal) => buildOverview(deps(), input, signal), rootOf));
  bb.log.info("loaded");
}
