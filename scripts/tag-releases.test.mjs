import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { publish, remoteTags, run } from "./tag-releases.mjs";

const URL = "https://example.test/marketplace.git";
const scratch = mkdtempSync(join(tmpdir(), "tag-releases-"));

// The user's global git config can sign commits or run hooks on push; these repositories ignore it.
const saved = {};
before(() => {
  const config = join(scratch, "gitconfig");
  writeFileSync(config, "");
  const env = {
    GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test",
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

let count = 0;
function repository() {
  const base = join(scratch, `repo-${count++}`);
  const origin = join(base, "origin.git");
  const work = join(base, "work");
  const git = (cwd, args, env = {}) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  mkdirSync(work, { recursive: true });
  git(base, ["init", "--quiet", "--bare", "-b", "main", origin]);
  git(work, ["init", "--quiet", "-b", "main"]);
  git(work, ["remote", "add", "origin", origin]);
  const write = (path, content) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  };
  const repo = {
    origin,
    work,
    entry(id) {
      write(`entries/${id}.json`, { id, source: { git: { url: URL, subdir: `plugins/${id}`, range: ">=0.1.0 <1.0.0", tagPrefix: `${id}/` } } });
    },
    release(id, version, date, { lock = version, changelog = true } = {}) {
      write(`plugins/${id}/package.json`, { name: `bb-plugin-${id}`, version });
      write(`plugins/${id}/package-lock.json`, { name: `bb-plugin-${id}`, version: lock, packages: { "": { version: lock } } });
      write(`plugins/${id}/CHANGELOG.md`, changelog ? `# Changelog\n\n## ${version} (${date})\n\n### Fixed\n\n- A fix.\n` : "# Changelog\n");
    },
    write,
    commit(message, date) {
      git(work, ["add", "--all"]);
      const stamp = `${date}T12:00:00-05:00`;
      git(work, ["commit", "--quiet", "--allow-empty", "-m", message], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
      return git(work, ["rev-parse", "HEAD"]);
    },
    push() {
      git(work, ["push", "--quiet", "origin", "HEAD:main"]);
    },
    tag(name, commit) {
      git(work, ["push", "--quiet", "origin", `${commit}:refs/tags/${name}`]);
    },
    tags() {
      return Object.fromEntries([...remoteTags(work, "origin")].sort(([a], [b]) => a.localeCompare(b)));
    },
    run(options = {}) {
      return run({ cwd: work, repositoryUrl: URL, push: true, ...options });
    },
  };
  return repo;
}

/** alpha and beta are published from tags; gamma has no entry. All three start released at 0.1.0. */
function marketplace() {
  const repo = repository();
  repo.entry("alpha");
  repo.entry("beta");
  for (const id of ["alpha", "beta", "gamma"]) repo.release(id, "0.1.0", "2026-11-01");
  const first = repo.commit("first releases", "2026-11-01");
  repo.push();
  repo.tag("alpha/v0.1.0", first);
  repo.tag("beta/v0.1.0", first);
  return { repo, first };
}

describe("tag-releases", () => {
  it("tags every bump of every published plugin in one push at the commit that made it", () => {
    const { repo, first } = marketplace();
    repo.release("alpha", "0.1.1", "2026-11-02");
    const alpha1 = repo.commit("alpha 0.1.1", "2026-11-02");
    repo.release("beta", "0.2.0", "2026-11-03");
    repo.write("plugins/alpha/README.md", "unreleased work\n");
    const beta2 = repo.commit("beta 0.2.0 and alpha work", "2026-11-03");
    repo.release("alpha", "0.1.2", "2026-11-04");
    const alpha2 = repo.commit("alpha 0.1.2", "2026-11-04");
    repo.release("gamma", "0.2.0", "2026-11-05");
    repo.commit("gamma 0.2.0", "2026-11-05");
    repo.write("plugins/beta/package.json", { name: "bb-plugin-beta", version: "0.2.0", dependencies: { zod: "^4.0.0" } });
    repo.commit("beta dependency, no release", "2026-11-06");
    repo.push();

    const result = repo.run();

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.created.map((release) => release.tag).sort(), ["alpha/v0.1.1", "alpha/v0.1.2", "beta/v0.2.0"]);
    assert.deepEqual(repo.tags(), {
      "alpha/v0.1.0": first, "alpha/v0.1.1": alpha1, "alpha/v0.1.2": alpha2,
      "beta/v0.1.0": first, "beta/v0.2.0": beta2,
    });
  });

  it("changes nothing when run again", () => {
    const { repo } = marketplace();
    repo.release("alpha", "0.1.1", "2026-11-02");
    repo.commit("alpha 0.1.1", "2026-11-02");
    repo.push();
    repo.run();
    const tags = repo.tags();

    const again = repo.run();

    assert.deepEqual(again.releases, []);
    assert.deepEqual(again.created, []);
    assert.deepEqual(again.errors, []);
    assert.deepEqual(repo.tags(), tags);
  });

  it("catches up releases an earlier run missed, across later pushes", () => {
    const { repo } = marketplace();
    repo.release("alpha", "0.1.1", "2026-11-02");
    const alpha1 = repo.commit("alpha 0.1.1", "2026-11-02");
    repo.push();
    repo.write("notes.md", "unrelated\n");
    repo.commit("unrelated", "2026-11-03");
    repo.release("beta", "0.1.1", "2026-11-04");
    const beta1 = repo.commit("beta 0.1.1", "2026-11-04");
    repo.push();

    repo.run();

    assert.equal(repo.tags()["alpha/v0.1.1"], alpha1);
    assert.equal(repo.tags()["beta/v0.1.1"], beta1);
  });

  it("only plans without --push", () => {
    const { repo } = marketplace();
    repo.release("alpha", "0.1.1", "2026-11-02");
    const alpha1 = repo.commit("alpha 0.1.1", "2026-11-02");
    repo.push();

    const plan = repo.run({ push: false });

    assert.deepEqual(plan.releases.map(({ tag, commit }) => ({ tag, commit })), [{ tag: "alpha/v0.1.1", commit: alpha1 }]);
    assert.equal(repo.tags()["alpha/v0.1.1"], undefined);
  });

  it("tags a newly listed plugin's first release", () => {
    const { repo } = marketplace();
    repo.entry("delta");
    repo.release("delta", "0.1.0", "2026-11-02");
    const delta = repo.commit("add delta", "2026-11-02");
    repo.push();

    const result = repo.run();

    assert.deepEqual(result.errors, []);
    assert.equal(repo.tags()["delta/v0.1.0"], delta);
  });

  it("does not tag a version that is not newer than the newest tag, or a revert to a tagged one", () => {
    const { repo } = marketplace();
    repo.release("alpha", "0.2.0", "2026-11-02");
    repo.commit("alpha 0.2.0", "2026-11-02");
    repo.release("beta", "0.1.1", "2026-11-02");
    repo.commit("beta 0.1.1", "2026-11-02");
    repo.push();
    repo.run();
    repo.release("alpha", "0.1.5", "2026-11-03");
    repo.commit("alpha goes back", "2026-11-03");
    repo.release("beta", "0.1.2", "2026-11-03");
    repo.commit("beta 0.1.2", "2026-11-03");
    repo.release("beta", "0.1.1", "2026-11-04");
    repo.commit("revert beta 0.1.2", "2026-11-04");
    repo.push();
    const tags = repo.tags();

    const result = repo.run();

    assert.deepEqual(result.created, []);
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^alpha: 0\.1\.5, set in \w+, is not newer than alpha\/v0\.2\.0; not tagged$/u);
    assert.deepEqual(repo.tags(), tags);
  });

  it("does not publish a bump that a later commit in the same push reverted", () => {
    const { repo } = marketplace();
    repo.release("alpha", "0.1.1", "2026-11-02");
    repo.commit("alpha 0.1.1", "2026-11-02");
    repo.release("alpha", "0.1.2", "2026-11-03");
    repo.commit("alpha 0.1.2", "2026-11-03");
    repo.release("alpha", "0.1.1", "2026-11-04");
    const revert = repo.commit("revert alpha 0.1.2", "2026-11-04");
    repo.push();

    const result = repo.run();

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.created.map(({ tag, commit }) => ({ tag, commit })), [{ tag: "alpha/v0.1.1", commit: revert }]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^alpha: 0\.1\.2, set in \w+, was left behind by 0\.1\.1; not tagged$/u);
    assert.equal(repo.tags()["alpha/v0.1.2"], undefined);
  });

  it("reports a bad version for that plugin and still tags the others", () => {
    const { repo } = marketplace();
    repo.write("plugins/alpha/package.json", { name: "bb-plugin-alpha", version: "0.2" });
    repo.release("beta", "0.1.1", "2026-11-02");
    const beta1 = repo.commit("bad alpha, good beta", "2026-11-02");
    repo.push();

    const result = repo.run();

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^alpha: version "0\.2" set in \w+ is not X\.Y\.Z$/u);
    assert.equal(repo.tags()["beta/v0.1.1"], beta1);
  });

  it("keeps tagging other plugins when one plugin's package.json cannot be read", () => {
    const { repo } = marketplace();
    repo.write("plugins/alpha/package.json", "{ not json");
    repo.release("beta", "0.1.1", "2026-11-02");
    const beta1 = repo.commit("broken alpha, good beta", "2026-11-02");
    repo.push();

    const result = repo.run();

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^alpha: /u);
    assert.equal(repo.tags()["beta/v0.1.1"], beta1);
  });

  it("warns, and still tags, when the lockfile or changelog does not match the release", () => {
    const { repo } = marketplace();
    repo.release("alpha", "0.1.1", "2026-11-02", { lock: "0.1.0" });
    repo.release("beta", "0.1.1", "2026-11-02", { changelog: false });
    repo.commit("two loose releases", "2026-11-02");
    repo.push();

    const result = repo.run();

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.created.map((release) => release.tag).sort(), ["alpha/v0.1.1", "beta/v0.1.1"]);
    assert.deepEqual(result.warnings.sort(), [
      "alpha/v0.1.1: plugins/alpha/package-lock.json is not at 0.1.1",
      'beta/v0.1.1: plugins/beta/CHANGELOG.md has no "## 0.1.1 (2026-11-02)" section',
    ]);
  });

  it("warns when the changelog dates a release differently from its commit", () => {
    const { repo } = marketplace();
    repo.release("alpha", "0.1.1", "2026-11-01");
    repo.commit("alpha 0.1.1", "2026-11-02");
    repo.push();

    const result = repo.run();

    assert.equal(repo.tags()["alpha/v0.1.1"] !== undefined, true);
    assert.deepEqual(result.warnings, [
      "alpha/v0.1.1: plugins/alpha/CHANGELOG.md dates 0.1.1 2026-11-01, but its commit is from 2026-11-02; the changelog check will ask for 2026-11-02",
    ]);
  });

  it("accepts a tag another run already pushed to the same commit, and refuses to move one", () => {
    const { repo, first } = marketplace();
    repo.release("alpha", "0.1.1", "2026-11-02");
    const alpha1 = repo.commit("alpha 0.1.1", "2026-11-02");
    repo.push();
    repo.tag("alpha/v0.1.1", alpha1);
    repo.tag("beta/v0.1.1", first);

    const result = publish(repo.work, "origin", [
      { tag: "alpha/v0.1.1", commit: alpha1 },
      { tag: "beta/v0.1.1", commit: alpha1 },
    ]);

    assert.deepEqual(result.created.map((release) => release.tag), ["alpha/v0.1.1"]);
    assert.deepEqual(result.errors, [`beta/v0.1.1: already points at ${first}; refusing to move it`]);
    assert.equal(repo.tags()["beta/v0.1.1"], first);
  });

  it("refuses a shallow clone, whose oldest commit would look like every plugin's first release", () => {
    const { repo } = marketplace();
    repo.release("alpha", "0.1.1", "2026-11-02");
    repo.commit("alpha 0.1.1", "2026-11-02");
    repo.push();
    const shallow = join(dirname(repo.work), "shallow");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${repo.origin}`, shallow]);

    const result = run({ cwd: shallow, repositoryUrl: URL, push: true });

    assert.deepEqual(result.created, []);
    assert.deepEqual(result.errors, ["the clone is shallow; fetch the full history (fetch-depth: 0)"]);
  });
});
