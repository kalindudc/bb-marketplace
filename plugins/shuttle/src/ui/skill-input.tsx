import { useId } from "react";
import { FIELD } from "./common";
import { messageOf, useShuttleQuery } from "./data";

/** A free-text skill name, with the skills bb knows as suggestions; empty means no skill. */
export function SkillInput({ value, onChange, projectId, label = "Skill" }: { value: string; onChange(next: string): void; projectId?: string; label?: string }) {
  const listId = useId();
  const query = useShuttleQuery("skills", projectId ? { projectId } : {});
  const skills = query.data?.skills;
  const known = skills?.find((skill) => skill.name === value || skill.id === value) ?? null;
  return (
    <div className="min-w-0">
      <input aria-label={label} list={listId} className={`${FIELD} w-full font-mono`} placeholder="No skill" value={value} onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>
        {skills?.map((skill) => <option key={skill.id} value={skill.name}>{skill.description}</option>)}
      </datalist>
      {known !== null && <div className="mt-1 truncate text-xs text-muted-foreground">{known.description}</div>}
      {query.error !== null && <div className="mt-1 text-xs text-destructive-text">Could not list skills: {messageOf(query.error)}</div>}
    </div>
  );
}
