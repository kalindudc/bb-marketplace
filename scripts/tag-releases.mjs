// Tags every release of this marketplace's plugins, so publishing a version is a version bump on main and nothing else.
//
// bb installs a plugin from the newest `<tagPrefix>vX.Y.Z` tag its range allows and refuses a tag that moves. For each
// entry whose source is a subdirectory of this repository, this walks the first-parent history of the plugin's
// package.json back to its newest tagged version and tags every newer version at the commit that set it. Working from
// history rather than from one push's commits makes each run complete on its own: a push that bumps several plugins, or
// one plugin twice, gets every tag; a cancelled or failed run is caught up by the next one; and a rerun changes nothing.
// The bump commit is also what the changelog check expects: it dates each release from its tag's commit.
//
// `node scripts/tag-releases.mjs` prints the plan; `--push` creates the tags. `.github/workflows/tag-releases.yml`
// runs it on every push to main.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPOSITORY_URL } from "./changelog-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

/** The file at `commit`, or null when it does not exist there. */
function show(cwd, commit, path) {
  try {
    return git(cwd, ["show", `${commit}:${path}`]);
  } catch {
    return null;
  }
}

function parent(cwd, commit) {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^1`]);
  } catch {
    return null;
  }
}

function versionAt(cwd, commit, subdir) {
  const text = show(cwd, commit, `${subdir}/package.json`);
  return text === null ? null : JSON.parse(text).version ?? null;
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The entries at `head` that bb installs from this repository's tags, as `{ id, subdir, tagPrefix }`. */
export function publishedPlugins(cwd, head, repositoryUrl = REPOSITORY_URL) {
  return git(cwd, ["ls-tree", "--name-only", `${head}:entries`])
    .split("\n")
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(show(cwd, head, `entries/${file}`)))
    .filter((entry) => entry.source?.git?.url === repositoryUrl && entry.source.git.subdir && entry.source.git.tagPrefix)
    .map((entry) => ({ id: entry.id, subdir: entry.source.git.subdir, tagPrefix: entry.source.git.tagPrefix }));
}

/** Every tag on `remote` with the commit it points at, peeling annotated tags. */
export function remoteTags(cwd, remote) {
  const tags = new Map();
  for (const line of git(cwd, ["ls-remote", "--tags", remote]).split("\n").filter(Boolean)) {
    const [commit, ref] = line.split("\t");
    const name = ref.slice("refs/tags/".length);
    if (name.endsWith("^{}")) tags.set(name.slice(0, -3), commit);
    else if (!tags.has(name)) tags.set(name, commit);
  }
  return tags;
}

/** What would make the release's metadata disagree with its tag; none of these stop the tag. */
function releaseWarnings(cwd, commit, subdir, version) {
  const warnings = [];
  const lock = show(cwd, commit, `${subdir}/package-lock.json`);
  if (lock !== null) {
    const parsed = JSON.parse(lock);
    if (parsed.version !== version || parsed.packages?.[""]?.version !== version) {
      warnings.push(`${subdir}/package-lock.json is not at ${version}`);
    }
  }
  const date = git(cwd, ["log", "-1", "--format=%ad", "--date=short", commit]);
  const heading = show(cwd, commit, `${subdir}/CHANGELOG.md`)
    ?.match(new RegExp(`^## ${version.replaceAll(".", "\\.")} \\((\\d{4}-\\d{2}-\\d{2})\\)$`, "mu"));
  if (!heading) warnings.push(`${subdir}/CHANGELOG.md has no "## ${version} (${date})" section`);
  else if (heading[1] !== date) {
    warnings.push(`${subdir}/CHANGELOG.md dates ${version} ${heading[1]}, but its commit is from ${date}; the changelog check will ask for ${date}`);
  }
  return warnings;
}

