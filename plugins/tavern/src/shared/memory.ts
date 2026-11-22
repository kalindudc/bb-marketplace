import { z } from "zod";
import { defineContract } from "./define-contract";

const id = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/);
const profileId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const classId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const path = z.string().max(1024).regex(/^(?:\/|[a-zA-Z]:[\\/]|\\\\)[^\0\r\n]*$/, "Use an absolute executable path.");
const short = z.string().trim().min(1).max(160).regex(/^[^\0\r\n]+$/);
const reason = z.string().trim().min(1).max(500);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const memoryKind = z.enum(["finding", "decision", "outcome", "reference"]);
export const memoryStatus = z.enum(["accepted", "superseded", "retired"]);
const visibility = z.enum(["included", "excluded"]);
const commit = z.string().regex(/^[0-9a-f]{7,64}$/i);
const reference = z.string().trim().min(1).max(300).regex(/^[^\x00-\x1f\x7f]+$/);
export const memoryDraft = z.object({
  kind: memoryKind, title: short,
  body: z.string().trim().min(1).max(4000).refine(value => new TextEncoder().encode(value).byteLength <= 8192 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), "Use at most 8 KiB of plain text."),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["command", "file"]), value: z.string().trim().min(1).max(1000) }).strict(),
    z.object({ kind: z.literal("url"), value: z.url({ protocol: /^https?$/ }).max(1000) }).strict(),
    z.object({ kind: z.literal("commit"), value: commit }).strict(),
  ]),
  appliesTo: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("commit"), value: commit }).strict(),
    z.object({ kind: z.literal("release"), value: short }).strict(),
    z.object({ kind: z.literal("date"), value: z.iso.date() }).strict(),
  ]),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)).max(12).refine(tags => new Set(tags).size === tags.length, "Tags must be unique."),
}).strict();
export type MemoryDraft = z.infer<typeof memoryDraft>;
export const memoryNote = memoryDraft.extend({
  id, project: id, quest: id.nullable(), author: z.object({ thread: id, classId }).strict(), curator: id.nullable(),
  status: memoryStatus, supersedes: id.nullable(), memory: visibility, exclusionReason: reason.nullable(),
  reviewedBy: id.nullable(), reviewedAt: time.nullable(), createdAt: time, updatedAt: time,
}).superRefine((note, ctx) => {
  if ((note.memory === "excluded") !== (note.exclusionReason !== null)) ctx.addIssue({ code: "custom", path: ["exclusionReason"], message: "Only excluded notes have an exclusion reason." });
  if ((note.reviewedBy === null) !== (note.reviewedAt === null)) ctx.addIssue({ code: "custom", path: ["reviewedAt"], message: "Review requires a reviewer and a time." });
  if (note.updatedAt < note.createdAt || note.reviewedAt !== null && (note.reviewedAt < note.createdAt || note.reviewedAt > note.updatedAt))
    ctx.addIssue({ code: "custom", path: ["updatedAt"], message: "Note timestamps are out of order." });
  if (note.supersedes === note.id) ctx.addIssue({ code: "custom", path: ["supersedes"], message: "A note cannot supersede itself." });
});
export type MemoryNote = z.infer<typeof memoryNote>;
const text = z.string().trim().max(500);
const target = { id, expectedUpdatedAt: time };
const curate = [
  z.object({ action: z.literal("include"), ...target }).strict(),
  z.object({ action: z.literal("exclude"), ...target, reason }).strict(),
  z.object({ action: z.literal("supersede"), ...target, note: memoryDraft }).strict(),
  z.object({ action: z.literal("retire"), ...target }).strict(),
] as const;
export const memoryCurateInput = z.discriminatedUnion("action", curate);
export const memoryManageInput = z.discriminatedUnion("action", [...curate, z.object({ action: z.literal("edit"), ...target, note: memoryDraft }).strict()]);
export type MemoryManageInput = z.infer<typeof memoryManageInput>;
export const memoryToolInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("find"), text: text.optional(), kind: memoryKind.optional(), limit: z.number().int().min(1).max(10).optional(), offset: z.number().int().min(0).max(100_000).optional() }).strict(),
  z.object({ op: z.literal("save"), note: memoryDraft, boardQuestId: id.optional() }).strict(),
  z.object({ op: z.literal("unreviewed"), offset: z.number().int().min(0).max(100_000).optional() }).strict(),
  z.object({ op: z.literal("read"), id }).strict(),
  z.object({ op: z.literal("curate"), ...target, action: z.enum(["include", "exclude", "supersede", "retire"]), reason: reason.optional(), note: memoryDraft.optional() }).strict(),
]);
export type MemoryToolInput = z.infer<typeof memoryToolInput>;
export const memoryFindQuery = z.object({ text, project: id, kind: memoryKind.nullable(), limit: z.number().int().min(1).max(25) }).strict();
export type MemoryFindQuery = z.infer<typeof memoryFindQuery>;
export const memoryListInput = memoryFindQuery.extend({ status: memoryStatus.nullable(), memory: visibility.nullable(), offset: z.number().int().min(0).max(100_000) }).strict();
export type MemoryListInput = z.infer<typeof memoryListInput>;
export const memoryExternalCurate = z.object({ action: z.enum(["include", "exclude", "supersede"]), note: memoryNote, reference, replacement: memoryNote.nullable() }).strict();

