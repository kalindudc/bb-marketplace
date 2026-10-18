import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type {
  RegenerateTitleInput,
  RegenerateTitleOutput,
  UpdateSettingsInput,
  UpdateSettingsOutput,
} from "./rpc-shapes";

/** The RPC contract shared by the server and the frontend (see rpc-shapes.ts). */
export const PI_SERVICES_RPC = defineRpcContract({
  regenerateTitle: {
    input: z.object({ threadId: z.string() }) satisfies z.ZodType<RegenerateTitleInput>,
    output: z.object({ title: z.string() }) satisfies z.ZodType<RegenerateTitleOutput>,
  },
  updateSettings: {
    input: z.object({
      executable: z.string().min(1).nullish(),
      model: z.string().nullish(),
    }) satisfies z.ZodType<UpdateSettingsInput>,
    output: z.object({
      executable: z.string(),
      model: z.string(),
    }) satisfies z.ZodType<UpdateSettingsOutput>,
  },
});
