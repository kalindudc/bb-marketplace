import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { PluginSettingsSectionProps } from "@get-bb/plugin-sdk/app";
import type { Config } from "../../src/config";
import { app, callsTo, config, handlers, mount, server, overview, unmountAll, type Handlers } from "./helpers";

afterEach(unmountAll);

async function section(id: string, rpc: Partial<Handlers> = {}) {
  const loaded = await app();
  const registration = loaded.settingsSections.find((item) => item.id === id);
  if (!registration) throw new Error(`no settings section ${id}`);
  return mount<PluginSettingsSectionProps>(registration.component, {}, handlers(rpc));
}

const saved = (slot: Awaited<ReturnType<typeof section>>) => callsTo(slot, "saveConfig").map((input) => (input as { config: Config }).config);

describe("Shuttle settings sections", () => {
  it("registers its four sections below bb's own fields", async () => {
    const loaded = await app();
    expect(loaded.settingsSections.map((item) => [item.id, item.title])).toEqual([
      ["servers", "Servers"], ["presets", "Review presets"], ["automations", "Automations"], ["import-export", "Import and export"],
    ]);
  });

  it("edits a preset and saves the whole config", async () => {
    const slot = await section("presets");
    const editor = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-preset-editor='standard']") ?? Promise.reject(new Error("no editor")));
    expect(within(editor).getByTestId("bb-provider-model-picker")).toBeTruthy();
    fireEvent.change(within(editor).getByRole("textbox", { name: "Preset name" }), { target: { value: "Deep review" } });
    fireEvent.change(within(editor).getByRole("combobox", { name: "Skill" }), { target: { value: "critique" } });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Model" }), { target: { value: "openai/gpt-5.2" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Apply execution selection" }));
    expect(editor.querySelector("[data-prompt-preview]")!.textContent).toContain("https://github.com/get-bb/bb/pull/4411");

    fireEvent.click(slot.getByRole("button", { name: /Quick skim/u }));
    const quick = slot.container.querySelector<HTMLElement>("[data-preset-editor='quick']")!;
    expect(quick.querySelector("[data-execution='default']")).not.toBeNull();
    fireEvent.click(within(quick).getByRole("button", { name: "Make default" }));
    fireEvent.click(slot.getByRole("button", { name: "Save presets" }));

    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    const next = saved(slot)[0]!;
    expect(next.servers).toEqual(config().servers);
    expect(next.autoReview).toEqual(config().autoReview);
    expect(next.presets.map((preset) => [preset.id, preset.name, preset.default, preset.skill, preset.model])).toEqual([
      ["standard", "Deep review", false, "critique", "openai/gpt-5.2"],
      ["quick", "Quick skim", true, "", undefined],
    ]);
  });

  it("puts a preset back on bb's default agent and model", async () => {
    const slot = await section("presets");
    const editor = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-preset-editor='standard']") ?? Promise.reject(new Error("no editor")));
    fireEvent.click(within(editor).getByRole("button", { name: "Use bb default" }));
    expect(editor.querySelector("[data-execution='default']")).not.toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Save presets" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    const standard = saved(slot)[0]!.presets[0]!;
    expect(Object.keys(standard)).not.toContain("providerId");
    expect(Object.keys(standard)).not.toContain("model");
    expect(Object.keys(standard)).not.toContain("reasoningLevel");
  });

  it("adds a preset with its own id and a copy of the default prompt", async () => {
    const slot = await section("presets");
    fireEvent.click(await slot.findByRole("button", { name: "New preset" }));
    const editor = slot.container.querySelector<HTMLElement>("[data-preset-editor='preset-1']")!;
    fireEvent.change(within(editor).getByRole("textbox", { name: "Preset id" }), { target: { value: "security" } });
    fireEvent.click(slot.getByRole("button", { name: "Save presets" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    const added = saved(slot)[0]!.presets[2]!;
    expect(added).toMatchObject({ id: "security", name: "New preset", default: false });
    expect(added.prompt).toBe(config().presets[0]!.prompt);
  });

  it("shows the server's refusal and keeps the edits", async () => {
    const slot = await section("presets", { saveConfig: () => { throw new Error("presets.0.name: Too small: expected string to have >=1 characters"); } });
    const editor = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-preset-editor='standard']") ?? Promise.reject(new Error("no editor")));
    fireEvent.change(within(editor).getByRole("textbox", { name: "Preset name" }), { target: { value: "" } });
    fireEvent.click(slot.getByRole("button", { name: "Save presets" }));
    expect((await slot.findByRole("alert")).textContent).toContain("presets.0.name: Too small");
    expect(slot.getByText("Unsaved changes")).toBeTruthy();
  });

  it("tests a server and shows each operation's result", async () => {
    const slot = await section("servers", {
      overview: () => overview({ servers: [server({ operations: ["whoami", "view"] })] }),
      testServer: () => ({ results: [{ operation: "whoami", ok: true, detail: "kalindudc", ms: 120 }, { operation: "authored", ok: false, detail: "gh: not logged in", ms: 80 }] }),
    });
    const card = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-server='github']") ?? Promise.reject(new Error("no card")));
    expect(card.textContent).toContain("Signed in as kalindudc");
    fireEvent.click(within(card).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(card.querySelectorAll("[data-test-result]")).toHaveLength(2));
    expect(callsTo(slot, "testServer")).toEqual([{ id: "github" }]);
    expect(card.querySelector("[data-test-result='authored']")!.textContent).toContain("gh: not logged in");
  });

  it("adds a command server and saves it with the others", async () => {
    const slot = await section("servers");
    fireEvent.click(await slot.findByRole("button", { name: "Add a server" }));
    const form = slot.container.querySelector<HTMLElement>("[data-server-form]")!;
    const type = (name: string, value: string) => fireEvent.change(within(form).getByRole("textbox", { name }), { target: { value } });
    type("Server name", "GitLab");
    type("Server id", "gitlab");
    type("Link pattern", "^https://gitlab\\.com/(?<repo>.+?)/-/merge_requests/(?<number>\\d+)");
    type("Link template", "https://gitlab.com/{repo}/-/merge_requests/{number}");
    fireEvent.change(within(form).getByRole("combobox", { name: "Number sign" }), { target: { value: "!" } });
    type("view command", "shuttle-glab view $SHUTTLE_REPO $SHUTTLE_NUMBER");
    type("authored command", "shuttle-glab list --author @me");

    fireEvent.click(within(form).getByRole("button", { name: "Test commands" }));
    await waitFor(() => expect(callsTo(slot, "testServer")).toHaveLength(1));
    expect(callsTo(slot, "testServer")[0]).toMatchObject({ server: { id: "gitlab", kind: "command", sep: "!" } });

    fireEvent.click(within(form).getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.servers).toEqual([
      ...config().servers,
      {
        id: "gitlab", name: "GitLab", kind: "command", enabled: true, sep: "!",
        pattern: "^https://gitlab\\.com/(?<repo>.+?)/-/merge_requests/(?<number>\\d+)",
        link: "https://gitlab.com/{repo}/-/merge_requests/{number}",
        commands: { authored: "shuttle-glab list --author @me", view: "shuttle-glab view $SHUTTLE_REPO $SHUTTLE_NUMBER" },
      },
    ]);
    await waitFor(() => expect(slot.container.querySelector("[data-server-form]")).toBeNull());
  });

  it("edits a server's review workspace and keeps the fields its form does not show", async () => {
    const delta = { id: "delta", name: "Delta", kind: "command" as const, enabled: true, sep: "#" as const, pattern: "^https://d/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://d/{repo}/pull/{number}", read: "dt pr view {number} -R {repo}", commands: { view: "sh delta.sh" } };
    const slot = await section("servers", { getConfig: () => ({ config: config({ servers: [...config().servers, delta] }) }) });
    fireEvent.click(await slot.findByRole("button", { name: "Edit Delta" }));
    const form = slot.container.querySelector<HTMLElement>("[data-server-form]")!;
    expect((within(form).getByRole("textbox", { name: "Read command" }) as HTMLInputElement).value).toBe("dt pr view {number} -R {repo}");
    fireEvent.change(within(form).getByRole("combobox", { name: "Review workspace" }), { target: { value: "provider" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Environment provider" }), { target: { value: "world-tree" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Provider inputs" }), { target: { value: "{ nope" } });
    expect((within(form).getByRole("button", { name: "Save server" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByRole("textbox", { name: "Provider inputs" }), { target: { value: '{ "tree": "shuttle-{number}" }' } });
    fireEvent.click(within(form).getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.servers.at(-1)).toEqual({ ...delta, workspace: { kind: "provider", provider: "world-tree", inputs: { tree: "shuttle-{number}" } } });
  });

  it("flags a link pattern without its groups before saving", async () => {
    const slot = await section("servers");
    fireEvent.click(await slot.findByRole("button", { name: "Add a server" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Link pattern" }), { target: { value: "^https://example\\.com/(\\d+)" } });
    expect(slot.getByText("needs (?<repo>…) and (?<number>…) groups")).toBeTruthy();
  });

  it("disables a server", async () => {
    const slot = await section("servers");
    fireEvent.click(await slot.findByRole("switch", { name: "Enable GitHub" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.servers[0]!.enabled).toBe(false);
  });

  it("saves the automations", async () => {
    const slot = await section("automations");
    fireEvent.click(await slot.findByRole("checkbox", { name: /I am @mentioned/u }));
    fireEvent.change(slot.getByRole("textbox", { name: "Only these repositories" }), { target: { value: "shop/world, get-bb/*" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Auto reviews a day" }), { target: { value: "3" } });
    fireEvent.change(slot.getByRole("combobox", { name: "Auto review preset" }), { target: { value: "quick" } });
    fireEvent.change(slot.getByRole("combobox", { name: "What a new agent does" }), { target: { value: "forward" } });
    fireEvent.click(slot.getByRole("checkbox", { name: /Ignore bots/u }));
    fireEvent.click(slot.getByRole("checkbox", { name: /A thread that links one of your PRs becomes its agent/u }));
    fireEvent.click(slot.getByRole("button", { name: "Save automations" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    const next = saved(slot)[0]!;
    expect(next.autoReview).toMatchObject({ when: ["requested", "mentioned"], repos: ["shop/world", "get-bb/*"], maxPerDay: 3, preset: "quick" });
    expect(next.watch).toMatchObject({ mode: "forward", ignoreBots: false, autoWatch: false });
    expect(next.presets).toEqual(config().presets);
  });

  it("names agents, not watching, in the automations", async () => {
    const slot = await section("automations");
    await slot.findByText("Agents");
    const mode = slot.getByRole("combobox", { name: "What a new agent does" }) as HTMLSelectElement;
    expect([...mode.options].map((option) => [option.value, option.textContent])).toEqual([
      ["act", "Fix it: send new feedback and ask it to fix it"],
      ["forward", "Just tell it: send new feedback only"],
    ]);
    expect(slot.getByRole("checkbox", { name: /Also send failed checks on the head/u })).toBeTruthy();
    expect(slot.getByText("What a Fix it agent is asked to do")).toBeTruthy();
    expect(slot.queryByText(/Watched PRs/u)).toBeNull();
  });

  it("puts the conversation and merge commands in their own group of the server form", async () => {
    const slot = await section("servers");
    fireEvent.click(await slot.findByRole("button", { name: "Add a server" }));
    const form = slot.container.querySelector<HTMLElement>("[data-server-form]")!;
    const groups = [...form.querySelectorAll("h4")].map((heading) => heading.textContent);
    expect(groups).toEqual(["Managing your PRs (optional)", "Conversation and merging (optional)"]);
    const help = form.querySelectorAll("h4")[1]!.nextElementSibling!.textContent!;
    for (const variable of ["SHUTTLE_METHOD", "SHUTTLE_HEAD", "SHUTTLE_AUTO", "SHUTTLE_DELETE_BRANCH", "SHUTTLE_SUBJECT", "SHUTTLE_BODY", "SHUTTLE_THREAD", "SHUTTLE_VERDICT", "SHUTTLE_COMMENTS"]) {
      expect(help).toContain(variable);
    }
    for (const op of ["merge", "merge_options", "comment", "review", "reply", "resolve", "reviewed"]) {
      expect(within(form).getByRole("textbox", { name: `${op} command` })).toBeTruthy();
    }
    expect(within(form).getByText("Reply in a review thread")).toBeTruthy();
  });

  it("previews a pasted TOML's changes, then applies it", async () => {
    const slot = await section("import-export", {
      importToml: ({ apply }) => ({ changes: ["adds server gitlab", "changes preset standard"], config: apply ? config() : null }),
      exportToml: () => ({ toml: "[[server]]\nid = \"github\"\n" }),
    });
    fireEvent.click(slot.getByRole("button", { name: "Show the TOML" }));
    expect((await waitFor(() => slot.container.querySelector("[data-toml]") ?? Promise.reject(new Error("no toml")))).textContent).toContain("[[server]]");

    fireEvent.click(slot.getByRole("button", { name: "Paste TOML…" }));
    fireEvent.change(slot.getByRole("textbox", { name: "TOML to import" }), { target: { value: "[[server]]\nid = \"gitlab\"" } });
    expect((slot.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Preview changes" }));
    await slot.findByText("adds server gitlab");
    fireEvent.click(slot.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(callsTo(slot, "importToml")).toEqual([
      { toml: "[[server]]\nid = \"gitlab\"", apply: false },
      { toml: "[[server]]\nid = \"gitlab\"", apply: true },
    ]));
  });

  it("shows why a pasted TOML was refused", async () => {
    const slot = await section("import-export", { importToml: () => { throw new Error("the TOML does not parse: unexpected character"); } });
    fireEvent.click(slot.getByRole("button", { name: "Paste TOML…" }));
    fireEvent.change(slot.getByRole("textbox", { name: "TOML to import" }), { target: { value: "[[server" } });
    fireEvent.click(slot.getByRole("button", { name: "Preview changes" }));
    expect((await slot.findByRole("alert")).textContent).toContain("the TOML does not parse");
  });
});
