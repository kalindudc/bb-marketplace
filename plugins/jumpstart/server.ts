import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerCli } from "./src/cli";
import { failureTag, rpcContract } from "./src/contract";
import { describeFailures, kickThreads } from "./src/threads";

export default function jumpstart(bb: BbPluginApi): void {
  bb.rpc.register(rpcContract, {
    failures: ({ keys }) => describeFailures(bb.sdk, keys),
    kick: async ({ threadIds }) => ({ results: await kickThreads(bb.sdk, threadIds) }),
  });

  bb.events.on("thread.failed", ({ thread }) => {
    bb.rpc.experimental_invalidate([failureTag(thread.id)]);
  });

  registerCli(bb);
}
