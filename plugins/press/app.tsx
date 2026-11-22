import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { PressContextRow, PressContextSegment } from "./src/ui/context-row";
import { PressFooterChip } from "./src/ui/footer-chip";
import { PressMessageMetadata } from "./src/ui/chat";
import { PressManualCommand } from "./src/ui/manual-command-banner";
import { PressPanel } from "./src/ui/panel";
import { PressSettingsSection } from "./src/ui/settings-section";
import { PRESS_TAB } from "./src/ui/model";
import "./src/ui/press.css";
export default definePluginApp((app) => {
  // The current header action draws its own button; only the backwards-compatible slot provides a pane anchor.
  const slots = app.slots as typeof app.slots & {
    experimental_threadHeaderAction?(registration: { id: string; title: string; component: ComponentType<{ threadId: string }> }): void;
  };
  slots.experimental_threadHeaderAction?.({ id: "press-chip", title: "Press", component: PressFooterChip });
  // The thread panel action slot is the one Burn uses and the one this bb build opens reliably; the
  // pinned SDK types still call it legacy, so it is reached through a cast rather than a missing type.
  const legacy = app.slots as typeof app.slots & {
    threadPanelAction?(registration: { id: string; title: string; icon?: string; component: ComponentType<never> }): void;
  };
  legacy.threadPanelAction?.({ id: PRESS_TAB.id, title: "Press", icon: "press/press", component: PressPanel as unknown as ComponentType<never> });
  // A slot that throws takes the whole app bundle with it, so each optional registration is guarded.
  try {
    app.slots.experimental_tab({ ...PRESS_TAB, title: "Press", icon: "press/press", component: PressPanel });
  } catch (error) {
    console.error("press: experimental_tab registration failed", error);
  }
  app.slots.experimental_messageMetadata({ id: "boundary", placement: "above", component: PressMessageMetadata });
  app.composer.customize({ id: "manual-compact", scopes: ["thread"], banners: [{ id: "manual-compact", chrome: "bare", component: PressManualCommand }] });
  app.slots.settingsSection({ id: "configuration", title: "Configuration", component: PressSettingsSection });
  app.slots.experimental_threadContextSegment({
    id: "press", title: "Press", group: "6_compaction", order: 10, summary: PressContextSegment,
  });
  app.slots.experimental_threadContextCardRow({
    id: "press",
    // After bb's lifecycle rows; any string is a group of its own, placed where it sorts.
    group: "6_compaction",
    order: 10,
    component: PressContextRow,
  });
});
