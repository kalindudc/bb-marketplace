// The page's copy of the RPC contract for bb's query hooks: the same methods and tags, with schemas that pass every value
// through, so zod and the spec parser stay out of the app bundle. The server validates each input and output.
import type { StandardSchemaV1 } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import { RPC_TAGS } from "../rpc-tags";

const unchecked: StandardSchemaV1 = { "~standard": { version: 1, vendor: "loom", validate: (value: unknown) => ({ value }) } };

export const contract = Object.fromEntries(Object.entries(RPC_TAGS).map(([method, tags]) => [method, { input: unchecked, output: unchecked, ...tags }])) as unknown as typeof rpcContract;
