import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cliCommand, experimental_PluginRpcRefusal, PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError, type BbPluginApi, type ExperimentalPluginRpcHandlerContext, type ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { KeeperStore } from "../keeper/store";
import { commitUserAct, requireUserAct, userActHandlers, type UserActReceipt } from "../authority";
import { SETUP_CALLER_NOTICE, setupContract, type SetupLine, type SetupProposal } from "../../shared/setup";
import { TUNABLE_KEYS } from "../../shared/settings";
import { settingsJsonValueSchema } from "../../shared/placement-settings";
import type { HostOutput } from "../../host-contract";
import { forgeCommands, setupScriptCommand, setupScriptPath } from "../../shared/setup-forge";
import { encodeSettingsToml } from "./format";
import { effectiveSettings, setupLayers, type SettingsStore } from "./store";
import { previewToml } from "./toml";
import { SetupPreflight, type SetupChecks, type SetupScope } from "./setup-preflight";

const reasonsSchema = z.record(z.string(), z.string().trim().min(1).max(300).refine(reason => !/[\r\n\u2028\u2029]/.test(reason), "Use one line per reason."));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const changed = <T extends { id: string }>(before: T[], after: T[]) => after.flatMap((item, index) =>
  isDeepStrictEqual(before.find(candidate => candidate.id === item.id), item) ? [] : [{ index, item }]);
const displayed = (value: unknown) => settingsJsonValueSchema.parse(value ?? null);
type Snapshot = ReturnType<SettingsStore["patchSnapshot"]>;
type Patch = Parameters<typeof setupLayers>[1];
type Value = ReturnType<typeof displayed>;

function atPath(value: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((item, part) => item && typeof item === "object" && Object.hasOwn(item, part)
    ? (item as Record<string, unknown>)[part] : undefined, value);
}
const layerKey = (key: string) => key.startsWith("pinned.") || key.startsWith("tuned.");
const valueFor = (snapshot: Snapshot, key: string) => atPath(layerKey(key) ? snapshot : snapshot.effective, key);
function family(key: string) {
  const knob = key.slice("knobs.".length);
  return key.startsWith("knobs.") && TUNABLE_KEYS.some(item => item === knob) ? [key, `pinned.${knob}`, `tuned.${knob}`] : [key];
}
function baseValue(snapshot: Snapshot, key: string): Value {
  const slot = (value: unknown) => value === undefined ? [] : [displayed(value)];
  return displayed(family(key).map(path => [slot(valueFor(snapshot, path)), slot(atPath(layerKey(path) ? snapshot : snapshot.user, path))]));
}
function namedSettings(patch: Patch) {
  const from = (section: string, values: Record<string, unknown>) => Object.keys(values).map(field => ({ key: `${section}.${field}`, field, values }));
  return [
    ...Object.entries(patch.user).flatMap(([section, values]) => section === "classes"
      ? Object.entries(patch.user.classes ?? {}).flatMap(([id, fields]) => from(`classes.${id}`, fields))
      : from(section, values)),
    ...from("pinned", patch.pinned), ...from("tuned", patch.tuned),
  ];
}
function parsePatch(toml: string, current: Snapshot): Patch {
  const result = previewToml(toml, current, "patch");
  if (result.problems.length) throw new Error(result.problems.map(problem => `Line ${problem.line}${problem.key ? ` (${problem.key})` : ""}: ${problem.message}`).join("\n"));
  return { user: result.user, pinned: result.pinned, tuned: result.tuned ?? {} };
}
function planPatch(current: Snapshot, patch: Patch) {
  if (current.placementPolicy.state === "invalid") throw new Error("Repair machine placement in Settings before applying a setup proposal.");
  const layers = setupLayers(current, patch);
  const effective = effectiveSettings(layers);
  encodeSettingsToml(layers, true);
  const checks: SetupChecks = {
    forges: changed(current.effective.machines.forges, effective.machines.forges).map(({ index, item }) => ({ index, profile: item })),
    rules: changed(current.effective.machines.rules, effective.machines.rules).map(({ index, item }) => ({ index, rule: item })),
    classes: Object.keys(patch.user.classes ?? {}).filter(id => !isDeepStrictEqual(current.effective.classes[id], effective.classes[id])),
  };
  return { snapshot: { ...layers, effective }, checks };
}
function resolveForgePaths(patch: Patch, paths: HostOutput<"setupForgeInspect">) {
  for (const { key, resolvedPath } of paths) {
    const [, index, name] = /^machines\.forges\.(\d+)\.(open|state|close)$/.exec(key) ?? [];
    const profile = index === undefined ? undefined : patch.user.machines?.forges?.[Number(index)];
    if (resolvedPath && profile?.kind === "command") profile[name as typeof forgeCommands[number]] = setupScriptCommand(resolvedPath);
  }
}
function describePatch(current: Snapshot, patch: Patch, reasons: Record<string, string>) {
  const named = namedSettings(patch);
  const { snapshot } = planPatch(current, patch);
  const changes: SetupProposal["changes"] = [];
  const base: Record<string, Value> = {};
  const missing = new Set<string>();
  const flicker = "tavern.hearthFlicker", motion = "tavern.ambientMotion";
  const syncFlicker = patch.user.tavern?.ambientMotion !== undefined && current.effective.tavern.hearthFlicker !== snapshot.effective.tavern.hearthFlicker;
  const line = (key: string, before: unknown, after: unknown, reasonKey = key) => {
    const reason = Object.hasOwn(reasons, reasonKey) ? reasons[reasonKey]! : undefined;
    if (!reason) { missing.add(reasonKey); return; }
    changes.push({ key, from: displayed(before), to: displayed(after), kind: key.startsWith("pinned.") ? "pin" : "set", reason });
  };
  for (const { key, field, values } of named) {
    const before = valueFor(current, key), after = valueFor(snapshot, key);
    if (!isDeepStrictEqual(before, after)) line(key, before, after);
    else if (key !== motion || !syncFlicker) { delete values[field]; continue; }
    base[key] = baseValue(current, key);
  }
  if (syncFlicker && !named.some(item => item.key === flicker))
    line(flicker, current.effective.tavern.hearthFlicker, snapshot.effective.tavern.hearthFlicker, motion);
  if (patch.user.tavern?.ambientMotion !== undefined) base[flicker] = baseValue(current, flicker);
  if (missing.size) throw new Error(`Supply a one-line reason for each changed key: ${[...missing].join(", ")}.`);
  const unknown = Object.keys(reasons).filter(key => !named.some(item => item.key === key));
  if (unknown.length) throw new Error(`Reasons name keys outside this patch: ${unknown.join(", ")}.`);
  if (!changes.length) throw new Error("This patch does not change any settings.");
  for (const [id, fields] of Object.entries(patch.user.classes ?? {}))
    if (!Object.keys(fields).length) delete patch.user.classes![id];
  for (const [section, values] of Object.entries(patch.user))
    if (!Object.keys(values).length) delete patch.user[section as keyof typeof patch.user];
  return { changes, base };
}
type SetupRecord = { proposal: SetupProposal; scope: SetupScope; patch: Patch | null; base: Record<string, Value>; unverifiedScripts: string[] };

