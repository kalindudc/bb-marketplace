import { useMemo, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import { createCommentStore } from "./comments";
import { createLimiter } from "./limit";
import type { ReviewLoaders } from "./review";

// One comment store and one set of request limits for every Vantage surface in this window.
export const comments = createCommentStore(window);
const limitPatches = createLimiter(4);
const limitSides = createLimiter(2);

export function useLoaders(): ReviewLoaders {
  const rpc = useRpc<typeof rpcContract>();
  const ref = useRef(rpc);
  ref.current = rpc;
  return useMemo<ReviewLoaders>(() => ({
    patch: (input) => limitPatches(() => ref.current.call("patch", input)),
    fileSides: (input) => limitSides(() => ref.current.call("fileSides", input)),
    recordedEdits: (input) => ref.current.call("recordedEdits", input),
    commitFiles: (input) => ref.current.call("commitFiles", input),
  }), []);
}
