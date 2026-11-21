import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassModeFacts } from "../../../src/shared/class-execution-contract";
import { CLASS_BODY_LIMIT } from "../../../src/shared/class-rules";
import { rpcContract } from "../../../src/shared/contract";
import { utf8Bytes } from "../../../src/ui/page/class-editor";
import { modelLabel } from "../../../src/ui/thread/composer";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import * as scenes from "./scenes";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
type Field = ClassModeFacts["fields"][number];
const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); vi.unstubAllGlobals(); });
beforeEach(() => { window.localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
const LOADED = { timeout: 3000 };

const facts = (fields: Field[], over: Partial<ClassModeFacts> = {}): ClassModeFacts => ({ execution: { providerId: "pi" }, fields, errors: [], notes: [], requiresPi: false, projectOverrides: [], body: { bytes: 640, limit: CLASS_BODY_LIMIT }, ...over });
const warden = scenes.registry.classes.find((c) => c.id === "warden")!;
const wardenChars = warden.characters.map((id) => scenes.registry.characters.find((c) => c.id === id)!.name);
const hire = facts([
  { field: "provider", value: "pi", source: "keeper", substitution: { from: "the Keeper's provider", to: "pi", reason: "Scoped hires run on Pi, which blocks commands before they run." } },
  { field: "model", value: null, source: "shipped-file", varies: "maker", rule: "Keeps the configured model when it is already a different family from the maker." },
  { field: "permission", value: "full", source: "forced", substitution: { from: "auto", to: "full", reason: "Scoped execution uses full provider permission; the scope limits commands." } },
  { field: "role prompt", value: "640 bytes", source: "shipped-file", rule: "Tavern quality rules:\nReport with tavern_report, then end your turn." },
  { field: "characters", value: warden.characters.join(", "), source: "shipped-file", rule: "Only these, in this order." },
], { requiresPi: true, notes: ["Pi offers the class model, so the hire runs on Pi."] });
const start = facts([{ field: "provider", value: null, source: "role", rule: "Uses the provider chosen in the composer." }], { execution: null, errors: ["The Warden class cannot be started here."] });
const keeperFacts = facts([{ field: "party cap", value: "6", source: "settings", rule: "A class file may narrow, never raise, the settings limit." }, { field: "Ranger minutes", value: "12", source: "settings" }], { projectOverrides: ["provider", "model", "budget"].map((field) => ({ field, message: "", path: "/Users/me/src/vault/.agents/tavern/classes/keeper.md" })) });
const entries = scenes.registry.classes.map((c) => c.id === "warden" ? { classId: c.id, start, hire } : c.id === "keeper" ? { classId: c.id, start: keeperFacts, hire: keeperFacts } : { classId: c.id, start: facts([]), hire: facts([{ field: "model", value: "claude-sonnet-5-5", source: "catalog-default", substitution: { from: c.model ?? "provider default", to: "claude-sonnet-5-5", reason: "Resolved against the provider catalog." } }]) });

const PROJECTS = [{ id: "proj-vault", name: "vault", isPersonal: false, href: "/p/vault", settingsHref: "/p/vault/settings" }, { id: "proj-web", name: "web", isPersonal: false, href: "/p/web", settingsHref: "/p/web/settings" }];
async function page(subPath: string, rpc: Partial<Handlers> = {}, opts: { projectId?: string | null } = {}) {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath }, { pluginId: "tavern", experimental_rpcContract: rpcContract, context: { projectId: opts.projectId ?? null }, sidebarThreads: { projects: PROJECTS }, rpc: { registry: () => structuredClone(scenes.registry), room: () => structuredClone(scenes.richRoom), classExecutions: () => structuredClone({ classes: entries }), ...rpc } as Partial<Handlers> as Handlers });
  slots.push(slot);
  return slot;
}
const rowOf = (root: Element, field: string) => root.querySelector<HTMLElement>(`dd[data-field="${field}"]`)!;
/** The facts card once the facts have loaded: it replaces the loading card under the same heading. */
const factsCard = (slot: RenderedSlot) => waitFor(() => { const c = slot.container.querySelector<HTMLElement>(".tv-cfacts"); expect(c).not.toBeNull(); return c!; }, LOADED);

