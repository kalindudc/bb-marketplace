import { it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestRow } from "../../../src/ui/kit";
import { richRoom, registry, vault, rollout, audit } from "./scenes";

vi.mock("@get-bb/plugin-sdk/app", async importOriginal => ({ ...await importOriginal<typeof import("@get-bb/plugin-sdk/app")>(), useBbNavigate: () => ({ toPluginPanel: () => {} }) }));

it.skipIf(!process.env.U1_LAYOUT)("renders the real homepage rows for browser measurement", () => {
  const quests = [
    { ...vault, short: "Edge resiliency watch", updatedAt: Date.now() - 120 * 60_000, waypoints: vault.waypoints.slice(0, 4).map((w, i) => ({ ...w, state: i < 3 ? "verified" as const : "todo" as const })) },
    { ...rollout, short: "Edge ops monitor", updatedAt: Date.now() - 35 * 60_000 },
    { ...audit, short: "Class tool access", updatedAt: Date.now() - 1440 * 60_000, waypoints: [{ ...audit.waypoints[0]!, state: "reported" as const, title: "Waiting on a Warden to check the tool access for every class" }], members: [{ ...audit.members[0]!, displayName: "Juno", state: "working" as const, checkerWaypointId: audit.waypoints[0]!.id }] },
  ];
  const room = { ...richRoom, asks: richRoom.asks.filter(a => a.boardQuestId === vault.id || a.boardQuestId === rollout.id) };
  const markup = renderToStaticMarkup(<section className="tavern tv-page tv-homepage" aria-label="Tavern"><header className="tv-colh"><h3>Quests on the board <span className="anc">goals</span></h3><span className="tv-count">3 quests</span></header><div className="tv-card tv-homequests">{quests.map(quest => <QuestRow key={quest.id} quest={quest} room={room} registry={registry} keeper={{ ...room.keepers.find(k => k.member.threadId === quest.keeperThreadId)!, member: { ...room.keepers.find(k => k.member.threadId === quest.keeperThreadId)!.member, displayName: quest.id === audit.id ? "Wren, Keeper of the long-running access audit" : quest.keeperThreadId === vault.keeperThreadId ? "Wren II" : "Moss" } }} showKeeper />)}</div></section>);
  const pages: Record<string, string> = {};
  for (const [theme, dark, css] of [["gruve-light", false, "bb-theme-gruve.css"], ["gruve-dark", true, "bb-theme-gruve.css"], ["gruvbox-dark", true, "bb-theme-gruvbox-dark.css"]] as const) {
    pages[theme] = `<!doctype html><html class="bb-app-shell-root ${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Homepage row measurements: ${theme}</title><link rel="stylesheet" href="bb-app.css"><link rel="stylesheet" href="${css}">${theme.startsWith("gruve") ? '<link rel="stylesheet" href="bb-gruve-appearance.css">' : ""}<link rel="stylesheet" href="app.css"><style>html,body{margin:0;width:100%;box-sizing:border-box}body{padding:16px;background:var(--background);color:var(--foreground);font:13px var(--font-sans)}section.tv-homepage{width:100%;max-width:100%;min-width:0;box-sizing:border-box}</style></head><body>${markup}</body></html>`;
  }
  process.stdout.write(`U1_LAYOUT_JSON:${JSON.stringify(pages)}\n`);
});
