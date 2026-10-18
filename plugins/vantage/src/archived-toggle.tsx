import type { Overview } from "./contract";
import { includeArchivedLabel } from "./archived";
import { Hint } from "./hint";

export function ArchivedToggle({ overview, included, onChange }: {
  overview: Overview | null; included: boolean; onChange(included: boolean): void;
}) {
  return (
    <Hint label="Add archived threads and their kept branches below the active ones">
      <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={included} onChange={(event) => onChange(event.target.checked)} />
        {includeArchivedLabel(overview, included)}
      </label>
    </Hint>
  );
}
