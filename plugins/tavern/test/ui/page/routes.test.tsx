import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import { detail, emptyRoom, registry, room } from "../../../src/ui/page/fixtures";
import { registerPageSurfaces } from "../../../src/ui/page/register";

describe("Tavern route rendering", () => {
  beforeEach(() => window.localStorage.clear());
  for (const [name, route] of [["room", ""], ["room-empty", ""], ["quest", "quest/vault"], ["map", "map"], ["characters", "characters"], ["character", "character/wren"], ["classes", "classes"], ["class", "class/keeper"], ["closing", "closing"], ["digest", "digest"], ["tale", "tale/vault"]]) {
    it(`renders ${name} against validated fixture data`, async () => {
      const app = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
      const slot = renderSlot(app.navPanels[0]!, { subPath: route! }, { pluginId: "tavern", rpc: {
        registry: () => registry, room: () => name === "room-empty" ? emptyRoom : room, classExecutions: () => ({ classes: [] }),
        boardQuest: () => name === "tale" ? { ...detail, quest: { ...detail.quest, phase: "done", endedAt: detail.quest.updatedAt } } : detail,
        ledger: () => ({ keeperThreadId: "keeper", boardQuests: [detail.quest], decisions: detail.decisions, rules: detail.rules, asks: detail.asks, routes: detail.routes, restatement: "Vault first. Draft only.", lastReanchorAt: null }),
      } });
      try {
        await waitFor(() => expect(slot.container.querySelector("main h1, main h2")).toBeTruthy());
        await waitFor(() => expect(slot.container.textContent).not.toContain("Loading Tavern"));
        expect(slot.container.querySelector('[role="alert"]')).toBeNull();
        const output = process.env.TAVERN_PAGE_CAPTURE_DIR;
        if (output) {
          const themeFile = process.env.TAVERN_MOCK_THEME_FILE;
          if (!themeFile) throw new Error("TAVERN_MOCK_THEME_FILE is required for theme-faithful captures");
          mkdirSync(output, { recursive: true });
          const styles = ["src/ui/kit/tavern.css", "src/ui/kit/components.css", "src/ui/page/page.css"].map((path) => readFileSync(path, "utf8")).join("\n");
          const themes = readFileSync(themeFile, "utf8");
          writeFileSync(join(output, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tavern ${name} · static fixture capture</title><style>html,body{margin:0;height:100%;background:var(--background)}${styles}</style></head><body>${slot.container.innerHTML}<script>${themes}\nconst theme=THEMES[new URLSearchParams(location.search).get('theme')||'gruve-light'];document.documentElement.className=theme.className;for(const [k,v] of Object.entries(theme.tokens))document.documentElement.style.setProperty(k.startsWith('--')?k:'--'+k,v);</script></body></html>`);
        }
      } finally { slot.lifecycle.unmount(); }
    });
  }
});
