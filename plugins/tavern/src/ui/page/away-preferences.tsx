import { useId } from "react";
import { AWAY_OTHER_HELP, AWAY_STOP_LABELS, AWAY_STOP_LIST, awayStopNames, windowStopKinds, type AwayStopKind, type AwayWindow } from "../../shared/away";

export function AwayStopChoices({ items, onChange, disabled, label = "Never while closed" }: { items: readonly AwayStopKind[]; onChange: (items: AwayStopKind[]) => void; disabled?: boolean; label?: string }) {
  const id = useId();
  return <fieldset className="tv-grpbox tv-away-stops" disabled={disabled}>
    <legend data-settings-copy>{label}</legend>
    {AWAY_STOP_LIST.map(kind => <label className="tv-chk" key={kind}>
      <input type="checkbox" checked={items.includes(kind)} aria-describedby={kind === "other-writes" ? id : undefined} onChange={e => {
        const checked = e.target.checked;
        onChange(AWAY_STOP_LIST.filter(item => item === kind ? checked : items.includes(item)));
      }} /><span>{AWAY_STOP_LABELS[kind]}</span>
    </label>)}
    <p className="m small" id={id} data-settings-copy>{AWAY_OTHER_HELP}</p>
  </fieldset>;
}

export function stopListWords(items: readonly AwayStopKind[]) {
  return items.length ? `Closing time blocks ${awayStopNames(items)}. Cluster writes also wait for your return.` : "Cluster writes wait for your return. No other stops are selected.";
}

export function windowStopWords(window: AwayWindow) {
  return stopListWords(windowStopKinds(window));
}
