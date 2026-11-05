import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

type TimelineRead = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["timeline"]>>;
/** A whole window of the timeline: the latest one, or an older page. */
export type TimelineResponse = Exclude<TimelineRead, { delta: unknown }>;
/** bb's answer to `afterTag`: what changed since the latest window that carried that tag. */
export type TimelineDeltaResponse = Extract<TimelineRead, { delta: unknown }>;
export type TimelineDelta = TimelineDeltaResponse["delta"];
export type TimelineRow = TimelineResponse["rows"][number];
export type TimelinePage = TimelineResponse["timelinePage"];
export type ActiveThinking = NonNullable<TimelineResponse["activeThinking"]>;
export type ThreadEventRow = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["events"]["list"]>>[number];

export type SessionLogSdk = Pick<PluginBrowserBbSdk, "subscribe"> & {
  threads: Pick<PluginBrowserBbSdk["threads"], "timeline" | "get"> & {
    events: Pick<PluginBrowserBbSdk["threads"]["events"], "list">;
  };
};
