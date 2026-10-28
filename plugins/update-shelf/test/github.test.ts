import { describe, expect, it } from "vitest";
import {
  NotFoundError,
  TransportUnavailableError,
  createGitHub,
  firstAvailable,
  ghTransport,
  parseGitHubRepo,
  type Exec,
} from "../src/github";

describe("parseGitHubRepo", () => {
  it("reads every form bb records a git source in", () => {
    const expected = { owner: "acme", name: "bb-plugins" };
    expect(parseGitHubRepo("git:https://github.com/acme/bb-plugins.git@semver:genui/:>=0.1.0 <1.0.0")).toEqual(expected);
    expect(parseGitHubRepo("https://github.com/acme/bb-plugins.git@genui/v0.2.6 (d86c13657608)")).toEqual(expected);
    expect(parseGitHubRepo("https://github.com/kalindudc/burn@HEAD (a713743ef433)")).toEqual({ owner: "kalindudc", name: "burn" });
    expect(parseGitHubRepo("git@github.com:acme/notes.git")).toEqual({ owner: "acme", name: "notes" });
    expect(parseGitHubRepo("https://github.com/acme/notes")).toEqual({ owner: "acme", name: "notes" });
  });

  it("reads the other git URL forms", () => {
    const expected = { owner: "acme", name: "notes" };
    expect(parseGitHubRepo("ssh://git@github.com/acme/notes.git")).toEqual(expected);
    expect(parseGitHubRepo("git://github.com/acme/notes.git")).toEqual(expected);
    expect(parseGitHubRepo("git:github.com/acme/notes@main")).toEqual(expected);
    expect(parseGitHubRepo("https://GitHub.com/acme/notes")).toEqual(expected);
    expect(parseGitHubRepo("https://user@github.com/acme/notes.git")).toEqual(expected);
  });

  it("ignores sources that are not on GitHub", () => {
    expect(parseGitHubRepo("npm:bb-plugin-notes@1.0.0")).toBeNull();
    expect(parseGitHubRepo("git:https://gitlab.com/acme/notes.git@main")).toBeNull();
  });

  it("only takes github.com itself as the host, not a host or path that contains it", () => {
    // Review finding: the pattern matched github.com anywhere, so these read as github.com/acme/notes and the
    // changelog came from an unrelated public repository.
    expect(parseGitHubRepo("https://notgithub.com/acme/notes.git")).toBeNull();
    expect(parseGitHubRepo("git@internal-github.com:acme/notes.git")).toBeNull();
    expect(parseGitHubRepo("https://github.com.evil.example/acme/notes")).toBeNull();
    expect(parseGitHubRepo("https://git.example.com/github.com/acme/notes.git")).toBeNull();
    expect(parseGitHubRepo("git:https://git.example.com/mirrors/github.com/acme/notes.git@v1.0.0 (0123456789ab)")).toBeNull();
  });

  it("refuses a path that is not an owner and a repository", () => {
    expect(parseGitHubRepo("https://github.com/acme")).toBeNull();
    expect(parseGitHubRepo("https://github.com/-acme/notes")).toBeNull();
    expect(parseGitHubRepo("not a url")).toBeNull();
  });
});

const exec = (result: Awaited<ReturnType<Exec>> | Error): Exec => async () => {
  if (result instanceof Error) throw result;
  return result;
};

describe("ghTransport", () => {
  it("returns what gh printed", async () => {
    await expect(ghTransport(exec({ code: 0, stdout: "body", stderr: "" }))("repos/a/b", "raw")).resolves.toBe("body");
  });

  it("reports a missing file as not found", async () => {
    const transport = ghTransport(exec({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }));
    await expect(transport("repos/a/b/contents/CHANGELOG.md", "raw")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("steps aside when gh is missing or signed out", async () => {
    const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    await expect(ghTransport(exec(missing))("repos/a/b", "json")).rejects.toBeInstanceOf(TransportUnavailableError);
    const signedOut = exec({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" });
    await expect(ghTransport(signedOut)("repos/a/b", "json")).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it("keeps other failures, so a rate limit is not mistaken for a missing gh", async () => {
    const limited = ghTransport(exec({ code: 1, stdout: "", stderr: "gh: API rate limit exceeded (HTTP 403)" }));
    await expect(limited("repos/a/b", "json")).rejects.toThrow(/rate limit/u);
  });
});

describe("firstAvailable", () => {
  it("moves to the next transport only when one cannot be used", async () => {
    const unavailable = async () => {
      throw new TransportUnavailableError("no gh");
    };
    await expect(firstAvailable(unavailable, async () => "public")("repos/a/b", "json")).resolves.toBe("public");
    const notFound = async () => {
      throw new NotFoundError("404");
    };
    await expect(firstAvailable(notFound, async () => "public")("repos/a/b", "json")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("createGitHub", () => {
  it("asks for the paths GitHub's REST API serves and reads their answers", async () => {
    const asked: string[] = [];
    const github = createGitHub(async (path) => {
      asked.push(path);
      if (path.includes("/contents/")) throw new NotFoundError("404");
      if (path.startsWith("repos/a/b/commits/")) return JSON.stringify({ commit: { committer: { date: "2026-10-20T10:00:00Z" } } });
      return JSON.stringify([{ sha: "c1", html_url: "https://github.com/a/b/commit/c1", commit: { message: "Fix it\n\nBody" } }]);
    });
    const repo = { owner: "a", name: "b" };
    await expect(github.file(repo, "plugins/x/CHANGELOG.md", "head")).resolves.toBeNull();
    await expect(github.commitDate(repo, "base")).resolves.toBe("2026-10-20T10:00:00Z");
    await expect(github.commits(repo, { head: "head", since: "2026-10-20T10:00:00Z", path: "plugins/x" })).resolves.toEqual([
      { sha: "c1", title: "Fix it", url: "https://github.com/a/b/commit/c1" },
    ]);
    await github.commits(repo, { head: "head", since: "2026-10-20T10:00:00Z", path: null });
    expect(asked).toEqual([
      "repos/a/b/contents/plugins/x/CHANGELOG.md?ref=head",
      "repos/a/b/commits/base",
      "repos/a/b/commits?sha=head&since=2026-10-20T10%3A00%3A00Z&per_page=100&path=plugins%2Fx",
      "repos/a/b/commits?sha=head&since=2026-10-20T10%3A00%3A00Z&per_page=100",
    ]);
  });
});
