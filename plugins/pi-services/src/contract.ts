import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type {
  GetSettingsInput,
  GetSettingsOutput,
  ListModelsInput,
  ListModelsOutput,
  PiModelInfo,
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
  listModels: {
    input: z.object({ search: z.string().optional() }) satisfies z.ZodType<ListModelsInput>,
    output: z.object({
      models: z.array(
        z.object({
          id: z.string(),
          provider: z.string(),
          model: z.string(),
          thinking: z.boolean(),
          images: z.boolean(),
        }),
      ) satisfies z.ZodType<PiModelInfo[]>,
    }) satisfies z.ZodType<ListModelsOutput>,
  },
  getSettings: {
    input: z.object({}).strict() satisfies z.ZodType<GetSettingsInput>,
    output: z.object({
      executable: z.string(),
      model: z.string(),
    }) satisfies z.ZodType<GetSettingsOutput>,
  },
});
