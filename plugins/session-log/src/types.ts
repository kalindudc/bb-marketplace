import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export type TimelineResponse = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["timeline"]>>;
export type TimelineRow = TimelineResponse["rows"][number];
export type TimelinePage = TimelineResponse["timelinePage"];
export type TimelineDelta = NonNullable<TimelineResponse["delta"]>;
export type ActiveThinking = NonNullable<TimelineResponse["activeThinking"]>;
export type ThreadEventRow = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["events"]["list"]>>[number];

export type SessionLogSdk = Pick<PluginBrowserBbSdk, "subscribe"> & {
  threads: Pick<PluginBrowserBbSdk["threads"], "timeline" | "get"> & {
    events: Pick<PluginBrowserBbSdk["threads"]["events"], "list">;
  };
};
