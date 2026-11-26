import type { ClassExecutionInput, ClassModeFacts } from "../shared/class-execution-contract";
import { CLASS_BODY_LIMIT, classRules } from "../shared/class-rules";
import { resolveHireExecution } from "./execution";
import type { RegistrySnapshot } from "./registry";
import type { TavernRuntime } from "./runtime";

export function staffingLimits(config: ReturnType<TavernRuntime["config"]>) {
  return { partyMax: config.keepers.partyMax, rangerMax: config.keepers.rangerMax, rangerMinutes: config.knobs.rangerTimeboxMaxMinutes };
}

export async function classExecutionFacts(runtime: TavernRuntime, input: ClassExecutionInput, prepared?: RegistrySnapshot): Promise<ClassModeFacts> {
  const out: ClassModeFacts = { execution: null, fields: [], errors: [], notes: [], requiresPi: false, projectOverrides: [], body: { bytes: 0, limit: CLASS_BODY_LIMIT } };
  try {
    const projectId = input.projectId || undefined;
    const snapshot = projectId ? prepared ?? await runtime.prepareRegistry(projectId) : runtime.snapshot();
    const role = snapshot.classes.find(role => role.id === input.classId);
    if (!role) { out.errors.push(`Unknown class: ${input.classId}`); return out; }
    out.body.bytes = Buffer.byteLength(role.body);
    const projectPath = projectId ? runtime.projectPath(projectId) : null;
    const file = runtime.registry.sourceFile("class", role.id, projectPath);
    const fileField = (field: string, value: string | null, key = field): ClassModeFacts["fields"][number] => {
      const { source, path } = runtime.registry.fieldFile("class", role.id, key, projectPath);
      return { field, value, source: source === "project" ? "project-file" : source === "global" ? "user-file" : "shipped-file", ...(path ? { path } : {}) };
    };
    const requestedPreset = typeof role.scope === "string" ? role.scope : role.scope?.preset ?? ({ keeper: "open", ranger: "readonly", smith: "worktree", warden: "checker" }[role.id] ?? "open");
    const scoped = !!runtime.scopes && runtime.scopes.api.shouldScope(role.id, input.mode === "hire" ? "hire" : "direct");
    const forcePermission = !!runtime.scopes && input.mode === "hire";
    const kind = role.id === "keeper" ? "keeper" : input.mode === "hire" ? "member" : "solo";
    for (const [field, key] of [["provider", "provider"], ["model", "model"], ["reasoning", "reasoning"]] as const) {
      const override = runtime.config().classes[role.id];
      out.fields.push({ ...fileField(field, role[key]), ...(override && Object.hasOwn(override, key) ? { source: "settings" as const } : {}), ...(!role[key] ? { source: field === "provider" && input.mode === "hire" ? "keeper" as const : "provider-default" as const, ...(field === "provider" ? input.mode === "hire" ? { varies: "keeper" as const } : { rule: "Uses the provider selected in the composer." } : {}) } : {}) });
    }
    if (role.id === "warden" && input.mode === "hire" && !input.makerThreadId) Object.assign(out.fields.find(field => field.field === "model")!, { varies: "maker", rule: "Keeps the configured model when it is already a different family from the maker; otherwise chooses a known different-family model, or labels the unestablished check." });
    out.fields.push({ ...fileField("permission", forcePermission ? "full" : role.permission), ...(forcePermission ? { source: "forced" as const, rule: "The provider runs at full permission. Act guard checks recognized acts, not general tool access." } : {}) }, { ...fileField("scope", requestedPreset), ...(!role.scope ? { source: "preset" as const } : {}) },
      { ...fileField("environment", input.mode === "hire" ? role.environment : null), ...(input.mode === "start" ? { source: "role" as const, rule: "Uses the environment selected in the composer; class worktree preference applies only to hires." } : {}) },
      { ...fileField("role prompt", `${out.body.bytes} bytes`, "body"), rule: classRules(kind) },
      { field: "tools", value: kind === "keeper" ? ["journal", ...runtime.toolNames.filter(name => !["tavern_report", "tavern_request_sources"].includes(name))].join(", ") : kind === "member" ? "journal, tavern_memory, tavern_report, tavern_request_sources, tavern_status (own brief only)" : "journal, tavern_memory", source: "role" },
      { ...fileField("characters", role.characters.join(", ") || "None"), rule: "Only these, in this order; the first free character is chosen. None chosen means no character name. When all are busy the first is reused with a unique display name." });
    if (role.id === "keeper") {
      const { partyMax, rangerMax, rangerMinutes } = staffingLimits(runtime.config());
      out.fields.push({ field: "party cap", value: String(partyMax), source: "settings", rule: "keepers.partyMax" },
        { field: "Ranger count", value: String(rangerMax), source: "settings", rule: "keepers.rangerMax" },
        { field: "Ranger minutes", value: String(rangerMinutes), source: "settings", rule: "knobs.rangerTimeboxMaxMinutes" });
    }
    if (file.source === "project" && file.path) {
      const patch = runtime.registry.patchedFields("class", role.id, projectPath);
      out.projectOverrides.push(...(patch ?? ["provider", "model", "reasoning", "permission", "hires", "body"]).map(field => ({ field, path: file.path!, format: patch ? "patch" as const : "full" as const, message: patch
        ? `This project's ${role.label} file overrides ${field}. Other fields inherit.`
        : `This project's ${role.label} file replaces the whole class, including ${field}. Review it before starting or hiring.` })));
    }
    if (!projectId) {
      for (const field of out.fields) if (field.field !== "tools" && !(field.field === "permission" && forcePermission)) field.dependsOnProject = true;
      out.notes.push("Execution depends on the project. Shown values use only user-level and built-in layers; select a project to verify its class overrides, scope policy and model catalog.");
    }
    if (!(input.mode === "start" ? role.startable : role.id === "keeper" || role.hireable)) {
      const problem = `The ${role.label} class cannot be ${input.mode === "start" ? "started" : "hired"} here.`;
      if (projectId) out.errors.push(problem);
      else out.notes.push(`User-level/built-in baseline: ${problem} This also depends on the project.`);
    }
    const invalid = role.characters.filter(id => !snapshot.characters.some(character => character.id === id && character.classes.includes(role.id)));
    if (invalid.length) {
      const problem = `Unknown or incompatible character in ${role.label}: ${invalid.join(", ")}.`;
      if (projectId) out.errors.push(`${problem} Fix the class\'s character pool.`);
      else out.notes.push(`${problem} Its full character pool depends on the project.`);
    }
    if (out.body.bytes > CLASS_BODY_LIMIT) out.errors.push(`Class body is ${out.body.bytes} bytes; the limit is ${CLASS_BODY_LIMIT} UTF-8 bytes. Shorten the body before starting.`);
    let preset = requestedPreset;
    if (scoped) {
      try {
        const resolution = await runtime.scopes!.resolve(role.id, projectId, undefined, role);
        preset = resolution.scope.preset;
        out.notes.push(...resolution.problems);
      } catch (error) { out.errors.push(`Cannot resolve class scope: ${error instanceof Error ? error.message : String(error)}`); return out; }
    }
    const scopeField = out.fields.find(field => field.field === "scope")!;
    scopeField.value = preset;
    if (requestedPreset !== preset) {
      scopeField.source = "preset";
      scopeField.substitution = { from: requestedPreset, to: preset, reason: "Class files may only narrow the shipped scope preset." };
    }
    out.requiresPi = scoped && (preset === "checker" || runtime.config().scopes.mode === "enforce" && preset !== "open");
    if (out.requiresPi) {
      const provider = out.fields.find(field => field.field === "provider")!;
      provider.value = "pi";
      provider.source = "forced";
      provider.rule = "Required by the class's guard.";
      delete provider.varies;
      delete provider.dependsOnProject;
      delete provider.path;
    }
    if (!projectId) return out;
    const providerId = role.provider ?? input.providerId ?? (out.requiresPi ? "pi" : undefined);
    if (!providerId || out.errors.length) return out;
    let maker;
    if (input.makerThreadId) {
      const thread = await runtime.bb.sdk.threads.get({ threadId: input.makerThreadId });
      maker = { providerId: thread.providerId, model: (await runtime.bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id }))?.model ?? null, environmentId: thread.environmentId };
    }
    let modelLabel: string | undefined;
    const { notes, checkIndependence: _independence, ...execution } = await resolveHireExecution(runtime.bb, forcePermission ? { ...role, permission: "full" } : role, {
      providerId, projectId, environmentId: input.environmentId ?? null, scoped: scoped && preset !== "open", maker, dryRun: true,
      onModelResolved: model => { modelLabel = model.displayName; },
    });
    out.execution = execution; out.notes.push(...notes);
    for (const [field, key, configured] of [["provider", "providerId", providerId], ["model", "model", role.model], ["reasoning", "reasoningLevel", role.reasoning], ["permission", "permissionMode", role.permission]] as const) {
      const fact = out.fields.find(fact => fact.field === field)!;
      const value = execution[key] ?? null;
      fact.value = value;
      if (field === "model" && modelLabel) fact.valueLabel = modelLabel;
      if (value && value !== configured) {
        fact.substitution = { from: configured ?? "provider default", to: value, reason: notes.join(" ") || (field === "permission" ? "Scoped execution uses full provider permission; Act guard checks recognized acts." : "Resolved against the provider catalog.") };
        fact.source = (field === "provider" && out.requiresPi) || (field === "permission" && forcePermission) ? "forced" : "catalog-default";
      }
    }
  } catch (error) { out.errors.push(error instanceof Error ? error.message : String(error)); }
  return out;
}
