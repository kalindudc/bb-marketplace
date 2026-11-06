// The forge boundary: every host call that goes to a pull request's forge (gh or a forge command) passes through here.
// An answer the host contract refuses there was printed by the forge's own command, so it becomes a ForgeContractError,
// which pauses the project with the fix (failures.ts); the same refusal from any other host call stays Loom's own.
import { ForgeContractError } from "./failures";
import type { HostMethod } from "./host-contract";
import type { HostPort } from "./ports";

const FORGE_METHODS: ReadonlySet<HostMethod> = new Set<HostMethod>(["prBatch", "prFeedback", "prState", "prCreate", "prEdit", "prReady", "prReply", "prRetarget", "prRequestReview", "prReviewState", "prMerge"]);

/** The host port the engine calls, with forge calls passed through the forge boundary. */
export function forgeBoundary(host: HostPort): HostPort {
  return {
    call: async (hostId, method, input) => {
      if (!FORGE_METHODS.has(method)) return host.call(hostId, method, input);
      try {
        return await host.call(hostId, method, input);
      } catch (error) {
        const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
        if (code !== "invalid_output") throw error;
        throw new ForgeContractError(method, error instanceof Error ? error.message : String(error), Reflect.get(error as object, "issues"));
      }
    },
  };
}
