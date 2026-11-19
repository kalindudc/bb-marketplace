import { useId } from "react";
import { characterDefSchema, type CharacterDef } from "../../shared/schema";
import { SPEECH_KEYS, type SpeechKey } from "../../shared/says";

const LABEL: Record<SpeechKey, string> = {
  idle: "Idle", working: "Working", reported: "Just reported", verified: "Verified",
  resting: "Resting", greet: "Greeting", wrap: "Wrapping up",
};

const TOKEN = /(\{(?:quest|waypoint|checker|minutes)\})/g;
const speechSchema = characterDefSchema.shape.says;
type Says = CharacterDef["says"];
export type BubbleEdits = Partial<Record<SpeechKey, string>>;
type FieldErrors = Partial<Record<SpeechKey, string>>;

export function readBubbleDraft(saved: Says, edits: BubbleEdits): { says: Says; errors: FieldErrors } {
  const keys = SPEECH_KEYS.filter(key => edits[key] !== undefined);
  const says = keys.length ? {
    ...saved,
    ...Object.fromEntries(keys.map(key => [key, edits[key]!.split(/\r?\n/).filter(line => line.trim())])),
  } : saved;
  const parsed = speechSchema.safeParse(says);
  const errors: FieldErrors = {};
  if (!parsed.success) for (const key of SPEECH_KEYS) {
    const issues = parsed.error.issues.filter(issue => issue.path[0] === key);
    const issue = issues.find(issue => issue.path.length === 1) ?? issues[0];
    if (!issue) continue;
    const index = issue.path[1];
    errors[key] = typeof index === "number" ? `Line ${index + 1} is too long. ${issue.message}` : issue.message;
  }
  return { says, errors };
}

function Guide() {
  return <div className="tv-bubble-guide m small">
    <p>What the character says in its bubble on the strip, now and then. Never sent to the model.</p>
    <p><code>{"{quest}"}</code>, <code>{"{waypoint}"}</code>, <code>{"{checker}"}</code> and <code>{"{minutes}"}</code> fill in when Tavern knows them.</p>
  </div>;
}

export function BubbleLines({ says }: { says: Says }) {
  const id = useId();
  const moods = SPEECH_KEYS.flatMap(key => {
    const lines = says?.[key];
    return lines?.length ? [{ key, lines }] : [];
  });
  return <section className="tv-bubbles" aria-labelledby={id}>
    <h3 id={id}>Bubble lines</h3>
    <Guide />
    {moods.length === 0 ? <p className="m small">No bubble lines written yet.</p> : <div className="tv-bubble-moods">
      {moods.map(({ key, lines }) => <div key={key}>
        <h4 className="lbl" id={`${id}-${key}`}>{LABEL[key]}</h4>
        <ul aria-labelledby={`${id}-${key}`}>
          {lines.map((line, row) => <li key={row}>{line.split(TOKEN).map((part, i) => i % 2 ? <code key={i}>{part}</code> : part)}</li>)}
        </ul>
      </div>)}
    </div>}
  </section>;
}

export function BubbleFields({ saved, edits, errors, onEdit }: {
  saved: Says; edits: BubbleEdits; errors: FieldErrors; onEdit: (key: SpeechKey, text: string) => void;
}) {
  const id = useId();
  return <fieldset className="tv-bubble-fields tv-grpbox wide">
    <legend>Bubble lines</legend>
    <Guide />
    <p className="m small" id={id}>One per line, at most five lines per mood and 60 characters per line.</p>
    <div className="tv-fields">
      {SPEECH_KEYS.map(key => {
        const field = `${id}-${key}`, error = errors[key];
        return <div className="tv-field" key={key}>
          <label htmlFor={field}>{LABEL[key]}</label>
          <textarea id={field} name={`says-${key}`} className="tv-inp" rows={3} aria-label={`${LABEL[key]} bubble lines`}
            value={edits[key] ?? saved?.[key]?.join("\n") ?? ""} onChange={e => onEdit(key, e.target.value)}
            aria-invalid={error ? true : undefined} aria-describedby={error ? `${id} ${field}-error` : id} />
          {error && <p className="tv-problem" role="alert" id={`${field}-error`}>{error}</p>}
        </div>;
      })}
    </div>
  </fieldset>;
}
