import { useEffect, useState } from "react";
import { experimental_useRpcQuery, useComposer, type ComposerSelection, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import { classStartRefusal, type ClassExecution, type ClassExecutionInput, type ClassModeFacts } from "../../shared/class-execution-contract";
import { readRemembered, writeRemembered } from "../kit";

/** The fields a class sets in the composer. Only provider and permission can refuse a start; model and reasoning are the person's to change. */
type Field = "providerId" | "model" | "reasoningLevel" | "permissionMode";
const SHOWN: Field[] = ["providerId", "model", "reasoningLevel"];

export function composerProjectId(composer: Pick<PluginComposerApi, "selection" | "scope">): string | null {
  return composer.selection?.projectId ?? (composer.scope.kind === "new-thread" ? composer.scope.projectId : null) ?? null;
}
function environmentId(selection: ComposerSelection | null): string | null {
  const env = selection?.environment as { environmentId?: unknown } | undefined;
  return typeof env?.environmentId === "string" ? env.environmentId : null;
}

/** The classExecution input for starting `classId` from this composer, or null while it has no project. */
export function classStartInput(classId: string, composer: Pick<PluginComposerApi, "selection" | "scope">): ClassExecutionInput | null {
  const projectId = composerProjectId(composer);
  if (!projectId) return null;
  return { classId, projectId, ...(composer.selection?.providerId ? { providerId: composer.selection.providerId } : {}), environmentId: environmentId(composer.selection), mode: "start" };
}

/** What setSelection gets: only the fields the class names. */
export function selectionFor(execution: ClassExecution): ComposerSelection {
  return { providerId: execution.providerId, ...(execution.model ? { model: execution.model } : {}), ...(execution.reasoningLevel ? { reasoningLevel: execution.reasoningLevel } : {}), ...(execution.permissionMode ? { permissionMode: execution.permissionMode } : {}) } as ComposerSelection;
}

/** Where the composer differs from what the class names, for provider, model and reasoning. A field the class leaves open never differs. */
export function classDifferences(execution: ClassExecution, selection: ComposerSelection | null): { field: Field; want: string; have: string | null }[] {
  const values = selection as Partial<Record<Field, string>> | null;
  return SHOWN.flatMap(field => { const want = execution[field]; const have = values?.[field] ?? null; return want && want !== have ? [{ field, want, have }] : []; });
}

/** The start the server will refuse from these pickers (a provider that can't carry the class's guard, or a wider permission), or null. */
export function startRefusal(facts: ClassModeFacts, selection: ComposerSelection | null): string | null {
  if (!selection) return null;
  const s = selection as Partial<Record<Field, string>>;
  return classStartRefusal(facts.execution ?? { providerId: s.providerId ?? "" }, { providerId: s.providerId ?? "", permissionMode: s.permissionMode ?? null, model: s.model ?? null, reasoningLevel: s.reasoningLevel ?? null }, facts.requiresPi);
}

/** "Claude Opus 5.5" for a model id; the provider and reasoning as they are. */
export function fieldWords(field: Field, value: string | null, model: (id: string | null) => string): string {
  if (value === null) return field === "model" ? "the provider's default model" : field === "reasoningLevel" ? "default reasoning" : "no provider";
  return field === "model" ? model(value) : field === "reasoningLevel" ? `${value} reasoning` : value;
}

const appliedKey = (key: string, classId: string) => `class-applied:${key}:${classId}`;
/** Picking a class again is a request for its settings, so the next banner applies them again. */
export function rearmClassSettings(composerKey: string, classId: string) { writeRemembered(appliedKey(composerKey, classId), false); }

/**
 * The class this draft starts as, resolved by the server, with its settings applied once per draft. Once applied, a later picker change is
 * the person's choice and is never undone; `apply` puts the class's settings back.
 */
export function useClassStart(classId: string | null) {
  const composer = useComposer();
  const input = classId ? classStartInput(classId, composer) : null;
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "classExecution", input: input ?? { classId: "none", projectId: "none", mode: "start" }, enabled: !!input });
  const facts = input ? query.data : undefined;
  const [applied, setApplied] = useState<ComposerSelection | null>(null);
  const [pending, setPending] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const execution = facts && facts.errors.length === 0 ? facts.execution : null;
  const apply = () => {
    if (!execution) return Promise.resolve();
    setPending(true); setApplyError(null);
    return composer.setSelection(selectionFor(execution)).then(result => setApplied(result), (err: unknown) => setApplyError(err instanceof Error ? err.message : String(err))).finally(() => setPending(false));
  };
  useEffect(() => {
    if (!classId || !execution) return;
    const key = appliedKey(composer.key, classId);
    if (readRemembered<boolean>(key)) return;
    writeRemembered(key, true);
    void apply();
  }, [classId, composer.key, execution]); // eslint-disable-line react-hooks/exhaustive-deps
  // A sent draft starts the next one fresh, so the next thread gets its class's settings too.
  useEffect(() => { if (!classId) return; return composer.onSubmitted(() => writeRemembered(appliedKey(composer.key, classId), false)); }, [classId, composer]);
  const settled = !pending && (applied !== null || applyError !== null || (classId ? readRemembered<boolean>(appliedKey(composer.key, classId)) === true : false));
  return { facts, error: input ? query.error : null, loading: !!input && query.isLoading, execution, applied, pending, settled, applyError, apply };
}
