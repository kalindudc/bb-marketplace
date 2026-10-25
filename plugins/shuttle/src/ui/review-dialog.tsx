import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Preset } from "../config";
import type { PrView, ReviewInput } from "../contract";
import { BUTTON, BUTTON_PRIMARY, Dialog, FIELD, ServerBadge } from "./common";
import { useShuttleQuery } from "./data";
import { ExecutionPicker, executionOf, type Execution } from "./execution";
import { shortKey } from "./format";
import { ProjectSelect } from "./link-dialog";
import { defaultPresetOf, presetSummary, useStartReview } from "./review-button";
import { SkillInput } from "./skill-input";

const NEW_THREAD = "";

export function ReviewDialog({ pr, presets, thread = null, onClose }: { pr: PrView; presets: readonly Preset[]; thread?: { threadId: string; title: string } | null; onClose(): void }) {
  const { busy, start } = useStartReview();
  const [presetId, setPresetId] = useState(defaultPresetOf(presets)?.id ?? null);
  const preset = presets.find((item) => item.id === presetId) ?? null;
  const [skill, setSkill] = useState<string | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null);
  const own = pr.reviewThread;
  const [where, setWhere] = useState(thread?.threadId ?? own?.threadId ?? NEW_THREAD);
  const reusable = pr.links.filter((link) => !link.archived && link.threadId !== own?.threadId).map((link) => ({ threadId: link.threadId, title: link.title }));
  if (thread !== null && thread.threadId !== own?.threadId && !reusable.some((link) => link.threadId === thread.threadId)) reusable.push(thread);
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const projects = useShuttleQuery("projects", { key: pr.key });
  const projectId = projectChoice ?? projects.data?.suggested ?? "";

  const pickPreset = (id: string) => {
    setPresetId(id);
    setSkill(null);
    setExecution(null);
  };

  const submit = async () => {
    if (preset === null) return;
    const trimmedNote = note.trim();
    const input: ReviewInput = {
      key: pr.key,
      presetId: preset.id,
      ...(skill !== null && skill.trim() !== preset.skill ? { skill: skill.trim() } : {}),
      ...(execution !== null && execution.model !== ""
        ? { providerId: execution.providerId, model: execution.model, ...(execution.reasoningLevel ? { reasoningLevel: execution.reasoningLevel } : {}) }
        : {}),
      ...(trimmedNote === "" ? {} : { note: trimmedNote }),
      // Shuttle's own review thread is the default target: it brings it back and gives it the preset's model.
      ...(where === NEW_THREAD ? { ...(own !== null ? { newThread: true } : {}), ...(projectId === "" ? {} : { projectId }) } : where === own?.threadId ? {} : { threadId: where }),
    };
    if (await start(input, preset.name)) onClose();
  };

  return (
    <Dialog
      title={`Review ${shortKey(pr)}`}
      leading={<ServerBadge name={pr.serverName} />}
      subtitle={<>{pr.title}{pr.head !== null && <> · head <span className="font-mono">{pr.head.slice(0, 7)}</span></>}</>}
      onClose={onClose}
      footer={(
        <>
          <span className="flex-1 text-xs text-muted-foreground">The reviewer drafts its findings and asks you before posting anything.</span>
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={BUTTON_PRIMARY} disabled={busy || preset === null} onClick={() => void submit()}>
            <Icon name="Play" className="size-3.5" aria-hidden />
            Start review
          </button>
        </>
      )}
    >
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Preset</div>
      <div role="radiogroup" aria-label="Preset" className="flex flex-col gap-1.5">
        {presets.map((item) => {
          const on = item.id === presetId;
          return (
            <button key={item.id} type="button" role="radio" aria-checked={on} onClick={() => pickPreset(item.id)}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left ${on ? "border-primary bg-primary/5" : "border-border hover:bg-accent"}`}>
              <span className={`mt-0.5 size-4 shrink-0 rounded-full border ${on ? "border-[5px] border-primary" : "border-border"}`} aria-hidden />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {item.name}
                  {item.default && <span className="rounded-full border border-border px-1.5 text-[10.5px] font-normal text-muted-foreground">default</span>}
                </span>
                <span className="block text-xs text-muted-foreground">{presetSummary(item)}</span>
              </span>
            </button>
          );
        })}
      </div>

      {preset !== null && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">Change this run only</summary>
          <div className="mt-3 grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
            <span className="text-xs text-muted-foreground">Skill</span>
            <SkillInput value={skill ?? preset.skill} onChange={setSkill} projectId={projectId === "" ? undefined : projectId} />
            <span className="self-start pt-1.5 text-xs text-muted-foreground">Agent and model</span>
            <ExecutionPicker value={execution ?? executionOf(preset)} onChange={setExecution} resetLabel={execution !== null ? "Use the preset's" : null} />
          </div>
        </details>
      )}

      <div className="mt-3 grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
        <span className="text-xs text-muted-foreground">Thread</span>
        <select aria-label="Thread" className={FIELD} value={where} onChange={(event) => setWhere(event.target.value)}>
          {own !== null && <option value={own.threadId}>Its review thread, “{own.title}”{own.archived ? " (brought back from the archive)" : ""}</option>}
          <option value={NEW_THREAD}>A new thread</option>
          {reusable.map((link) => <option key={link.threadId} value={link.threadId}>Reuse “{link.title}”</option>)}
        </select>
        {where === NEW_THREAD && (
          <>
            <span className="text-xs text-muted-foreground">Project</span>
            <ProjectSelect projects={projects.data} value={projectId} onChange={setProjectChoice} />
          </>
        )}
        <span className="self-start pt-1.5 text-xs text-muted-foreground">Note for the reviewer</span>
        <textarea aria-label="Note for the reviewer" rows={2} className={`${FIELD} w-full`} placeholder="Optional, for example: focus on the filter ordering" value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
    </Dialog>
  );
}
