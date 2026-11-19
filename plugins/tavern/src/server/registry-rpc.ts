import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { requireUserAct, commitUserAct, type UserActReceipt } from "./authority";
import { homedir } from "node:os";
import { z } from "zod";
import { effectiveExecution } from "../shared/class-execution";
import { tags, type ClassEditInput } from "../shared/contract";
import type { SettingsChange } from "../shared/settings";
import { RegistryConflict } from "./registry";
import type { TavernRuntime } from "./runtime";

type Where = { classId: string; projectId: string | null; target: "global" | "project" };
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
    await runtime.prepareRegistry(projectId);
    return runtime.projectPath(projectId);
  };
  const changed = () => runtime.bb.rpc.experimental_invalidate([tags.registry(), tags.rows(), tags.room(), ...runtime.keeper.store.all("members").map(m => tags.thread(m.threadId))]);
  const record = (reason: string, changes: SettingsChange[]) => runtime.settings?.recordExternal("user", reason, changes);
  const where = (target: "global" | "project", projectId: string | null) => target === "global" ? "every project" : `project ${projectId}`;
  return {
    classEditor: async ({ classId, projectId }: { classId: string; projectId: string | null }) => {
      const path = await projectPath(projectId);
      const { current, layers, revision } = runtime.registry.classLayers(classId, path);
      return {
        current, revision, projectPath: path, layers,
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
        return commitUserAct(runtime.keeper.store, () => runtime.keeper.now(), receipt, () => {
        const preview = runtime.registry.previewClass(classId, edit, { target, projectPath: path });
        const saved = runtime.registry.saveClass(classId, edit, { target, projectPath: path, revision });
        record(`Classes page: saved the ${saved.label} class to ${tilde(preview.path)} (${where(target, projectId)}).`,
          preview.changes.map(c => ({ key: `class.${classId}.${c.field}`, from: historyValue(c.field, c.from) as never, to: historyValue(c.field, c.to) as never, kind: "set" as const })));
        changed();
        return { code: "ok" as const, class: saved, path: preview.path };
        });
      } catch (error) {
        if (error instanceof RegistryConflict) return { code: "stale" as const };
        return { code: "invalid" as const, problems: problemsOf(error) };
      }
    },
    removeClassOverride: async ({ classId, projectId, target, revision }: Where & { revision: string }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireClassClient(context);
      const path = await projectPath(projectId);
      try {
        return commitUserAct(runtime.keeper.store, () => runtime.keeper.now(), receipt, () => {
        const removed = runtime.registry.removeClassOverride(classId, { target, projectPath: path, revision });
        record(`Classes page: removed the ${target} override of ${classId} (${tilde(removed)}); the class falls back to the layer below.`,
          [{ key: `class.${classId}`, from: tilde(removed), to: null, kind: "unset" }]);
        changed();
        return { code: "ok" as const, path: removed };
        });
      } catch (error) {
        if (error instanceof RegistryConflict) return { code: "stale" as const };
        return { code: "invalid" as const, problems: problemsOf(error) };
      }
    },
  };
}
