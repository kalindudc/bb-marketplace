import { experimental_ProviderModelPicker as ProviderModelPicker, experimental_useProviders, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { useCallback, useRef, useState } from "react";
import type { PlacementRule } from "../../shared/placement-settings";
import type { ClassDef } from "../../shared/schema";
type ClassModel = NonNullable<PlacementRule["classModels"]>[string];
type ModelClass = Pick<ClassDef, "id" | "label" | "provider" | "model" | "reasoning">;
function ModelRow({ role, override, onChange }: { role: ModelClass; override?: ClassModel; onChange: (value: ClassModel | null) => void }) {
  const providers = experimental_useProviders();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const touched = useRef(false), save = useRef(onChange);
  save.current = onChange;
  const change = useCallback((next: ExperimentalProviderModelPickerValue) => {
    setDraft(next);
    if (touched.current && next.model) save.current({ provider: next.providerId, model: next.model, ...(next.reasoningLevel ? { reasoning: next.reasoningLevel } : {}) });
  }, []);
  const providerId = override?.provider ?? role.provider ?? providers.providers.find(provider => provider.available)?.id;
  const value = draft ?? { providerId: providerId ?? "", model: override?.model ?? role.model ?? "", reasoningLevel: override?.reasoning ?? role.reasoning ?? "" };
  return <div className="mx-field" role="group" aria-label={`${role.label} model`}><span className="mx-fl">{role.label}</span><div className="tv-exec"
    onPointerDownCapture={() => { touched.current = true; }} onClickCapture={() => { touched.current = true; }} onKeyDownCapture={event => { if (!["Tab", "Shift", "Escape"].includes(event.key)) touched.current = true; }}>
    {override || editing ? <>
      <ProviderModelPicker value={value} onChange={change} align="end" />
      <button type="button" className="lnk-btn act" aria-label={`Use the class’s model for ${role.label}`} onClick={() => { touched.current = false; setDraft(null); setEditing(false); save.current(null); }}>Use the class’s model</button>
    </> : <><span className="tv-exec-d">Use the class’s model{role.model ? `: ${role.model}` : ""}</span><button type="button" className="btn sm" aria-label={`Choose model for ${role.label}`} disabled={!providerId} onClick={() => { touched.current = false; setEditing(true); }}>Choose model</button></>}
  </div></div>;
}
export function RuleModels({ classes, models, onChange }: { classes: ModelClass[]; models: NonNullable<PlacementRule["classModels"]>; onChange: (classId: string, value: ClassModel | null) => void }) {
  return <fieldset><legend>Models on these machines</legend><p className="mx-hint">These choices apply only when this rule places a member on another machine. Save rule to keep them.</p><p className="mx-hint">Pick a model the target machine's agent also offers. Tavern checks it here before hiring, and the machine reports a model it lacks on the member's first turn.</p><p className="mx-hint">Save rule removes model overrides for classes this rule no longer matches.</p>{classes.map(role => <ModelRow key={role.id} role={role} override={models[role.id]} onChange={value => onChange(role.id, value)} />)}</fieldset>;
}