export class SetupService {
  private applying: string | null = null;
  constructor(private readonly bb: BbPluginApi, private readonly settings: SettingsStore, private readonly keeper: KeeperStore, private readonly preflight: SetupPreflight) {}
  private invalidate() { this.bb.rpc.experimental_invalidate(["tavern:setup"]); }
  private decode(json: string): SetupRecord {
    const saved = JSON.parse(json) as Omit<SetupRecord, "proposal"> & { proposal: Partial<Pick<SetupProposal, "classId" | "proposedAt" | "conflicts">> & Omit<SetupProposal, "classId" | "proposedAt" | "conflicts"> };
    return { scope: saved.scope, patch: saved.patch ?? null, base: saved.base ?? {}, unverifiedScripts: saved.unverifiedScripts ?? [],
      proposal: { classId: null, proposedAt: null, conflicts: [], ...saved.proposal } };
  }
  private get(id: string): SetupRecord | null {
    const row = this.settings.db.prepare("SELECT data FROM tavern_setup_proposals WHERE id=?").get(id) as { data: string } | undefined;
    return row ? this.decode(row.data) : null;
  }
  private pending(): SetupRecord[] {
    return (this.settings.db.prepare("SELECT data FROM tavern_setup_proposals WHERE json_extract(data, '$.proposal.state') = 'pending' ORDER BY rowid DESC").all() as { data: string }[]).map(row => this.decode(row.data));
  }
  private save(record: SetupRecord) {
    this.settings.db.prepare("UPDATE tavern_setup_proposals SET data=? WHERE id=?").run(JSON.stringify(record), record.proposal.id);
    return record.proposal;
  }
  private load(id: string) {
    const record = this.get(id);
    if (record === null) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "This setup proposal does not exist." });
    return record;
  }
  private view(record: SetupRecord, current = this.settings.patchSnapshot()): SetupProposal {
    const { proposal, patch } = record;
    if (proposal.state !== "pending") return proposal;
    if (patch === null) return { ...proposal, state: "stale" };
    if (proposal.revision === current.revision) return proposal;
    const keys = Object.keys(record.base).filter(key => !isDeepStrictEqual(record.base[key], baseValue(current, key)));
    if (!keys.length) return proposal;
    const changes = Object.entries(this.settings.lastChangers());
    const conflicts = keys.map(key => {
      const matches = changes.filter(([path]) => family(key).some(named => path === named || path.startsWith(named + ".")));
      return { key, at: matches.length ? Math.max(...matches.map(([, { at }]) => at)) : null };
    });
    return { ...proposal, state: "stale", conflicts };
  }
  commands() {
    return {
      "setup propose": cliCommand({
        summary: "Propose a TOML settings patch for the user to review and apply",
        options: {
          toml: { type: "string", required: true, description: "Settings TOML containing only the keys to change" },
          reasons: { type: "string", required: true, description: "JSON object of dotted setting keys and one-line reasons" },
          project: { type: "string", description: "Project to use for catalog and source-host checks (defaults to the calling project)" },
        },
        run: async ({ options }, context) => {
          try {
            const reasons = reasonsSchema.parse(JSON.parse(options.reasons));
            const current = this.settings.patchSnapshot();
            const patch = parsePatch(options.toml, current);
            const scope = { projectId: options.project ?? context.projectId ?? null, threadId: context.threadId ?? null };
            const plan = planPatch(current, patch);
            const { lines, paths } = await this.preflight.inspect(plan.snapshot.effective, plan.checks, scope, context.signal);
            context.signal?.throwIfAborted();
            resolveForgePaths(patch, paths);
            const { changes, base } = describePatch(current, patch, reasons);
            const { checks } = planPatch(current, patch);
            const unverifiedScripts = checks.forges.flatMap(({ index, profile }) => profile.kind === "command" ? forgeCommands
              .filter(field => profile[field] !== undefined).map(field => `machines.forges.${index}.${field}`)
              .filter(key => !paths.some(line => line.key === key && line.resolvedPath)) : []);
            const preflight = lines.filter(line => {
              if (line.key === "machines.forges") return checks.forges.length > 0;
              const forge = /^machines\.forges\.(\d+)/.exec(line.key);
              return !forge || checks.forges.some(({ index }) => index === Number(forge[1]));
            });
            const id = randomUUID(), proposedAt = this.settings.now();
            const classId = scope.threadId ? this.keeper.get("members", scope.threadId)?.classId ?? null : null;
            const proposal: SetupProposal = { id, revision: current.revision, threadId: scope.threadId, classId, proposedAt, conflicts: [], state: "pending", changes,
              preflight, decisionId: null, forgeProbe: checks.forges.length > 0 };
            const record = { proposal, patch, base, scope, unverifiedScripts } satisfies SetupRecord;
            const stdout = JSON.stringify({ ...this.view(record), directive: `::tavern-setup{id="${id}"}` });
            if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES) throw new Error("This setup proposal is too large. Shorten the settings patch or reasons.");
            const count = this.settings.db.prepare("SELECT count(*) AS count FROM tavern_setup_proposals WHERE json_extract(data, '$.proposal.state') = 'pending'").get() as { count: number };
            if (count.count >= 50) throw new Error("Tavern already has 50 open setup proposals. Ask the user to dismiss old proposals in Settings.");
            this.settings.db.prepare("INSERT INTO tavern_setup_proposals(id,data) VALUES(?,?)").run(id, JSON.stringify(record));
            this.invalidate();
            return { exitCode: 0, stdout };
          } catch (error) { throw new PluginCliError(message(error)); }
        },
      }),
    };
  }

  handlers(): ExperimentalPluginRpcHandlersWithContext<typeof setupContract> {
    const explicit = (act: "setupApply" | "setupDismiss", id: string, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      const proof = receipt ?? { ...requireUserAct(context, act), references: { id } };
      return { ...proof, attribution: `${proof.attribution}. ${SETUP_CALLER_NOTICE}` };
    };
    return userActHandlers({
      setupProposal: ({ id }) => { const record = this.get(id); return record && this.view(record); },
      setupPending: () => { const current = this.settings.patchSnapshot(); return this.pending().map(record => this.view(record, current)); },
      setupProjects: async (_input, context) => (await this.bb.sdk.projects.list({ includePersonal: true, signal: context?.experimental_signal })).map(({ id, name }) => ({ id, name })),
      setupApply: async ({ id }: { id: string }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
        const authority = explicit("setupApply", id, context, receipt);
        const record = this.load(id);
        const current = this.settings.patchSnapshot(), initial = this.view(record, current), patch = record.patch;
        if (initial.state !== "pending" || !patch) return initial;
        if (this.applying !== null) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "A setup proposal is already applying. Wait for its result." });
        this.applying = id;
        const signal = context?.experimental_signal;
        const failed = (lines: SetupLine[]) => {
          record.proposal.preflight = lines;
          const proposal = this.save(record);
          this.invalidate();
          return proposal;
        };
        try {
          let plan: ReturnType<typeof planPatch>;
          try { plan = planPatch(current, patch); }
          catch (error) { return failed([{ key: "settings", status: "fail", message: message(error) }]); }
          const { lines, paths, forge } = await this.preflight.inspect(plan.snapshot.effective, plan.checks, record.scope, signal);
          signal?.throwIfAborted();
          const checked = this.view(record);
          if (checked.state !== "pending") return checked;
          if (lines.some(line => line.status === "fail")) return failed(lines);
          if (forge) {
            const scripts = plan.checks.forges.flatMap(({ index, profile }) => profile.kind === "command" ? forgeCommands.flatMap(field => {
              const command = profile[field];
              return command === undefined ? [] : [{ key: `machines.forges.${index}.${field}`, command }];
            }) : []);
            const moved = scripts.filter(({ key, command }) => record.unverifiedScripts.includes(key) || !paths.some(line => line.key === key && line.resolvedPath === setupScriptPath(command)));
            if (moved.length) return failed([...lines.filter(line => !moved.some(item => item.key === line.key)), ...moved.map(({ key }) => ({ key, status: "fail" as const, message: "The resolved script path was not confirmed in this proposal. Ask for a fresh one." }))]);
            const probes = await this.preflight.probe(forge, signal);
            signal?.throwIfAborted();
            const probed = this.view(record);
            if (probed.state !== "pending") return probed;
            const replaced = new Set(probes.map(probe => probe.key));
            lines.splice(0, lines.length, ...probes, ...lines.filter(line => !replaced.has(line.key)));
            if (lines.some(line => line.status === "fail")) return failed(lines);
          }
          const latest = this.settings.patchSnapshot(), reviewed = this.view(record, latest);
          if (reviewed.state !== "pending") return reviewed;
          let applied: SetupProposal;
          try {
            const rebased = planPatch(latest, patch);
            const modelClasses = [...plan.checks.classes, ...plan.checks.rules.flatMap(({ rule }) => Object.keys(rule.classModels ?? {}))];
            if (!isDeepStrictEqual(plan.checks, rebased.checks) || modelClasses.some(id =>
              !isDeepStrictEqual(plan.snapshot.effective.classes[id], rebased.snapshot.effective.classes[id])))
              throw new Error("A setting used by preflight changed while the checks were running. Review a fresh proposal.");
            applied = this.settings.atomic(() => commitUserAct(this.keeper, this.settings.now, authority, () => {
              const decision = this.settings.applySetup(patch, latest.revision, "Applied a Tavern setup proposal", record.proposal.threadId);
              if (!decision) throw new Error("The proposal did not change settings.");
              record.proposal = { ...record.proposal, preflight: lines, state: "applied", decisionId: decision.id };
              return this.save(record);
            }));
          } catch (error) {
            record.proposal = { ...record.proposal, state: "pending", decisionId: null };
            if (this.view(record).state === "stale") return this.view(record);
            return failed([...lines, { key: "settings", status: "fail", message: message(error) }]);
          }
          this.invalidate();
          return applied;
        } finally { this.applying = null; }
      },
      setupDismiss: async ({ id }: { id: string }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
        const authority = explicit("setupDismiss", id, context, receipt);
        const record = this.load(id);
        if (record.proposal.state !== "pending") return record.proposal;
        if (this.applying === id) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "This setup proposal is applying. Wait for its result." });
        record.proposal.state = "dismissed";
        const result = commitUserAct(this.keeper, this.settings.now, authority, () => this.save(record));
        this.invalidate();
        return result;
      },
    } satisfies ExperimentalPluginRpcHandlersWithContext<typeof setupContract>, this.keeper, this.settings.now);
  }
}
