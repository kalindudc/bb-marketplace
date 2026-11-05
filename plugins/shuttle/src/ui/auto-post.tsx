import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, experimental_usePluginId, UrlLink } from "@get-bb/plugin-sdk/app";
import type { AutoPostMode } from "../config";
import type { AutoPostInsights } from "../contract";
import { globMatch } from "../glob";
import { changedSettings, replay, replaySettingsOf, withReplaySettings, type ReplaySettings } from "../replay";
import { Drafts } from "./auto-post/drafts";
import { Hero } from "./auto-post/hero";
import { Holds } from "./auto-post/holds";
import type { Tab } from "./auto-post/model";
import { Verifier } from "./auto-post/verifier";
import { BUTTON, CARD, ErrorNote, FIELD_SMALL, Pill, Segmented, type Tone } from "./common";
import { messageOf, useShuttleMutation, useShuttleQuery } from "./data";
import { ago, clock, plural, settingsHref, span } from "./format";
import { Panel } from "./insight-parts";
import { useConfig } from "./settings/use-config";
import { InsightsSkeleton } from "./skeleton";

type Range = AutoPostInsights["range"];
type Repo = AutoPostInsights["repos"][number];

const RANGES = (["7d", "30d", "90d"] as const).map((value) => ({ value, label: value }));
const TABS: ReadonlyArray<{ value: Tab; label: string; tip: string }> = [
  { value: "comment", label: "Comments", tip: "Comment reviews: which drafts' findings would post" },
  { value: "approve", label: "Approvals", tip: "Approvals: which PRs the rules would approve" },
];
const MODE_TEXT: Record<AutoPostMode, string> = { off: "Off", shadow: "Shadow", countdown: "Countdown", auto: "Auto" };
const MODE_TONE: Record<AutoPostMode, Tone> = { off: "neutral", shadow: "info", countdown: "ok", auto: "ok" };
const MODE_ICON: Record<AutoPostMode, string | undefined> = { off: undefined, shadow: "Eye", countdown: "Clock", auto: "Sent" };
const KIND_TEXT = { comment: "comments", approve: "approvals" } as const;
const ALL = "all";
const table = "w-full border-collapse text-xs [&_td]:border-t [&_td]:border-border [&_td]:px-1 [&_td]:py-1.5 [&_th]:px-1 [&_th]:pb-1 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:text-muted-foreground";

/** A repository's mode for comments or approvals, as a pill. */
export function ModePill({ kind, mode }: { kind: "comment" | "approve"; mode: AutoPostMode }) {
  return <Pill tone={MODE_TONE[mode]} icon={MODE_ICON[mode]} title={`${kind === "comment" ? "Comments" : "Approvals"}: ${MODE_TEXT[mode].toLowerCase()}`}>{kind === "comment" ? "Comments" : "Approvals"}: {MODE_TEXT[mode]}</Pill>;
}

/** Why Shuttle stopped posting one kind of review in a repository by itself, with Resume. The settings stay as they are. */
export function TripNote({ repo, trip }: { repo: string; trip: Repo["trips"][number] }) {
  const resume = useShuttleMutation("resumeAutoPost");
  return (
    <div role="alert" data-auto-post-trip={trip.kind} className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-xs text-warning-text">
      <Icon name="OctagonPause" fallback="Pause" className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1"><b className="font-semibold">Posting {KIND_TEXT[trip.kind]} stopped:</b> {trip.reason} <span className="text-muted-foreground">· {ago(trip.at)}</span></span>
      <button type="button" className={BUTTON} disabled={resume.isPending} aria-label={`Resume posting ${KIND_TEXT[trip.kind]} in ${repo}`} onClick={() => void resume.run({ repo, kind: trip.kind })}>
        {resume.isPending ? "Resuming\u2026" : "Resume"}
      </button>
    </div>
  );
}

/** What Shuttle posted itself in a repository, and how much of it you marked as a mistake. */
function PostedLine({ posted }: { posted: Repo["posted"] }) {
  const marked = posted.marked + posted.mistakes;
  return (
    <span data-posted className={`text-[11.5px] ${marked > 0 ? "text-warning-text" : "text-muted-foreground"}`}>
      Posted by Shuttle: {plural(posted.reviews, "review")} ({plural(posted.approvals, "approval")}), {plural(posted.findings, "comment")}, {marked} marked as mistakes
    </span>
  );
}

