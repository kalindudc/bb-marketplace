import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { requireUserAct, commitUserAct, type UserActReceipt } from "./authority";
import { homedir } from "node:os";
import { z } from "zod";
import { effectiveExecution } from "../shared/class-execution";
import { tags, type ClassEditInput, type OverrideSelection } from "../shared/contract";
import type { SettingsChange } from "../shared/settings";
import { RegistryConflict, type CharacterEdit } from "./registry";
import { registryProjects } from "./backup/index";
import type { TavernRuntime } from "./runtime";

type Where = { classId: string; projectId: string | null; target: "global" | "project" };
type Reset = OverrideSelection & { field?: string };
type CharacterWhere = { characterId: string; projectId?: string | null; target?: "global" | "project"; revision?: string };
const RUNNING = new Set(["working", "idle", "waiting"]);
const problemsOf = (error: unknown) => error instanceof z.ZodError ? error.issues.map(i => `${i.path.join(".") || "class"}: ${i.message}`) : [error instanceof Error ? error.message : String(error)];
const tilde = (path: string) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
/** A history line per field. The role prompt is long, so it records its size, not its text; the file keeps the text. */
const historyValue = (field: string, value: unknown) => field === "body" && typeof value === "string" ? `${value.split("\n").length} lines` : value ?? null;

/** Only the person at the client may change a class: no agent tool or plugin call reaches these writes (as settings and away). */
export function requireClassClient(context?: ExperimentalPluginRpcHandlerContext) {
  return requireUserAct(context, "saveClass");
}

