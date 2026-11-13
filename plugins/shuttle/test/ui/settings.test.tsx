import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { PluginSettingsSectionProps } from "@get-bb/plugin-sdk/app";
import { DEFAULT_REVIEW_PROMPT, DEFAULT_VERIFIER_COMMAND, type Config } from "../../src/config";
import { app, autoPostInsights, callsTo, config, handlers, mount, server, overview, shadowRepo, unmountAll, type Handlers } from "./helpers";

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

  it("switches a saved preset to the shipped prompt, and offers it only when the prompt differs", async () => {
    const slot = await section("presets");
    const standard = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-preset-editor='standard']") ?? Promise.reject(new Error("no editor")));
    expect(within(standard).queryByRole("button", { name: /Use the shipped prompt/u })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Quick skim/u }));
    const quick = slot.container.querySelector<HTMLElement>("[data-preset-editor='quick']")!;
    const shipped = within(quick).getByRole("button", { name: "Use the shipped prompt (what, why, how and should)" });
    // The prompt column can be narrower than the label, which then has to wrap instead of running past the card.
    expect(shipped.className.split(/\s+/u)).not.toContain("whitespace-nowrap");
    expect(shipped.className.split(/\s+/u)).not.toContain("h-6");
    fireEvent.click(shipped);
    expect(within(quick).queryByRole("button", { name: /Use the shipped prompt/u })).toBeNull();
    expect(quick.querySelector("[data-prompt-preview]")!.textContent).toContain("4. Should:");
    fireEvent.click(slot.getByRole("button", { name: "Save presets" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.presets.map((preset) => preset.prompt)).toEqual([DEFAULT_REVIEW_PROMPT, DEFAULT_REVIEW_PROMPT]);
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
      testServer: () => ({ results: [{ operation: "whoami", ok: true, detail: "robin-c", ms: 120 }, { operation: "authored", ok: false, detail: "gh: not logged in", ms: 80 }] }),
    });
    const card = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-server='github']") ?? Promise.reject(new Error("no card")));
    expect(card.textContent).toContain("Signed in as robin-c");
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
    const lab = { id: "lab", name: "Lab", kind: "command" as const, enabled: true, sep: "#" as const, pattern: "^https://d/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://d/{repo}/pull/{number}", read: "lab pr view {number} -R {repo}", commands: { view: "sh lab.sh" } };
    const slot = await section("servers", { getConfig: () => ({ config: config({ servers: [...config().servers, lab] }) }) });
    fireEvent.click(await slot.findByRole("button", { name: "Edit Lab" }));
    const form = slot.container.querySelector<HTMLElement>("[data-server-form]")!;
    expect((within(form).getByRole("textbox", { name: "Read command" }) as HTMLInputElement).value).toBe("lab pr view {number} -R {repo}");
    fireEvent.change(within(form).getByRole("combobox", { name: "Review workspace" }), { target: { value: "provider" } });
    fireEvent.change(within(form).getByRole("combobox", { name: "Environment provider" }), { target: { value: "my-trees" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Provider inputs" }), { target: { value: "{ nope" } });
    expect((within(form).getByRole("button", { name: "Save server" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByRole("textbox", { name: "Provider inputs" }), { target: { value: '{ "tree": "shuttle-{number}" }' } });
    fireEvent.click(within(form).getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.servers.at(-1)).toEqual({ ...lab, workspace: { kind: "provider", provider: "my-trees", inputs: { tree: "shuttle-{number}" } } });
  });

  it("puts a server's reviews on a new machine from a machine provider bb has, with its inputs", async () => {
    const lab = { id: "lab", name: "Lab", kind: "command" as const, enabled: true, sep: "#" as const, pattern: "^https://d/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://d/{repo}/pull/{number}", commands: { view: "sh lab.sh" }, workspace: { kind: "provider" as const, provider: "my-trees", inputs: { tree: "shuttle-{number}" } } };
    const slot = await section("servers", { getConfig: () => ({ config: config({ servers: [...config().servers, lab] }) }) });
    fireEvent.click(await slot.findByRole("button", { name: "Edit Lab" }));
    const form = slot.container.querySelector<HTMLElement>("[data-server-form]")!;
    await waitFor(() => expect(form.querySelector("datalist#shuttle-environment-providers option[value='sandbox-checkout']")).not.toBeNull());
    expect(within(form).getByText("My trees: A tree in the repository's own place")).toBeTruthy();
    expect((within(form).getByRole("combobox", { name: "Review machine" }) as HTMLSelectElement).value).toBe("project");
    expect(within(form).queryByRole("combobox", { name: "Machine provider" })).toBeNull();

    fireEvent.change(within(form).getByRole("combobox", { name: "Environment provider" }), { target: { value: "sandbox-checkout" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Provider inputs" }), { target: { value: '{ "base": "origin/{head_ref}" }' } });
    fireEvent.change(within(form).getByRole("combobox", { name: "Review machine" }), { target: { value: "new" } });
    expect((within(form).getByRole("button", { name: "Save server" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByText("Enter the machine provider's id, as bb machine providers lists them.")).toBeTruthy();
    fireEvent.change(within(form).getByRole("combobox", { name: "Machine provider" }), { target: { value: "sandbox" } });
    expect(within(form).getByText("Sandbox: A sandbox machine")).toBeTruthy();
    fireEvent.change(within(form).getByRole("textbox", { name: "Machine inputs" }), { target: { value: "[1]" } });
    expect(within(form).getByText("The machine inputs must be a JSON object.")).toBeTruthy();
    fireEvent.change(within(form).getByRole("textbox", { name: "Machine inputs" }), { target: { value: '{ "cores": 8 }' } });
    fireEvent.click(within(form).getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.servers.at(-1)!.workspace).toEqual({ kind: "provider", provider: "sandbox-checkout", inputs: { base: "origin/{head_ref}" }, machine: { provider: "sandbox", inputs: { cores: 8 } } });
  });

  it("gives an environment that makes its own machine that machine provider, and shows a saved machine again", async () => {
    const lab = { id: "lab", name: "Lab", kind: "command" as const, enabled: true, sep: "#" as const, pattern: "^https://d/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://d/{repo}/pull/{number}", commands: { view: "sh lab.sh" } };
    const slot = await section("servers", { getConfig: () => ({ config: config({ servers: [...config().servers, lab] }) }) });
    fireEvent.click(await slot.findByRole("button", { name: "Edit Lab" }));
    const form = slot.container.querySelector<HTMLElement>("[data-server-form]")!;
    fireEvent.change(within(form).getByRole("combobox", { name: "Review workspace" }), { target: { value: "provider" } });
    await waitFor(() => expect(form.querySelector("datalist#shuttle-environment-providers option[value='sandbox-full']")).not.toBeNull());
    fireEvent.change(within(form).getByRole("combobox", { name: "Environment provider" }), { target: { value: "sandbox-full" } });
    expect((within(form).getByRole("combobox", { name: "Review machine" }) as HTMLSelectElement).value).toBe("new");
    expect((within(form).getByRole("combobox", { name: "Machine provider" }) as HTMLInputElement).value).toBe("sandbox");
    expect(within(form).getByText("Sandbox with checkout makes a new machine for each review with sandbox.")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    const workspace = saved(slot)[0]!.servers.at(-1)!.workspace;
    expect(workspace).toEqual({ kind: "provider", provider: "sandbox-full", inputs: {}, machine: { provider: "sandbox", inputs: {} } });

    unmountAll();
    const again = await section("servers", { getConfig: () => ({ config: config({ servers: [...config().servers, { ...lab, workspace: workspace! }] }) }) });
    fireEvent.click(await again.findByRole("button", { name: "Edit Lab" }));
    const reopened = again.container.querySelector<HTMLElement>("[data-server-form]")!;
    expect((within(reopened).getByRole("combobox", { name: "Review machine" }) as HTMLSelectElement).value).toBe("new");
    expect((within(reopened).getByRole("combobox", { name: "Machine provider" }) as HTMLInputElement).value).toBe("sandbox");
    expect((within(reopened).getByRole("textbox", { name: "Machine inputs" }) as HTMLTextAreaElement).value).toBe("{}");
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
    fireEvent.change(slot.getByRole("textbox", { name: "Only these repositories" }), { target: { value: "acme/app, get-bb/*" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Auto reviews a day" }), { target: { value: "3" } });
    fireEvent.change(slot.getByRole("combobox", { name: "Auto review preset" }), { target: { value: "quick" } });
    const bots = slot.getByRole("textbox", { name: "Bots an agent still hears from" }) as HTMLInputElement;
    expect(bots.value).toBe("");
    fireEvent.change(bots, { target: { value: "review-bot, *-scanner" } });
    fireEvent.click(slot.getByRole("checkbox", { name: /Ignore bots/u }));
    expect(bots.disabled).toBe(true);
    fireEvent.click(slot.getByRole("checkbox", { name: /A thread that links one of your PRs becomes its agent/u }));
    fireEvent.click(slot.getByRole("button", { name: "Save automations" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    const next = saved(slot)[0]!;
    expect(next.autoReview).toMatchObject({ when: ["requested", "mentioned"], repos: ["acme/app", "get-bb/*"], maxPerDay: 3, preset: "quick" });
    expect(next.watch).toMatchObject({ ignoreBots: false, allowBots: ["review-bot", "*-scanner"], autoWatch: false });
    expect(next.presets).toEqual(config().presets);
  });

  it("saves how many auto reviews run at once, when a PR is too idle, and the PRs auto review never starts on", async () => {
    const slot = await section("automations");
    const running = await slot.findByRole("spinbutton", { name: "Auto reviews running at once" }) as HTMLInputElement;
    const idle = slot.getByRole("spinbutton", { name: "Days a PR may be idle" }) as HTMLInputElement;
    expect([running.value, idle.value]).toEqual(["5", "14"]);
    fireEvent.change(running, { target: { value: "2" } });
    fireEvent.change(idle, { target: { value: "12" } });
    fireEvent.change(slot.getByRole("textbox", { name: "PRs auto review never starts on" }), { target: { value: "github:acme/app#12\n\ngithub:acme/app#40 " } });
    fireEvent.click(slot.getByRole("button", { name: "Save automations" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.autoReview).toMatchObject({ maxRunning: 2, idleDays: 12, skipPrs: ["github:acme/app#12", "github:acme/app#40"] });
  });

  it("saves the checks an agent never gets, the phrases that let a bot through and whether approvals wait", async () => {
    const slot = await section("automations");
    const checks = (await slot.findByRole("textbox", { name: "Checks an agent never gets" })) as HTMLTextAreaElement;
    fireEvent.change(checks, { target: { value: "Threads resolved\n\n  approvals  \n" } });
    const phrases = slot.getByRole("textbox", { name: "Phrases that let a bot through" }) as HTMLTextAreaElement;
    fireEvent.change(phrases, { target: { value: "merge-queue*: failed, removed from the queue,\n\npreview-bot:ready" } });
    fireEvent.click(slot.getByRole("checkbox", { name: /Hold approvals and review summaries/u }));
    fireEvent.click(slot.getByRole("button", { name: "Save automations" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.watch).toMatchObject({
      ignoreChecks: ["Threads resolved", "approvals"],
      botPhrases: [{ bot: "merge-queue*", phrases: ["failed", "removed from the queue"] }, { bot: "preview-bot", phrases: ["ready"] }],
      quietReviews: false,
    });
    fireEvent.click(slot.getByRole("checkbox", { name: /Also send failed checks on the head/u }));
    expect(checks.disabled).toBe(true);
    fireEvent.click(slot.getByRole("checkbox", { name: /Ignore bots/u }));
    expect(phrases.disabled).toBe(true);
  });

  it("turns on auto post's shadow mode for a repository, with its guidelines, held paths and bar", async () => {
    const slot = await section("automations");
    await slot.findByText("Auto post");
    expect(slot.getByText("Off everywhere. Add a repository to start shadow mode there.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Add repository" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Repository 1" }), { target: { value: " Shopify/terraform-the-cloud " } });
    expect((slot.getByRole("combobox", { name: "Mode for repository 1" }) as HTMLSelectElement).value).toBe("shadow");
    fireEvent.change(slot.getByRole("textbox", { name: "Guidelines for repository 1" }), { target: { value: "Actuator plans are the source of truth." } });
    fireEvent.change(slot.getByRole("textbox", { name: "Held paths for repository 1" }), { target: { value: "terraform/*/iam/*, *.sql" } });
    fireEvent.click(slot.getByRole("button", { name: "Add repository" }));
    fireEvent.change(slot.getByRole("combobox", { name: "Lowest severity that can post" }), { target: { value: "high" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Lowest verifier score that the finding holds" }), { target: { value: "0.8" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Target precision" }), { target: { value: "0.95" } });
    expect(slot.getByText("about 1 in 20 auto-posted findings you would not have posted")).toBeTruthy();
    fireEvent.change(slot.getByRole("textbox", { name: "Verifier command" }), { target: { value: "my-verifier --json" } });
    fireEvent.click(slot.getByRole("button", { name: "Use the default (Kimi K3 through pi)" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Allowed authors for repository 1" }), { target: { value: "terraform-actuator, aquifer-*" } });
    const concerns = slot.container.querySelector("[data-concern-holds]") as HTMLElement;
    fireEvent.click(within(concerns).getAllByRole("checkbox", { name: /CI, approvals, conflicts or merge state/u })[1]!);
    fireEvent.click(within(concerns).getAllByRole("checkbox", { name: /A design or behaviour point/u })[0]!);
    fireEvent.change(slot.getByRole("spinbutton", { name: "Largest PR an approval may cover" }), { target: { value: "120" } });
    fireEvent.change(slot.getByRole("combobox", { name: "Highest finding severity an approval may carry" }), { target: { value: "nit" } });
    fireEvent.change(slot.getByRole("combobox", { name: "Checks an approval needs" }), { target: { value: "not_failed" } });
    fireEvent.click(slot.getByRole("button", { name: "Save automations" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.autoPost).toMatchObject({
      holdConcerns: { comment: ["description", "scope", "design", "other"], approve: ["description", "scope", "unverified", "other"] },
      approvals: { maxLines: 120, maxSeverity: "nit", checks: "not_failed", target: 0.98 },
      repos: [{ repo: "Shopify/terraform-the-cloud", mode: "shadow", guidelines: "Actuator plans are the source of truth.", holdPaths: ["terraform/*/iam/*", "*.sql"], allowAuthors: ["terraform-actuator", "aquifer-*"] }],
      minSeverity: "high", targetPrecision: 0.95, floors: { holds: 0.8, worth: 0.7 }, verifier: DEFAULT_VERIFIER_COMMAND,
    });
  }, 20_000);

  it("keeps path lists you did not edit exactly, even globs with spaces and commas, and splits edited ones on commas and lines", async () => {
    const tuned = config();
    tuned.autoPost = {
      ...tuned.autoPost,
      repos: [{ repo: "acme/app", mode: "shadow", approve: "shadow", guidelines: "", holdPaths: ["docs/file,name.md"], allowAuthors: [], approvePaths: ["docs/Release Notes.md", "src/*"], disclosure: "" }],
    };
    const slot = await section("automations", { getConfig: () => ({ config: tuned }) });
    await slot.findByText("Auto post");
    fireEvent.change(slot.getByRole("textbox", { name: "Allowed authors for repository 1" }), { target: { value: "deploy-bot,\nrelease bot" } });
    fireEvent.click(slot.getByRole("button", { name: "Save automations" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.autoPost.repos[0]).toMatchObject({ holdPaths: ["docs/file,name.md"], approvePaths: ["docs/Release Notes.md", "src/*"], allowAuthors: ["deploy-bot", "release bot"] });
  });

  it("offers the four auto post modes, saves the posting fields and keeps the ones it does not show", async () => {
    const tuned = config();
    tuned.autoPost = {
      ...tuned.autoPost, verifierTimeoutSeconds: 333, maxLines: 1234, targetPrecision: 0.93,
      repos: [{ repo: "acme/app", mode: "shadow", approve: "shadow", guidelines: "Keep it boring.", holdPaths: ["db/*"], allowAuthors: ["deploy-bot"], approvePaths: [], disclosure: "" }],
    };
    const slot = await section("automations", { getConfig: () => ({ config: tuned }) });
    await slot.findByText("Auto post");
    const mode = slot.getByRole("combobox", { name: "Mode for repository 1" }) as HTMLSelectElement;
    expect([...mode.options].map((option) => [option.value, option.textContent])).toEqual([
      ["off", "Off"], ["shadow", "Shadow: decide, never post"], ["countdown", "Countdown: post after a delay unless you stop it"], ["auto", "Auto: post at once"],
    ]);
    expect((slot.getByRole("combobox", { name: "Approvals mode for repository 1" }) as HTMLSelectElement).value).toBe("shadow");
    expect(slot.container.querySelector("[data-approve-paths-missing]")).toBeNull();
    expect(slot.container.querySelector("[data-auto-post-record]")).toBeNull();
    expect((slot.getByRole("textbox", { name: "Footer for repository 1" }) as HTMLTextAreaElement).placeholder).toContain("Shuttle posted this review");

    fireEvent.change(mode, { target: { value: "countdown" } });
    fireEvent.change(slot.getByRole("combobox", { name: "Approvals mode for repository 1" }), { target: { value: "auto" } });
    expect(slot.getByText("Approvals never post until you list the paths they may cover.")).toBeTruthy();
    fireEvent.change(slot.getByRole("textbox", { name: "Approval paths for repository 1" }), { target: { value: "docs/*, locales/*.yml" } });
    expect(slot.container.querySelector("[data-approve-paths-missing]")).toBeNull();
    fireEvent.change(slot.getByRole("textbox", { name: "Footer for repository 1" }), { target: { value: "_Posted by Shuttle for acme._" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Minutes a comment review waits" }), { target: { value: "45" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Minutes an approval waits" }), { target: { value: "180" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Reviews Shuttle posts a day in a repository" }), { target: { value: "3" } });
    fireEvent.change(slot.getByRole("textbox", { name: "Footer of posted reviews" }), { target: { value: "_Shuttle wrote this._" } });
    expect(slot.container.querySelector("[data-disclosure-preview]")!.textContent).toContain("Shuttle wrote this.");
    expect((slot.getByRole("textbox", { name: "Footer for repository 1" }) as HTMLTextAreaElement).placeholder).toBe("_Shuttle wrote this._");
    fireEvent.change(slot.getByRole("spinbutton", { name: "Lowest verifier blocking score that holds an approval" }), { target: { value: "0.35" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Posted findings the breaker looks at" }), { target: { value: "30" } });
    fireEvent.change(slot.getByRole("spinbutton", { name: "Marked findings that stop posting" }), { target: { value: "1" } });
    fireEvent.click(slot.getByRole("button", { name: "Save automations" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    const next = saved(slot)[0]!.autoPost;
    expect(next).toMatchObject({
      countdownMinutes: 45, maxPerDay: 3, disclosure: "_Shuttle wrote this._", breaker: { window: 30, maxMarked: 1 },
      floors: { holds: 0.7, worth: 0.7, blocking: 0.35 }, approvals: { ...tuned.autoPost.approvals, countdownMinutes: 180 },
      verifierTimeoutSeconds: 333, maxLines: 1234, targetPrecision: 0.93, holdConcerns: tuned.autoPost.holdConcerns, verifier: tuned.autoPost.verifier,
    });
    expect(next.repos).toEqual([{
      repo: "acme/app", mode: "countdown", approve: "auto", guidelines: "Keep it boring.", holdPaths: ["db/*"], allowAuthors: ["deploy-bot"],
      approvePaths: ["docs/*", "locales/*.yml"], disclosure: "_Posted by Shuttle for acme._",
    }]);
  }, 20_000);

  it("warns that the record has not proven the target when a mode posts, and still saves", async () => {
    const tuned = config();
    tuned.autoPost = { ...tuned.autoPost, repos: [{ repo: "acme/app", mode: "countdown", approve: "countdown", guidelines: "", holdPaths: [], allowAuthors: [], approvePaths: ["docs/*"], disclosure: "" }] };
    const record = autoPostInsights({
      repos: [shadowRepo({
        repo: "acme/app", mode: "countdown", approveMode: "countdown",
        findings: { agreed: 9, against: 1, precision: 0.9, lowerBound: 0.596, needed: 41 },
        approvals: { agreed: 50, against: 0, precision: 1, lowerBound: 0.99, needed: 0 },
        trips: [{ kind: "comment", reason: "you marked 3 of the last 20 comments it posted", at: Date.now() - 3_600_000 }],
      })],
    });
    const slot = await section("automations", { getConfig: () => ({ config: tuned }), autoPostInsights: ({ range }) => ({ ...record, range }), resumeAutoPost: () => ({ cleared: 1 }) });
    const comments = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-auto-post-record='comments']") ?? Promise.reject(new Error("no record")));
    await waitFor(() => expect(comments.textContent).toContain("precision 90% (9 of 10 decided findings), proven at least 60% against a 90% target; 41 more agreeing findings in a row would prove it."));
    expect(comments.querySelector("[data-auto-post-unproven='comments']")!.textContent).toContain("The record has not proven the 90% target for comments here. Shuttle will still post them");
    const approvals = slot.container.querySelector<HTMLElement>("[data-auto-post-record='approvals']")!;
    expect(approvals.textContent).toContain("proven at least 99% against a 98% target.");
    expect(approvals.querySelector("[data-auto-post-unproven]")).toBeNull();
    expect(callsTo(slot, "autoPostInsights")).toEqual([{ range: "90d" }]);

    const trip = slot.container.querySelector<HTMLElement>("[data-auto-post-trip='comment']")!;
    expect(trip.textContent).toContain("Posting comments stopped: you marked 3 of the last 20 comments it posted");
    fireEvent.click(within(trip).getByRole("button", { name: "Resume posting comments in acme/app" }));
    await waitFor(() => expect(callsTo(slot, "resumeAutoPost")).toEqual([{ repo: "acme/app", kind: "comment" }]));

    fireEvent.change(slot.getByRole("combobox", { name: "Approvals mode for repository 1" }), { target: { value: "auto" } });
    expect((slot.getByRole("button", { name: "Save automations" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Save automations" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]!.autoPost.repos[0]).toMatchObject({ mode: "countdown", approve: "auto", approvePaths: ["docs/*"] });
  }, 20_000);

  it("names agents, not watching, in the automations", async () => {
    const slot = await section("automations");
    await slot.findByText("Agents");
    // There is one thing an agent does, so there is nothing to choose here.
    expect(slot.queryByRole("combobox", { name: "What a new agent does" })).toBeNull();
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