/** Each repository auto post watches: its modes, what Shuttle posted there, and why posting stopped when it did. */
function Repos({ repos }: { repos: readonly Repo[] }) {
  return (
    <Panel title="Repositories" sub="Each repository's modes and what Shuttle posted there itself.">
      <div className="flex flex-col">
        {repos.map((repo, index) => (
          <div key={`${index}:${repo.repo}`} data-auto-post-repo={repo.repo} className="flex flex-col gap-1.5 border-t border-border py-2 first:border-t-0 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-mono text-xs font-semibold">{repo.repo}</span>
              <ModePill kind="comment" mode={repo.mode} />
              <ModePill kind="approve" mode={repo.approveMode} />
              <span className="min-w-0 flex-1" />
              <PostedLine posted={repo.posted} />
            </div>
            {repo.trips.map((trip) => <TripNote key={trip.kind} repo={repo.repo} trip={trip} />)}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Drafts Shuttle will post on its own once their countdown ends, soonest first; stop one from its PR. */
function Scheduled({ rows, onOpenPr }: { rows: AutoPostInsights["scheduled"]; onOpenPr(key: string): void }) {
  const now = Date.now();
  return (
    <div className="overflow-x-auto">
      <table className={table} data-scheduled-posts>
        <thead><tr><th>PR</th><th>Posts</th><th>In</th><th>At</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.draftId} data-scheduled-post={row.draftId}>
              <td className="max-w-[18rem]">
                <button type="button" className="block max-w-full cursor-pointer truncate text-left text-primary hover:underline" title={row.title} onClick={() => onOpenPr(row.key)}>{row.display}</button>
                <div className="truncate text-[11px] text-muted-foreground">{row.title}</div>
              </td>
              <td className="whitespace-nowrap">
                {row.verdict === "approve"
                  ? <Pill tone="ok" icon="Check">Approval{row.findings > 0 ? ` with ${plural(row.findings, "comment")}` : ""}</Pill>
                  : <Pill tone="info" icon="MessageSquare">{plural(row.findings, "comment")}</Pill>}
              </td>
              <td className="whitespace-nowrap">{row.at <= now ? "any moment" : span(row.at - now)}</td>
              <td className="whitespace-nowrap text-muted-foreground">{clock(row.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Your settings", or how many you are trying with Reset and Save. */
function Changes({ changed, saving, onReset, onSave }: { changed: number; saving: boolean; onReset(): void; onSave(): void }) {
  const trying = changed > 0;
  return (
    <span data-changes={trying ? "trying" : "saved"} className={`inline-flex h-7 items-center gap-2.5 whitespace-nowrap rounded-full border px-3 text-xs ${trying ? "border-foreground text-foreground" : "border-border text-muted-foreground"}`}
      title={trying ? "The page judges every draft again with the settings you are trying; nothing is saved until you press Save." : "Every draft judged with the settings you saved."}>
      <span role="status">{trying ? `Trying ${plural(changed, "change")}` : "Your settings"}</span>
      {trying && <button type="button" className="cursor-pointer text-primary hover:underline" onClick={onReset}>Reset</button>}
      {trying && <button type="button" className="cursor-pointer font-medium text-primary hover:underline disabled:cursor-default disabled:opacity-50" disabled={saving} onClick={onSave}>{saving ? "Saving\u2026" : "Save"}</button>}
    </span>
  );
}

/** Insights › Auto post: every checked draft judged again in the browser, with your settings or ones you try, against what you did. */
export function AutoPostView({ onOpenPr }: { onOpenPr(key: string): void }) {
  const pluginId = experimental_usePluginId();
  const [range, setRange] = useState<Range>("30d");
  const [tab, setTab] = useState<Tab>("comment");
  const [repo, setRepo] = useState(ALL);
  // Only the settings you changed: the rest follow the saved settings, even when they change elsewhere meanwhile.
  const [trying, setTrying] = useState<Partial<ReplaySettings>>({});
  const verifierCard = useRef<HTMLDivElement>(null);
  const replayQuery = useShuttleQuery("autoPostReplay", { range });
  const insightsQuery = useShuttleQuery("autoPostInsights", { range });
  const { config, loadError } = useConfig();
  const saveChanges = useShuttleMutation("saveAutoPostSettings", ({ changes }, cache) => cache.update("getConfig", {}, (current) => (current === undefined ? current : { config: { ...current.config, autoPost: withReplaySettings(current.config.autoPost, { ...replaySettingsOf(current.config.autoPost), ...changes }) } })));
  const [saveError, setSaveError] = useState<string | null>(null);
  const drafts = replayQuery.data?.drafts;
  const insights = insightsQuery.data;
  const mine = useMemo(() => (config === null ? null : replaySettingsOf(config.autoPost)), [config]);
  const changedKeys = mine === null ? [] : changedSettings(mine, { ...mine, ...trying });
  const settings = useMemo(() => (mine === null ? null : { ...mine, ...trying }), [mine, trying]);
  // A PR belongs to the first repository entry that matches it, as it does for the gate.
  const entryOf = (name: string) => config?.autoPost.repos.find((entry) => globMatch(entry.repo, name))?.repo ?? null;
  const visible = useMemo(() => (drafts ?? []).filter((draft) => repo === ALL || entryOf(draft.repo) === repo), [drafts, repo, config]);
  const rows = useMemo(() => (settings === null ? [] : visible.map((draft) => replay(draft, settings))), [visible, settings]);
  const base = useMemo(() => (mine === null ? [] : changedKeys.length === 0 ? rows : visible.map((draft) => replay(draft, mine))), [visible, mine, changedKeys.length, rows]);
  const error = replayQuery.error ?? insightsQuery.error;

  const change = (patch: Partial<ReplaySettings>) => {
    if (mine === null) return;
    const next = { ...trying, ...patch };
    // A setting tried back to its saved value is no longer a change.
    setTrying(Object.fromEntries(Object.entries(next).filter(([key]) => changedSettings(mine, { ...mine, [key]: next[key as keyof ReplaySettings] }).length > 0)));
  };
  const onSave = async () => {
    if (mine === null || changedKeys.length === 0) return;
    const sent = Object.fromEntries(changedKeys.map((key) => [key, trying[key]])) as Partial<ReplaySettings>;
    setSaveError(null);
    try {
      await saveChanges.mutate({ changes: sent });
      toast.success("Saved auto post's settings");
      // Only what was sent is saved: a change made while it saved stays a change.
      setTrying((current) => Object.fromEntries(Object.entries(current).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(sent[key as keyof ReplaySettings]))));
    } catch (error) {
      const message = messageOf(error);
      setSaveError(message);
      toast.error(message);
    }
  };
  const saving = saveChanges.isPending;
  const changed = changedKeys.length;
  const inexact = visible.filter((draft) => !draft.exact).length;
  const shownRepos = insights?.repos.filter((entry) => repo === ALL || entry.repo === repo) ?? [];

  return (
    <div data-auto-post-insights>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented label="Show" value={tab} onChange={setTab} options={TABS} />
        {config !== null && config.autoPost.repos.length > 0 && (
          <select aria-label="Repository" value={repo} className={FIELD_SMALL} onChange={(event) => setRepo(event.target.value)}>
            <option value={ALL}>All repositories</option>
            {config.autoPost.repos.map((entry, index) => <option key={`${index}:${entry.repo}`} value={entry.repo}>{entry.repo}</option>)}
          </select>
        )}
        <Segmented label="Range" value={range} onChange={setRange} options={RANGES} />
        <span className="flex-1" />
        {mine !== null && <Changes changed={changed} saving={saving} onReset={() => setTrying({})} onSave={() => void onSave()} />}
      </div>
      {error !== null && <ErrorNote>Could not load auto post's record: {messageOf(error)}</ErrorNote>}
      {loadError !== null && <ErrorNote>Could not load the settings: {loadError}</ErrorNote>}
      {saveError !== null && <div className="mb-3"><ErrorNote>Could not save: {saveError}</ErrorNote></div>}
      {error === null && loadError === null && (config === null || (config.autoPost.repos.length > 0 && (drafts === undefined || insights === undefined))) && <InsightsSkeleton label="Loading auto post's record" />}
      {config !== null && config.autoPost.repos.length === 0 && (
        <div data-auto-post-empty className={`${CARD} px-3.5 py-3 text-sm`}>
          <div className="flex items-center gap-1.5 font-semibold"><Icon name="Eye" className="size-4" aria-hidden />Auto post is off</div>
          <div className="mt-1 text-muted-foreground">
            Add a repository in shadow mode under{" "}
            <UrlLink href={settingsHref(pluginId)} className="text-primary hover:underline">Settings › Automations › Auto post</UrlLink>. Shuttle then checks each AI review draft there, records what it would post, and this page compares that with what you post.
          </div>
        </div>
      )}
      {insights !== undefined && insights.scheduled.length > 0 && (
        <div className="mb-3">
          <Panel title={<><Icon name="Clock" className="size-3.5" aria-hidden />Waiting to post</>} sub={`${plural(insights.scheduled.length, "review")} Shuttle posts on its own unless you stop it from the PR`}>
            <Scheduled rows={insights.scheduled} onOpenPr={onOpenPr} />
          </Panel>
        </div>
      )}
      {drafts !== undefined && insights !== undefined && config !== null && settings !== null && config.autoPost.repos.length > 0 && (
        <div className="flex flex-col gap-3">
          <Hero rows={rows} base={base} tab={tab} target={tab === "comment" ? config.autoPost.targetPrecision : config.autoPost.approvals.target} />
          <div className="grid grid-cols-1 gap-3 @4xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <Panel title="Each draft" sub={tab === "comment" ? "What would post with the settings shown, and what holds the rest." : "What the rules would approve with the settings shown, and what holds the rest."}>
              <Drafts rows={rows} tab={tab} settings={settings} onOpenPr={onOpenPr} />
            </Panel>
            <div className="flex min-w-0 flex-col gap-3">
              <Panel title="What holds them" sub="Each setting with the drafts it holds; +N would go through if only it changed.">
                <Holds rows={rows} drafts={visible} tab={tab} settings={settings} onChange={change} onTuneFloors={() => verifierCard.current?.scrollIntoView?.({ block: "start", behavior: "smooth" })} />
              </Panel>
              {shownRepos.length > 0 && <Repos repos={shownRepos} />}
            </div>
          </div>
          {tab === "comment" && <Verifier ref={verifierCard} rows={rows} settings={settings} onChange={change} />}
          {inexact > 0 && (
            <p data-exact-note className="text-[11.5px] text-muted-foreground">
              {plural(inexact, "draft was", "drafts were")} checked before Shuttle kept the PR's checks and size; for those it uses the check's reasons or the PR as it is now.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
