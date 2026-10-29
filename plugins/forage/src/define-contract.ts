import type { defineRpcContract } from "@get-bb/plugin-sdk";

export const defineContract: typeof defineRpcContract = ((contract: unknown) => contract) as typeof defineRpcContract;
