// One classification for every failure that reaches Loom: its kind and scope decide whether a ticket waits, a ticket
// blocks, or the project pauses. Most fixtures are pause reasons real projects hit.
import { describe, expect, it } from "vitest";
import { ForgeContractError, Unavailable, classify, classifyAnswer, isRetiredGeneration, isWorkerStopped, transientOfText } from "../src/failures";
import { LoomError } from "../src/projects";

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("classify", () => {
  it.each([
    "host plugin call cb6707d4-28ec-4bd7-b592-6f9d15ce5799 exceeded its deadline",
    "host plugin worker exited (0)",
    "host plugin loom generation 958cfa03-7186-47e3-9428-ffb4b2bff84f is retired",
    "host plugin loom startup timed out",
    "host plugin transport is unavailable",
    "the project's checkout is busy with another call",
  ])("a host call with no answer has an unknown outcome on the project's machine: %s", (message) => {
    expect(classify(new Error(message))).toMatchObject({ kind: "unknown", scope: "host", known: true });
  });

  it("keeps the unknown outcome when a step wraps the host's error", () => {
    const wrapped = new Unavailable("Reading LANE-1's pull request branch stopped: host plugin call 49806682 exceeded its deadline", { transient: "server" });
    expect(classify(wrapped)).toMatchObject({ kind: "unknown", scope: "host" });
  });

  it("reads the SDK's transport error as no answer", () => {
    expect(classify(coded("Plugin RPC request failed", "transport_error"))).toMatchObject({ kind: "unknown", scope: "host" });
  });

  it("waits for the forge host on a rate limit, with the time it named", () => {
    expect(classify(new Unavailable("gh api graphql failed: HTTP 429", { transient: "rate_limit", retryAfterMs: 60_000 }))).toEqual({ kind: "temporary", scope: "forge", reason: "gh api graphql failed: HTTP 429", known: true, retryAfterMs: 60_000, rateLimited: true });
  });

  it("waits for the forge host when the machine could not reach it", () => {
    expect(classifyAnswer({ message: "gh api graphql failed: error connecting to api.github.com", transient: "network" })).toMatchObject({ kind: "temporary", scope: "forge" });
  });

  it("waits on the ticket for a forge's server error", () => {
    expect(classifyAnswer({ message: "gh api graphql failed: gh: HTTP 502", transient: "server" })).toMatchObject({ kind: "temporary", scope: "ticket", known: true });
    expect(classify(new Unavailable("git fetch from origin failed: fatal: remote error: native upload-pack memory budget exhausted by fetches far behind; retry with backoff", { transient: "server" }))).toMatchObject({ kind: "temporary", scope: "ticket" });
  });

  it("reads the forge's words when the answer carries no transient field", () => {
    expect(classify(new Error("The forge's feedback command failed (exit 1):\nError: 503: upstream connect error or disconnect/reset before headers"))).toMatchObject({ kind: "temporary", scope: "ticket", known: true });
  });

  it.each([
    "gh api graphql failed: To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.",
    "gh pr view failed: HTTP 401: Bad credentials (https://api.github.com/graphql)",
    "git push failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  ])("pauses the project for a sign-in failure, saying what to fix: %s", (message) => {
    const failure = classify(new Unavailable(message));
    expect(failure).toMatchObject({ kind: "lasting", scope: "project", known: true });
    expect(failure.fix).toMatch(/Sign in/u);
  });

  it.each([
    "The forge's feedback command must print a JSON object on its last line: oops",
    'The forge\'s state command printed "maybe", not open, merged or closed.',
    "gh pr view printed no JSON: <html>",
  ])("pauses the project for a forge command that breaks its contract: %s", (message) => {
    const failure = classifyAnswer({ message });
    expect(failure).toMatchObject({ kind: "lasting", scope: "project" });
    expect(failure.fix).toMatch(/forge command/u);
  });

  it("still waits when a broken-looking answer says it is worth waiting out, or its words do", () => {
    const rateLimited = "The forge's open command printed no pull request URL: Error: 429: other changes were still being saved after 30s; retry shortly";
    expect(classifyAnswer({ message: rateLimited, transient: "rate_limit" })).toMatchObject({ kind: "temporary", scope: "forge" });
    expect(classifyAnswer({ message: rateLimited })).toMatchObject({ kind: "temporary", known: true });
  });

  it.each([
    "gh pr edit failed: GraphQL: Cannot change the base branch because the pull request is part of a stack. (updatePullRequest)",
    "git push origin failed: ! [rejected] loom/x -> loom/x (non-fast-forward)",
    "git fetch origin failed: fatal: couldn't find remote ref loom/lane-3",
    "LANE-3's pull request https://gitlab.example/x is not a GitHub pull request URL, so gh cannot read it.",
  ])("blocks the ticket for what waiting does not change: %s", (message) => {
    expect(classify(new Error(message))).toMatchObject({ kind: "lasting", scope: "ticket", known: true });
  });

  it("waits on the checkout for a merge git left unfinished there", () => {
    const message = "Merging OTLP-4 stopped: git merge 5e9fd7d9 failed (128): fatal: You have not concluded your merge (MERGE_HEAD exists).";
    expect(classify(new Error(message))).toMatchObject({ kind: "lasting", scope: "host" });
  });

  it("reads a repo with no checkout on the machine, or a host that does not know a method, as a lasting fault of the machine", () => {
    expect(classify(new LoomError("loom_no_checkout", 'Repo "web" has no checkout on the machine.'))).toMatchObject({ kind: "lasting", scope: "host", known: true });
    expect(classify(coded('unknown host rpc method "fetchTip"', "unknown_method"))).toMatchObject({ kind: "lasting", scope: "host" });
  });

  it("blocks the ticket for an input or output the host contract refuses", () => {
    expect(classify(coded("host rpc output validation failed: Invalid input", "invalid_output"))).toMatchObject({ kind: "lasting", scope: "ticket" });
  });

  it("pauses the project when a forge read's answer breaks the host contract, since the forge's command printed it", () => {
    const failure = classify(new ForgeContractError("prFeedback", "rpc output validation failed", []));
    expect(failure).toMatchObject({ kind: "lasting", scope: "project" });
    expect(failure.fix).toMatch(/forge command/u);
  });

  it("treats anything no rule names as temporary for this ticket, with fewer tries", () => {
    expect(classify(new Error("LANE-16's worker has no worktree, so Loom cannot merge the new commits."))).toMatchObject({ kind: "temporary", scope: "ticket", known: false });
    expect(classify("a string thrown")).toMatchObject({ kind: "temporary", scope: "ticket", known: false, reason: "a string thrown" });
  });
});

