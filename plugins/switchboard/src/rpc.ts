import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { HUE_IDS, isCollapseKey, MAX_ENTRIES, MAX_KEY_LENGTH } from "./layout";

const id = z.string().min(1).max(MAX_KEY_LENGTH).regex(/^\S+$/);
const list = z.array(id).max(MAX_ENTRIES);
const collapse = z.string().refine(isCollapseKey);
const writeId = z.string().min(1).max(200).regex(/^\S+$/);
const writeList = z.array(writeId).max(MAX_ENTRIES);
const container = z.string().min(1).max(200).regex(/^(loose|section:\S+|parent:\S+)$/)
  .transform((value) => value as import("./layout").ContainerKey);
const sortable = z.string().min(1).max(200).regex(/^(loose|section:\S+)$/)
  .transform((value) => value as import("./layout").ContainerKey);
const sortMode = z.enum(["manual", "recent", "status"]);
const sectionSort = z.record(z.string(), sortMode).refine((value) =>
  Object.keys(value).length <= MAX_ENTRIES && Object.keys(value).every((key) =>
    key.length <= MAX_KEY_LENGTH && /^(loose|section:\S+)$/.test(key)));
const sectionProjects = z.record(z.string(), id).refine((value) =>
  Object.keys(value).length <= MAX_ENTRIES && Object.keys(value).every((key) =>
    key.length <= MAX_KEY_LENGTH && /^(loose|section:\S+)$/.test(key)));
const snoozeEntry = z.object({ until: z.number().int().nonnegative(), at: z.number().int().nonnegative() }).strict();
const snoozes = z.record(id, snoozeEntry).refine((value) => Object.keys(value).length <= MAX_ENTRIES);
const threadIds = z.array(writeId).max(500);
const layout = z.object({
  sectionOrder: list,
  sectionHues: z.record(id, z.enum(HUE_IDS)).refine((hues) => Object.keys(hues).length <= MAX_ENTRIES),
  collapsed: z.array(collapse).max(MAX_ENTRIES),
  order: z.record(z.string().max(MAX_KEY_LENGTH).regex(/^(loose|section:\S+|parent:\S+)$/), list)
    .refine((order) => Object.keys(order).length <= MAX_ENTRIES),
  sectionSort, snoozes, sectionProjects,
}).strict();

export const rpcContract = defineRpcContract({
  getLayout: { input: z.null(), output: layout },
  setCollapsed: {
    input: z.object({ key: collapse, collapsed: z.boolean() }).strict(),
    output: z.object({ collapsed: z.array(collapse).max(MAX_ENTRIES) }).strict(),
  },
  setOrder: {
    input: z.object({ container, ids: writeList }).strict(),
    output: z.object({ ids: writeList }).strict(),
  },
  setSectionOrder: {
    input: z.object({ ids: writeList }).strict(),
    output: z.object({ ids: writeList }).strict(),
  },
  setSectionHue: {
    input: z.object({ sectionId: writeId, hue: z.enum(HUE_IDS).nullable() }).strict(),
    output: z.object({ sectionHues: z.record(writeId, z.enum(HUE_IDS)) }).strict(),
  },
  setSectionSort: {
    input: z.object({ container: sortable, mode: sortMode }).strict(),
    output: z.object({ sectionSort }).strict(),
  },
  setSectionProject: {
    input: z.object({ container: sortable, projectId: writeId.nullable() }).strict(),
    output: z.object({ sectionProjects }).strict(),
  },
  snooze: {
    input: z.object({ threadIds, until: z.number().int().nonnegative() }).strict(),
    output: z.object({ snoozes }).strict(),
  },
  unsnooze: {
    input: z.object({ threadIds }).strict(),
    output: z.object({ snoozes }).strict(),
  },
});
export type RpcContract = typeof rpcContract;