export function classEditorHandlers(runtime: TavernRuntime) {
  const projectPath = async (projectId: string | null) => {
    if (!projectId) return null;
    await runtime.prepareRegistry(projectId, true);
    return runtime.projectPath(projectId);
  };
  const changed = () => {
    try { runtime.bb.rpc.experimental_invalidate([tags.registry(), tags.rows(), tags.room(), ...runtime.keeper.store.all("members").map(m => tags.thread(m.threadId))]); }
    catch (error) { runtime.bb.log.warn(`Registry change committed, but its views could not refresh: ${String(error)}`); }
  };
  const record = (reason: string, changes: SettingsChange[]) => runtime.settings?.recordExternal("user", reason, changes);
  const where = (target: "global" | "project", projectId: string | null) => target === "global" ? "every project" : `project ${projectId}`;
  const saveCharacter = async (req: CharacterWhere, edit: CharacterEdit, context: ExperimentalPluginRpcHandlerContext | undefined, receipt: UserActReceipt | undefined, act: "saveCharacterVoice" | "saveCharacterAvatar") => {
    requireUserAct(context, act);
    const { characterId, target = "global", projectId = null } = req;
    if ((target === "project" || projectId) && !req.revision) throw new Error("Reopen the character editor before saving to a scoped definition.");
    const path = await projectPath(projectId), selection = { target, projectPath: path };
    const revision = req.revision ?? runtime.registry.characterLayers(characterId, path).revision;
    const preview = runtime.registry.previewCharacter(characterId, edit, selection, revision);
    if (!preview.changes.length) return preview.definition as import("../shared/schema").CharacterDef;
    const saved = commitUserAct(runtime.keeper.store, () => runtime.keeper.now(), receipt, () => {
      record(`Characters page: saved ${characterId} (${where(target, projectId)}).`, preview.changes.map(c => ({
        key: `character.${characterId}.${c.field}`, from: historyValue(c.field, c.from) as never, to: historyValue(c.field, c.to) as never, kind: "set" as const,
      })));
      return runtime.registry.saveCharacter(characterId, edit, { ...selection, revision });
    });
    changed();
    return saved;
  };
  const reset = (req: Reset & { revision: string }, path: string | null, receipt?: UserActReceipt) => {
    const selection = { target: req.target, projectPath: path, revision: req.revision };
    const removed = runtime.registry.resetOverride(req.kind, req.id, selection, req.field, apply => {
      commitUserAct(runtime.keeper.store, () => runtime.keeper.now(), receipt, () => {
        apply();
        record(`Registry: removed the ${req.target} override of ${req.id}${req.field ? ` (${req.field})` : ""} (${where(req.target, req.projectId)}).`,
          [{ key: `${req.kind}.${req.id}${req.field ? `.${req.field}` : ""}`, from: "overridden", to: null, kind: "unset" }]);
      });
    });
    changed();
    return removed;
  };
  return {
    registryOverrides: async () => {
      const global = runtime.registry.overrides({ target: "global" });
      const rows = global.rows.map(row => ({ ...row, projectId: null as string | null, projectName: null as string | null }));
      const problems = global.problems.map(p => `${p.path}: ${p.message}`);
      const projects = await registryProjects(runtime.bb, "report");
      problems.push(...projects.problems);
      for (const project of projects.projects) {
        try {
          const local = runtime.registry.overrides({ target: "project", projectPath: project.path });
          rows.push(...local.rows.map(row => ({ ...row, projectId: project.id, projectName: project.name })));
          problems.push(...local.problems.map(p => `${project.name}: ${p.path}: ${p.message}`));
        } catch (error) { problems.push(`${project.name}: ${problemsOf(error).join("; ")}`); }
      }
      return { rows, problems };
    },
    registryDefinition: async ({ kind, id, projectId, target }: OverrideSelection) => {
      const path = await projectPath(projectId);
      const projectName = projectId ? runtime.registryProjectName(projectId) : null;
      return { ...runtime.registry.overrideSheet(kind, id, { target, projectPath: path }), canViewProject: !!path, projectName };
    },
    previewOverrideReset: async ({ kind, id, target, projectId, field }: Reset, context?: ExperimentalPluginRpcHandlerContext) => {
      requireUserAct(context, "resetOverride");
      try { return { code: "ok" as const, ...runtime.registry.previewReset(kind, id, { target, projectPath: await projectPath(projectId) }, field) }; }
      catch (error) { return { code: "invalid" as const, problems: problemsOf(error) }; }
    },
    resetOverride: async (req: Reset & { revision: string }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireUserAct(context, "resetOverride");
      try {
        reset(req, await projectPath(req.projectId), receipt);
        return { code: "ok" as const };
      } catch (error) {
        if (error instanceof RegistryConflict) return { code: "stale" as const };
        return { code: "invalid" as const, problems: problemsOf(error) };
      }
    },
    saveCharacterVoice: (req: CharacterWhere & { voice: CharacterEdit }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) =>
      saveCharacter(req, req.voice, context, receipt, "saveCharacterVoice"),
    saveCharacterAvatar: (req: CharacterWhere & { avatar: string }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) =>
      saveCharacter(req, { avatar: req.avatar }, context, receipt, "saveCharacterAvatar"),
    classEditor: async ({ classId, projectId }: { classId: string; projectId: string | null }) => {
      const path = await projectPath(projectId);
      const { current, layers, revision } = runtime.registry.classLayers(classId, path);
      return {
        current, revision, projectPath: path, projectName: projectId ? runtime.registryProjectName(projectId) : null, layers,
        models: effectiveExecution(current, runtime.config().classes[classId]),
        running: runtime.keeper.store.all("members").filter(m => m.classId === classId && RUNNING.has(m.state)).length,
      };
    },
    classPreview: async ({ classId, projectId, target, edit }: Where & { edit: ClassEditInput }) => {
      try {
        const out = runtime.registry.previewClass(classId, edit, { target, projectPath: await projectPath(projectId) });
        return { code: "ok" as const, path: out.path, shadowedBy: out.shadowedBy, changes: out.changes, widening: out.widening };
      } catch (error) { return { code: "invalid" as const, problems: problemsOf(error) }; }
    },
    saveClass: async ({ classId, projectId, target, edit, revision }: Where & { edit: ClassEditInput; revision: string }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireClassClient(context);
      const path = await projectPath(projectId);
      try {
        const preview = runtime.registry.previewClass(classId, edit, { target, projectPath: path }, revision);
        if (!preview.changes.length) return { code: "ok" as const, class: preview.draft, path: preview.path };
        const saved = commitUserAct(runtime.keeper.store, () => runtime.keeper.now(), receipt, () => {
          record(`Classes page: saved the ${preview.draft.label} class to ${tilde(preview.path)} (${where(target, projectId)}).`,
            preview.changes.map(c => ({ key: `class.${classId}.${c.field}`, from: historyValue(c.field, c.from) as never, to: historyValue(c.field, c.to) as never, kind: "set" as const })));
          return runtime.registry.saveClass(classId, edit, { target, projectPath: path, revision });
        });
        changed();
        return { code: "ok" as const, class: saved, path: preview.path };
      } catch (error) {
        if (error instanceof RegistryConflict) return { code: "stale" as const };
        return { code: "invalid" as const, problems: problemsOf(error) };
      }
    },
    removeClassOverride: async ({ classId, projectId, target, revision }: Where & { revision: string }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireClassClient(context);
      const path = await projectPath(projectId);
      try {
        if (runtime.registry.classLayers(classId, path).revision !== revision) throw new RegistryConflict("This class changed since you opened it.");
        const preview = runtime.registry.previewReset("class", classId, { target, projectPath: path });
        const removed = reset({ kind: "class", id: classId, target, projectId, revision: preview.revision }, path, receipt);
        return { code: "ok" as const, path: removed };
      } catch (error) {
        if (error instanceof RegistryConflict) return { code: "stale" as const };
        return { code: "invalid" as const, problems: problemsOf(error) };
      }
    },
  };
}