describe("isRetiredGeneration", () => {
  it.each([
    "host plugin loom generation 958cfa03-7186-47e3-9428-ffb4b2bff84f is retired",
  ])("recognizes a host generation's retirement: %s", (message) => {
    expect(isRetiredGeneration(new Error(message))).toBe(true);
    expect(isRetiredGeneration(message)).toBe(true);
  });

  it.each([
    "host plugin loom startup timed out",
    "host plugin worker failed to start",
    "host plugin worker exited (0)",
    "host plugin worker exited (1)",
    "Host plugin worker exited unexpectedly",
    "host plugin call x exceeded its deadline",
    "Host is not connected",
    "generation is retired",
    "worker exited (0)",
    "HTTP 502: Bad Gateway",
    null,
    undefined,
    {},
  ])("does not mistake another failure for a retired generation: %s", (error) => {
    expect(isRetiredGeneration(error)).toBe(false);
  });
});

describe("isWorkerStopped", () => {
  it("recognizes only bb's clean worker stop", () => {
    expect(isWorkerStopped(new Error("host plugin worker exited (0)"))).toBe(true);
    expect(isWorkerStopped("host plugin worker exited (0)")).toBe(true);
  });

  it.each([
    "host plugin worker exited (1)",
    "host plugin worker exited (SIGTERM)",
    "Host plugin worker exited unexpectedly",
    "host plugin worker exited (00)",
    "host plugin worker exited (0) unexpectedly",
    "worker exited (0)",
    "host plugin loom generation x is retired",
    null,
    undefined,
    {},
  ])("does not discard another failure: %s", (error) => {
    expect(isWorkerStopped(error)).toBe(false);
  });
});

describe("transientOfText", () => {
  it.each([
    ["gh: HTTP 502", { transient: "server" }],
    ["error: 429: slow down; Retry-After: 90", { transient: "rate_limit", retryAfterMs: 90_000 }],
    ["API rate limit exceeded. HTTP 403", { transient: "rate_limit" }],
    ["could not resolve host: github.com", { transient: "network" }],
    ["connection reset by peer", { transient: "server" }],
    ["HTTP 404: Not Found", null],
    ["fatal: bad object", null],
  ])("%s", (text, expected) => {
    expect(transientOfText(text)).toEqual(expected);
  });
});