/** One plugin's untagged releases, oldest first, with what to warn about and what stops a release. */
export function planPlugin(cwd, head, plugin, tags) {
  const tagged = (version) => tags.has(`${plugin.tagPrefix}v${version}`);
  const newest = [...tags.keys()]
    .filter((tag) => tag.startsWith(`${plugin.tagPrefix}v`))
    .map((tag) => tag.slice(plugin.tagPrefix.length + 1))
    .filter((version) => VERSION.test(version))
    .sort(compareVersions)
    .at(-1) ?? null;
  const releases = [];
  const warnings = [];
  const errors = [];
  // Releases are the versions history climbed through to reach the current one; anything at or above a later version
  // was reverted or skipped, and tagging it would publish what main left behind.
  let ceiling = null;
  const commits = git(cwd, ["log", "--first-parent", "--format=%H", head, "--", `${plugin.subdir}/package.json`])
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const version = versionAt(cwd, commit, plugin.subdir);
    const before = parent(cwd, commit);
    if (version === null || version === (before === null ? null : versionAt(cwd, before, plugin.subdir))) continue;
    if (!VERSION.test(version)) {
      errors.push(`version "${version}" set in ${commit.slice(0, 9)} is not X.Y.Z`);
      continue;
    }
    // Every older version was released before this one.
    if (tagged(version)) break;
    if (ceiling !== null && compareVersions(version, ceiling) >= 0) {
      if (version !== ceiling) warnings.push(`${version}, set in ${commit.slice(0, 9)}, was left behind by ${ceiling}; not tagged`);
      continue;
    }
    ceiling = version;
    if (newest !== null && compareVersions(version, newest) <= 0) {
      warnings.push(`${version}, set in ${commit.slice(0, 9)}, is not newer than ${plugin.tagPrefix}v${newest}; not tagged`);
      continue;
    }
    releases.push({
      id: plugin.id,
      version,
      tag: `${plugin.tagPrefix}v${version}`,
      commit,
      warnings: releaseWarnings(cwd, commit, plugin.subdir, version),
    });
  }
  return { releases: releases.reverse(), warnings, errors };
}

/** Every plugin's plan. A problem in one plugin, even a broken package.json, never stops another. */
export function planReleases(cwd, head, tags, { repositoryUrl = REPOSITORY_URL } = {}) {
  const releases = [];
  const warnings = [];
  const errors = [];
  for (const plugin of publishedPlugins(cwd, head, repositoryUrl)) {
    try {
      const plan = planPlugin(cwd, head, plugin, tags);
      releases.push(...plan.releases);
      warnings.push(...plan.warnings.map((text) => `${plugin.id}: ${text}`));
      errors.push(...plan.errors.map((text) => `${plugin.id}: ${text}`));
    } catch (error) {
      errors.push(`${plugin.id}: ${error.message.trim()}`);
    }
  }
  for (const release of releases) warnings.push(...release.warnings.map((text) => `${release.tag}: ${text}`));
  return { releases, warnings, errors };
}

/** Pushes each tag on its own, so one refusal leaves the rest; a tag another run already pushed here is fine. */
export function publish(cwd, remote, releases) {
  const created = [];
  const errors = [];
  for (const release of releases) {
    try {
      git(cwd, ["push", "--no-follow-tags", remote, `${release.commit}:refs/tags/${release.tag}`]);
      created.push(release);
    } catch (error) {
      const target = remoteTags(cwd, remote).get(release.tag);
      if (target === release.commit) created.push(release);
      else errors.push(`${release.tag}: ${target ? `already points at ${target}; refusing to move it` : error.stderr?.trim() || error.message}`);
    }
  }
  return { created, errors };
}

export function run({ cwd = root, remote = "origin", head = "HEAD", push = false, repositoryUrl = REPOSITORY_URL } = {}) {
  // A shallow history ends at a commit with no parent, which would read as every plugin's first release.
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]) === "true") {
    return { releases: [], created: [], warnings: [], errors: ["the clone is shallow; fetch the full history (fetch-depth: 0)"] };
  }
  const commit = git(cwd, ["rev-parse", "--verify", `${head}^{commit}`]);
  const plan = planReleases(cwd, commit, remoteTags(cwd, remote), { repositoryUrl });
  if (!push) return { ...plan, created: [] };
  const result = publish(cwd, remote, plan.releases);
  return { ...plan, created: result.created, errors: [...plan.errors, ...result.errors] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const push = args.includes("--push");
  const result = run({ push, remote: option("--remote"), head: option("--head") });
  const actions = process.env.GITHUB_ACTIONS === "true";
  for (const text of result.warnings) console.log(actions ? `::warning::${text}` : `warning: ${text}`);
  for (const text of result.errors) console.log(actions ? `::error::${text}` : `error: ${text}`);
  const lines = push
    ? result.created.map((release) => `Tagged ${release.tag} at ${release.commit}`)
    : result.releases.map((release) => `Would tag ${release.tag} at ${release.commit}`);
  console.log(lines.length > 0 ? lines.join("\n") : "Every release is tagged.");
  if (process.env.GITHUB_STEP_SUMMARY && push) {
    const summary = result.created.map((release) => `- \`${release.tag}\` at ${release.commit}`).join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release tags\n\n${summary || "Every release was already tagged."}\n`);
  }
  if (result.errors.length > 0) process.exit(1);
}
