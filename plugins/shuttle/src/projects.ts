// Which bb project a PR's review thread belongs in: the project whose git remote is the PR's
// repository, else the only project with that repository's name, else the default setting.
import type { ProjectInfo } from "./ports";

/** `git@github.com:Shopify/world.git` and `https://github.com/Shopify/world` both become `shopify/world`. */
export function remotePath(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/u, "").replace(/\/+$/u, "");
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/u.exec(trimmed);
  if (scp) return scp[1]!.toLowerCase();
  try {
    return new URL(trimmed).pathname.replace(/^\/+/u, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function matchProject(repo: string, projects: readonly ProjectInfo[], fallback: string | null): string | null {
  const want = repo.toLowerCase();
  const paths = projects.map((project) => ({ project, path: project.gitRemoteUrl ? remotePath(project.gitRemoteUrl) : null }));
  const exact = paths.find((p) => p.path === want);
  if (exact) return exact.project.id;
  const name = want.split("/").at(-1)!;
  const byName = paths.filter((p) => p.path?.split("/").at(-1) === name);
  if (byName.length === 1) return byName[0]!.project.id;
  if (fallback && projects.some((p) => p.id === fallback)) return fallback;
  return null;
}
