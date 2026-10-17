import type { PluginSidebarProject, PluginSidebarSection, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { HueId, SortMode } from "../src/layout";

export const layoutWriteFakes = {
  setOrder: ({ ids }: { ids: string[] }) => ({ ids }),
  setSectionOrder: ({ ids }: { ids: string[] }) => ({ ids }),
  setSectionHue: ({ sectionId, hue }: { sectionId: string; hue: HueId | null }) => ({
    sectionHues: hue ? { [sectionId]: hue } : {},
  }),
  setSectionSort: ({ container, mode }: { container: string; mode: SortMode }) => ({
    sectionSort: mode === "manual" ? {} : { [container]: mode },
  }),
  snooze: () => ({ snoozes: {} }),
  unsnooze: () => ({ snoozes: {} }),
};

export function sidebarThread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: "t", projectId: "p", title: "Thread", titleFallback: null, displayTitle: "Thread",
    parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
    sectionId: null, originKind: null, originPluginId: null, providerId: "pi",
    status: "idle", runtimeStatus: "idle", queuedWork: "none", hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false, pinnedAt: null,
    pinSortKey: null, isArchived: false, archivedAt: null, href: "/projects/p/threads/t",
    isHidden: false, environment: null, host: null, createdAt: 1000, updatedAt: 1000,
    lastReadAt: null, latestAttentionAt: 1000,
    ...overrides,
  };
}

export function sidebarSection(id: string, name: string): PluginSidebarSection {
  return { id, name, createdAt: 1000, updatedAt: 1000 };
}

export function sidebarProject(id: string, name: string): PluginSidebarProject {
  return { id, name, isPersonal: false, href: `/projects/${id}`, settingsHref: `/projects/${id}/settings` };
}