describe("a class page's What it gets", () => {
  it("shows each field a hire gets as the server resolves it, where it comes from, and what it replaced", async () => {
    const slot = await page("class/warden");
    const card = await factsCard(slot);
    await waitFor(() => expect(rowOf(card, "provider")).not.toBeNull(), LOADED);
    expect(rowOf(card, "provider").textContent).toContain("pi");
    expect(rowOf(card, "provider").textContent).toContain("from the hiring Keeper");
    expect(rowOf(card, "provider").querySelector("[data-sub]")!.textContent).toBe("instead of the Keeper's provider: Scoped hires run on Pi, which blocks commands before they run.");
    expect(rowOf(card, "permission").textContent).toContain("from Tavern, forced");
    // The Warden's model depends on the maker it checks, so it names the rule instead of a model.
    expect(rowOf(card, "model").textContent).toContain("Set when it's hired");
    expect(rowOf(card, "model").textContent).toContain("Depends on the maker it checks.");
    expect(rowOf(card, "characters").textContent).toContain(wardenChars.join(", "));
    expect(card.textContent).toContain("Needs Pi");
    expect(within(card).getByRole("list", { name: "Notes from resolving it" }).textContent).toContain("Pi offers the class model");
  });

  it("counts the role prompt in bytes against the limit, and folds Tavern's own rules under it", async () => {
    const slot = await page("class/warden");
    const card = await factsCard(slot);
    await waitFor(() => expect(rowOf(card, "role prompt")).not.toBeNull(), LOADED);
    expect(rowOf(card, "role prompt").textContent).toContain("640 of 12,000 bytes");
    const fold = rowOf(card, "role prompt").querySelector("details")!;
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")!.textContent).toBe("Tavern's own rules, added to every hired member");
    // The fold says by its mark that it opens in place.
    expect(fold.querySelector("summary svg")).not.toBeNull();
    expect(fold.textContent).toContain("Report with tavern_report");
  });

  it("shows only one line on a tab the class can't run in, with a link to the tab that applies, decided by the class's flags", async () => {
    // The Warden's start facts carry an error and a provider row; neither shows.
    const slot = await page("class/warden");
    const card = await factsCard(slot);
    fireEvent.click(within(card).getByRole("button", { name: "When you start it" }));
    const line = card.querySelector<HTMLElement>("[data-cannot]")!;
    expect(line.querySelector("p")!.textContent).toBe("Wardens aren't started; they're hired.");
    // The pointer is its own line and one link, so "See" never hangs; it switches tabs in place, so no "opens elsewhere" mark.
    const pointer = within(line).getByRole("button", { name: "See On hire" });
    expect(pointer.closest("p")!.textContent).toBe("See On hire");
    expect(pointer.querySelector("svg")).toBeNull();
    expect(card.querySelector("dl, [data-field], .tv-cf-errs, .tv-cf-notes, [data-needs-project]")).toBeNull();
    fireEvent.click(pointer);
    await waitFor(() => expect(rowOf(card, "provider")).not.toBeNull());
    expect(within(card).getByRole("button", { name: "On hire" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the Keeper's lead hire facts and still offers start facts", async () => {
    const slot = await page("class/keeper");
    const card = await factsCard(slot);
    expect(within(card).getByRole("button", { name: "On hire" }).getAttribute("aria-pressed")).toBe("true");
    expect(card.querySelector("[data-cannot]")).toBeNull();
    expect(rowOf(card, "party cap").textContent).toContain("6");
    fireEvent.click(within(card).getByRole("button", { name: "When you start it" }));
    expect(within(card).getByRole("button", { name: "When you start it" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says a class that can be neither started nor hired once on both tabs, with no pointer", async () => {
    const shelved = { ...scenes.registry, classes: scenes.registry.classes.map((c) => c.id === "ranger" ? { ...c, startable: false, hireable: false } : c) };
    const slot = await page("class/ranger", { registry: () => structuredClone(shelved) });
    const card = await factsCard(slot);
    for (const tab of ["On hire", "When you start it"]) {
      fireEvent.click(within(card).getByRole("button", { name: tab }));
      const line = card.querySelector<HTMLElement>("[data-cannot]")!;
      expect(line.textContent).toBe("Ranger can't be started or hired here.");
      expect(line.querySelectorAll("p")).toHaveLength(1);
      expect(within(line).queryByRole("button")).toBeNull();
    }
  });

  it("says a provider the class's guard requires is Pi, for that reason, with no condition, project or no project", async () => {
    const guard = facts([{ field: "provider", value: "pi", source: "forced", rule: "Required by the class’s guard." }, { field: "scope", value: "readonly", source: "preset", dependsOnProject: true }], { execution: null });
    const slot = await page("class/ranger", { classExecutions: () => ({ classes: entries.map((e) => e.classId === "ranger" ? { ...e, hire: guard } : e) }) });
    const card = await factsCard(slot);
    await waitFor(() => expect(rowOf(card, "provider")).not.toBeNull(), LOADED);
    expect(rowOf(card, "provider").textContent).toBe("pirequired by the class’s guard");
    expect(rowOf(card, "provider").querySelector("[data-depends]")).toBeNull();
    expect(rowOf(card, "scope").querySelector("[data-depends]")!.textContent).toBe("Without a project's own class file; one could change it.");
  });
  it("says once that the hiring Keeper sets a value nothing here fixes", async () => {
    const byKeeper = facts([{ field: "provider", value: null, source: "keeper", varies: "keeper" }]);
    const slot = await page("class/ranger", { classExecutions: () => ({ classes: entries.map((e) => e.classId === "ranger" ? { ...e, hire: byKeeper } : e) }) });
    const card = await factsCard(slot);
    await waitFor(() => expect(rowOf(card, "provider")).not.toBeNull(), LOADED);
    expect(rowOf(card, "provider").textContent).toBe("Set by the Keeper that hires it.");
  });
  it("says a start's provider is chosen in the composer when neither the class nor Settings names one", async () => {
    const composer = facts([{ field: "provider", value: null, source: "provider-default", rule: "Uses the provider selected in the composer." }]);
    const slot = await page("class/ranger", { classExecutions: () => ({ classes: entries.map((e) => e.classId === "ranger" ? { ...e, start: composer, hire: composer } : e) }) });
    const card = await factsCard(slot);
    await waitFor(() => expect(rowOf(card, "provider")).not.toBeNull(), LOADED);
    expect(rowOf(card, "provider").textContent).toBe("Chosen in the composerfrom the composer, when you start it");
    expect(rowOf(card, "provider").textContent).not.toContain("provider's default");
  });
  it("shows the Keeper's effective limits, and one notice naming the project file that replaces the class", async () => {
    const slot = await page("class/keeper");
    const card = await factsCard(slot);
    await waitFor(() => expect(rowOf(card, "party cap")).not.toBeNull(), LOADED);
    expect(rowOf(card, "party cap").textContent).toContain("6 members");
    expect(rowOf(card, "party cap").textContent).toContain("from Tavern's settings");
    expect(rowOf(card, "Ranger minutes").textContent).toContain("12 min");
    const notices = card.querySelectorAll("[data-override]");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.textContent).toContain("replaces the whole class, including provider, model, budget");
    expect(notices[0]!.textContent).toContain("~/src/vault/.agents/tavern/classes/keeper.md");
  });
});

describe("the class page on one column", () => {
  it("puts what a class gets before the role prompt, and the prompt holds no control", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/ui/page/page.css", "utf8")).toMatch(/@container tavern-page \(max-width: 900px\) \{[^}]*\}\s*\/\*[^*]*\*\/\s*\.tavern\.tv-page \.tv-classd \.tv-ggrid > aside \{ order: -1; \}/);
    const slot = await page("class/warden");
    await factsCard(slot);
    const prompt = slot.getByRole("heading", { name: /^Role prompt/ }).closest("section")!;
    expect(prompt.querySelectorAll("button, a, input, select, textarea, summary, [tabindex]")).toHaveLength(0);
  });
});

describe("the class page rail", () => {
  it("folds What it gets, Hiring and Characters like the quest page, with counts and a preview", async () => {
    const slot = await page("class/warden");
    await factsCard(slot);
    const aside = slot.container.querySelector<HTMLElement>(".tv-classd .tv-ggrid > aside")!;
    const folds = [...aside.querySelectorAll<HTMLElement>(".tv-rec-fold[data-fold]")];
    expect(folds.map((f) => f.getAttribute("data-fold"))).toEqual(["class:warden.facts", "class:warden.hiring", "class:warden.characters"]);
    // What it gets is the class page's main answer, so it opens; the two short cards fold, each saying how much it holds.
    const expanded = (f: HTMLElement) => f.querySelector(".tv-rec-ft")!.getAttribute("aria-expanded");
    expect(expanded(folds[0]!)).toBe("true");
    expect(folds[0]!.querySelector(".tv-count")!.textContent).toContain("field");
    expect(expanded(folds[1]!)).toBe("false");
    expect(folds[1]!.querySelector(".tv-count")).not.toBeNull();
    expect(expanded(folds[2]!)).toBe("false");
    expect(folds[2]!.querySelector(".tv-count")!.textContent).toBe(`${warden.characters.length} characters`);
    // A folded Characters keeps its members in the preview.
    expect(folds[2]!.querySelector(".tv-cd-chars")).not.toBeNull();
  });
});

describe("the Classes list", () => {
  it("shows the model a hire resolves to, not the class file's value", async () => {
    const slot = await page("classes");
    const smith = scenes.registry.classes.find((c) => c.id === "smith")!;
    const row = await slot.findByTitle("Open the Smith class", {}, LOADED);
    await waitFor(() => expect(row.querySelector(".tv-ct-model")!.textContent).toContain("Claude Sonnet 5.5"), LOADED);
    expect(row.querySelector<HTMLElement>(".tv-ct-model")!.title).toContain("claude-sonnet-5-5");
    expect(row.querySelector(".tv-ct-model")!.textContent).toContain(`instead of ${smith.model ? modelLabel(smith.model) : "provider default"}`);
    const warden = await slot.findByTitle("Open the Warden class", {}, LOADED);
    expect(warden.querySelector(".tv-ct-model")!.textContent).toBe("depends on the maker");
  });
});

describe("the Classes list on one column", () => {
  it("shows each row's model as its last line instead of hiding the Model column", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/ui/page/page.css", "utf8");
    // The narrow block that lays out the Classes table.
    const at = css.indexOf(".tavern.tv-page .tv-ct-row { grid-template-columns: minmax(0, 1fr) auto 12px;");
    const block = css.slice(css.lastIndexOf("@container tavern-page (max-width: 900px) {", at), css.indexOf("\n}\n", at));
    expect(block).toMatch(/grid-template-areas: "n c i" "l l l" "m m m";/);
    expect(block).toMatch(/\.tv-ct-model \{ grid-area: m;/);
    expect(block).not.toMatch(/\.tv-ct-model[^{]*\{[^}]*display: none/);
    expect(block).not.toMatch(/, \.tavern\.tv-page \.tv-ct-model \{ display: none/);
  });
});

describe("readable model names with no label from the server", () => {
  it("names a raw model id the way the composer does, on the page and in the list, with the raw id in the hover text; a server label wins", async () => {
    const raw = facts([{ field: "model", value: "anthropic/claude-opus-5-5", source: "settings", dependsOnProject: true }], { execution: null });
    const labelled = facts([{ field: "model", value: "anthropic/claude-opus-5-5", valueLabel: "Claude Opus 5.5 (1M)", source: "settings" }]);
    const slot = await page("class/ranger", { classExecutions: () => ({ classes: entries.map((e) => e.classId === "ranger" ? { ...e, hire: raw, start: labelled } : e) }) });
    const card = await factsCard(slot);
    await waitFor(() => expect(rowOf(card, "model")).not.toBeNull(), LOADED);
    const v = rowOf(card, "model").querySelector<HTMLElement>(".tv-cf-v")!;
    expect(v.textContent).toBe("Claude Opus 5.5");
    expect(v.title).toBe("anthropic/claude-opus-5-5");
    fireEvent.click(within(card).getByRole("button", { name: "When you start it" }));
    expect(rowOf(card, "model").querySelector(".tv-cf-v")!.textContent).toBe("Claude Opus 5.5 (1M)");
    expect(modelLabel("openai/gpt-6.1-sol")).toBe("GPT-6.1 Sol");
  });
  it("names the list's models the same way, never as a raw id, from the mode the class runs in", async () => {
    const raw = facts([{ field: "model", value: "anthropic/claude-opus-5-5", source: "settings", dependsOnProject: true }, { field: "reasoning", value: "xhigh", source: "settings" }], { execution: null });
    const otherMode = facts([{ field: "model", value: "openai/gpt-6.1-sol", source: "settings" }]);
    const slot = await page("classes", { classExecutions: () => ({ classes: entries.map((e) => e.classId === "keeper" ? { ...e, hire: raw, start: otherMode } : e) }) });
    const cell = (await slot.findByTitle("Open the Keeper class", {}, LOADED)).querySelector<HTMLElement>(".tv-ct-model")!;
    await waitFor(() => expect(cell.textContent).toBe("Claude Opus 5.5 · xhigh · depends on the project"), LOADED);
    expect(cell.title).toContain("anthropic/claude-opus-5-5");
  });
});

describe("facts that failed, or that depend on the project", () => {
  it("never reads 'provider default' when the facts failed to load: the class file's model, else 'unknown', with the reason in the hover text", async () => {
    const slot = await page("classes", { classExecutions: () => { throw new Error("Tavern couldn't read the project"); } });
    const smith = scenes.registry.classes.find((c) => c.id === "smith")!;
    const row = await slot.findByTitle("Open the Smith class", {}, LOADED);
    const cell = row.querySelector<HTMLElement>(".tv-ct-model")!;
    await waitFor(() => expect(cell.title).toContain("Couldn't load what a hire gets"), LOADED);
    expect(cell.title).toContain("Tavern couldn't read the project");
    expect(cell.textContent).toBe(smith.model ? `${modelLabel(smith.model)} (class file)` : "unknown");
    if (smith.model) expect(cell.title).toContain(smith.model);
    for (const c of slot.container.querySelectorAll(".tv-ct-model")) expect(c.textContent).not.toMatch(/provider default/);
    // The failure is said once, above the table, with a way to try again; the cells only say what they still know.
    const alert = slot.container.querySelector<HTMLElement>(".tv-cf-failed")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Tavern couldn't read the project");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows a class whose own facts have errors by its class file's model, with the errors in the hover text", async () => {
    const broken = facts([{ field: "model", value: null, source: "shipped-file" }], { execution: null, errors: ["Unknown model: openai/gpt-9"] });
    const slot = await page("classes", { classExecutions: () => ({ classes: entries.map((e) => e.classId === "ranger" ? { ...e, hire: broken, start: broken } : e) }) });
    const ranger = scenes.registry.classes.find((c) => c.id === "ranger")!;
    const cell = (await slot.findByTitle("Open the Ranger class", {}, LOADED)).querySelector<HTMLElement>(".tv-ct-model")!;
    await waitFor(() => expect(cell.title).toContain("Unknown model: openai/gpt-9"), LOADED);
    expect(cell.textContent).toBe(ranger.model ? `${modelLabel(ranger.model)} (class file)` : "unknown");
  });

  const baseline = (over: Partial<Field> = {}) => facts([
    { field: "model", value: "anthropic/claude-sonnet-5-5", valueLabel: "Claude Sonnet 5.5", source: "shipped-file", dependsOnProject: true, ...over } as Field,
    { field: "scope", value: "readonly", source: "preset", dependsOnProject: true } as Field,
    { field: "tools", value: "journal", source: "role" },
  ], { execution: null });
  it("with no project, says the facts depend on one, marks those fields, and asks again for the project the user picks", async () => {
    const calls: unknown[] = [];
    const slot = await page("class/ranger", { classExecutions: (input) => { calls.push(input); const f = (input as { projectId?: string }).projectId ? facts([{ field: "model", value: "openai/gpt-6.1-sol", valueLabel: "GPT-6.1 Sol", source: "project-file", path: "/Users/me/src/vault/.agents/tavern/classes/ranger.md" } as Field]) : baseline(); return { classes: entries.map((e) => e.classId === "ranger" ? { ...e, hire: f, start: f } : e) }; } });
    const card = await factsCard(slot);
    const lead = await waitFor(() => { const n = card.querySelector<HTMLElement>("[data-needs-project]"); expect(n).not.toBeNull(); return n!; }, LOADED);
    expect(lead.textContent).toContain("This depends on the project. Open it from a thread in that project, or pick one:");
    expect(lead.textContent).toContain("A project's class file could change: model, scope.");
    expect(card.querySelectorAll("[data-depends]")).toHaveLength(2);
    // A shown value is the baseline (your files and the shipped ones), which a project's own class file could replace: said as a condition, not a second answer.
    expect(rowOf(card, "model").querySelector("[data-depends]")!.textContent).toBe("Without a project's own class file; one could change it.");
    expect(rowOf(card, "tools").querySelector("[data-depends]")).toBeNull();
    // The readable model name, with the raw id in the hover text.
    const model = rowOf(card, "model").querySelector<HTMLElement>(".tv-cf-v")!;
    expect(model.textContent).toBe("Claude Sonnet 5.5");
    expect(model.title).toBe("anthropic/claude-sonnet-5-5");
    expect(calls[0]).toEqual({});
    const select = within(lead).getByRole("combobox", { name: /This depends on the project/ });
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Pick a project", "vault", "web"]);
    fireEvent.change(select, { target: { value: "proj-vault" } });
    await waitFor(() => expect(calls).toContainEqual({ projectId: "proj-vault" }), LOADED);
    await waitFor(() => expect(slot.container.querySelector(".tv-cfacts dd[data-field=\"model\"] .tv-cf-v")!.textContent).toBe("GPT-6.1 Sol"), LOADED);
    expect(slot.container.querySelector(".tv-cfacts")!.querySelectorAll("[data-depends]")).toHaveLength(0);
  });

  it("asks with the thread's project, and offers no project pick, when the page has one", async () => {
    const calls: unknown[] = [];
    const slot = await page("class/ranger", { classExecutions: (input) => { calls.push(input); return { classes: entries }; } }, { projectId: "proj-web" });
    const card = await factsCard(slot);
    expect(calls[0]).toEqual({ projectId: "proj-web" });
    expect(card.querySelector("[data-needs-project]")).toBeNull();
  });

  it("says 'depends on the project' in the list's Model column, and offers the pick above the table", async () => {
    const slot = await page("classes", { classExecutions: () => ({ classes: entries.map((e) => e.classId === "ranger" ? { ...e, hire: JSON.parse(JSON.stringify(baseline({ value: null, valueLabel: undefined }))) as ClassModeFacts, start: baseline() } : e) }) });
    const cell = (await slot.findByTitle("Open the Ranger class", {}, LOADED)).querySelector<HTMLElement>(".tv-ct-model")!;
    await waitFor(() => expect(cell.textContent).toBe("depends on the project"), LOADED);
    expect(slot.container.querySelector(".tv-classes > [data-needs-project]")).not.toBeNull();
  });
});

describe("the class editor's role prompt", () => {
  it("counts UTF-8 bytes of the body alone, as the server does", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("…")).toBe(3);
  });
});