const commands = { save: path, find: path, curate: path };
const timeoutSeconds = z.number().int().min(1).max(120);
const fields = { id: profileId.refine(value => value !== "builtin", "Builtin is reserved."), name: short, ...commands, timeoutSeconds };
const profileInput = z.object(fields).strict();
const storedProfile = z.object({ ...fields, hostId: id }).strict();
const unique = (config: { active: string; profiles: readonly { id: string }[] }) => {
  const ids = new Set(config.profiles.map(profile => profile.id));
  return ids.size === config.profiles.length && (config.active === "builtin" || ids.has(config.active));
};
const validConfig = { message: "Profile IDs must be unique and the active store must exist." };
export const memoryConfigInput = z.object({ active: profileId, profiles: z.array(profileInput).max(20) }).strict().refine(unique, validConfig);
export const memoryConfig = z.object({ active: profileId, profiles: z.array(storedProfile).max(20) }).strict().refine(unique, validConfig);
export type MemoryConfigInput = z.infer<typeof memoryConfigInput>;
export type MemoryProfile = z.infer<typeof storedProfile>;
export const MEMORY_SETTINGS_ONLY = "Change the active store and command profiles in Settings → Memory profiles.";

const blockedRoots = z.array(z.string().min(1)).max(20_000);
export const memoryPreflightInput = z.object({ ...commands, blockedRoots, timeoutSeconds }).strict();
export const memoryPreflightOutput = z.object(commands).strict();
export const memoryRunInput = z.object({ path, blockedRoots, timeoutSeconds, op: z.enum(["find", "save", "curate"]), content: z.string().min(1).max(65_536) }).strict();
export const memoryRunOutput = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), output: z.string().max(262_144) }),
  z.object({ outcome: z.literal("failed"), code: z.enum(["path", "process", "timeout", "exit", "contract"]), message: z.string().max(600) }),
]);
const reviewRow = z.object({ id, title: short, author: id, curator: id.nullable(), createdAt: time, updatedAt: time });
export type MemoryReviewRow = z.infer<typeof reviewRow>;
const configView = z.object({ revision: time, config: memoryConfigInput });
export const memoryContract = defineContract({
  memorySettings: { input: z.null(), output: configView, tags: () => ["tavern:memory-config"] },
  memoryConfigure: { input: z.object({ revision: time, config: memoryConfigInput }).strict(), output: configView },
  memoryProjects: { input: z.null(), output: z.array(z.object({ id, name: z.string() })) },
  memoryList: { input: memoryListInput, output: z.object({ store: z.string(), external: z.boolean(), notes: z.array(memoryNote), unreviewed: z.array(reviewRow), more: z.boolean(), recorded: z.boolean().optional(), people: z.record(id, z.string()).optional(), previousTitles: z.record(id, short).optional() }), tags: () => ["tavern:memory"] },
  memoryPrevious: { input: z.object({ project: id, id }).strict(), output: memoryNote.nullable(), tags: () => ["tavern:memory"] },
  memoryManage: { input: memoryManageInput, output: memoryNote },
});
