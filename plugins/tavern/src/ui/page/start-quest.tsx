import { PageGlyph } from "./glyphs";

export function StartQuest({ startKeeper }: { startKeeper: () => void }) {
  return <button type="button" className="btn" onClick={() => startKeeper()} title="Open bb’s composer for a new Keeper" aria-label="Start a quest: new Keeper"><PageGlyph name="hire" /><span className="tv-head-w">Start a quest</span></button>;
}
