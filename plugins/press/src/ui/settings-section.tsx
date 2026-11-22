import { UrlLink, experimental_usePluginId, useSettings } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { normalizeSettings } from "../settings";
import { numberText } from "./model";

function Setting({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <div className="press-setting">
    <dt>{label}{help && <small>{help}</small>}</dt>
    <dd>{typeof children === "boolean" ? (children ? "On" : "Off") : children}</dd>
  </div>;
}

export function PressSettingsSection() {
  const { values, isLoading } = useSettings();
  const pluginId = experimental_usePluginId();
  if (isLoading) return <p role="status">Loading Press settings…</p>;
  if (values === undefined) return <p role="status">Press settings are unavailable.</p>;
  const s = normalizeSettings(values);
  return <div className="press-settings">
    <p>These are the plugin defaults. The Press tab can override mode and compaction points for the current thread.</p>
    <section>
      <h3>Mode and context window</h3>
      <dl>
        <Setting label="Mode" help="Observe records decisions. Advisor proposes. Auto compacts.">{s.mode}</Setting>
        <Setting label="Compact at (percent of window)" help="Most points only count beyond this threshold.">{s.softPercent}%</Setting>
        <Setting label="Force at (percent of window)" help="The window backstop ignores vetoes; mode still applies.">{s.hardPercent}%</Setting>
        <Setting label="Never compact below (tokens)" help="Minimum usage for regular compaction points.">{numberText(s.floorTokens)}</Setting>
      </dl>
    </section>
    <section>
      <h3>Compaction points</h3>
      <dl>
        <Setting label="Compact at phase boundaries" help="Plan approved, tests green, or a PR opened.">{s.phasePoint}</Setting>
        <Setting label="Compact when an agent marks a point" help="An agent marks a point with the tool or bb press point.">{s.agentPoint}</Setting>
        <Setting label="Compact on a large tool result">{s.volumePoint}</Setting>
        <Setting label="A large tool result (bytes)" help="The minimum size for the tool result point.">{numberText(s.volumeBytes)}</Setting>
        <Setting label="Compact after many turns">{s.turnsPoint}</Setting>
        <Setting label="Turns between compactions" help="The threshold for the turns point.">{s.turnsBetween}</Setting>
        <Setting label="Compact after idle time">{s.idlePoint}</Setting>
        <Setting label="Idle time (seconds)" help="The threshold for the idle point.">{s.idleSeconds}</Setting>
        <Setting label="Compact on repeated work" help="For example, the same file re-read or command failing.">{s.thrashPoint}</Setting>
      </dl>
    </section>
    <section>
      <h3>Cooldown</h3>
      <dl>
        <Setting label="Cooldown after a compaction (seconds)" help="The wait before a regular point can compact again.">{s.cooldownSeconds}</Setting>
        <Setting label="Minimum turns between compactions" help="Minimum completed turns before a regular point can compact again.">{s.minTurnsBetween}</Setting>
      </dl>
    </section>
    <section>
      <h3>Summary composer</h3>
      <dl>
        <Setting label="Model that writes the summary" help="Empty uses the thread’s own model.">{s.composerModel || "Thread model"}</Setting>
        <Setting label="Summary budget (tokens)" help="Token budget for the model-written summary.">{numberText(s.maxSummaryTokens)}</Setting>
        <Setting label="Install the composer into pi automatically" help="Keeps the Press composer extension up to date.">{s.autoInstallComposer}</Setting>
      </dl>
    </section>
    <UrlLink href={`/settings/plugins/${encodeURIComponent(pluginId)}`}>Open plugin configuration</UrlLink>
  </div>;
}
