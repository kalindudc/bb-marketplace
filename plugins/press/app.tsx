import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { PressContextRow, PressContextSegment } from "./src/ui/context-row";
import { PressFooterChip } from "./src/ui/footer-chip";
import { PressMessageMetadata } from "./src/ui/chat";
import { PressManualCommand } from "./src/ui/manual-command-banner";
import { PressPanel } from "./src/ui/panel";
import { PRESS_TAB } from "./src/ui/model";
import "./src/ui/press.css";
export default definePluginApp((app) => {
  // The current header action draws its own button; only the backwards-compatible slot provides a pane anchor.
  const slots = app.slots as typeof app.slots & {
    experimental_threadHeaderAction?(registration: { id: string; title: string; component: ComponentType<{ threadId: string }> }): void;
  };
  slots.experimental_threadHeaderAction?.({ id: "press-chip", title: "Press", component: PressFooterChip });
  // One registration: the legacy threadPanelAction slot is an alias that collects this same tab id (F36).
  app.slots.experimental_tab({ ...PRESS_TAB, title: "Press", icon: "press/press", layout: "flush", component: PressPanel });
  app.slots.experimental_messageMetadata({ id: "boundary", placement: "above", component: PressMessageMetadata });
  app.composer.customize({ id: "manual-compact", scopes: ["thread"], banners: [{ id: "manual-compact", chrome: "bare", component: PressManualCommand }] });
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
