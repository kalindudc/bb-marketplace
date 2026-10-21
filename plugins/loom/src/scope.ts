// The path matcher, the same one autoresearch uses to check a diff against a scope.

const cache = new Map<string, RegExp>();

/** Repo-relative glob to RegExp. `**` spans directories, `*` and `?` do not. A trailing `/` or a bare directory matches everything under it. */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let g = glob.trim().replace(/^\.\//u, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        // "**/" matches zero or more directories; a trailing "**" matches anything.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$+.()|{}[]".includes(c)) re += `\\${c}`;
    else re += c;
  }
  // A pattern without wildcards also matches a directory prefix.
  const hasWildcard = /[*?]/u.test(g);
  const out = new RegExp(hasWildcard ? `^${re}$` : `^${re}(?:/.*)?$`, "u");
  cache.set(glob, out);
  return out;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Files a submit changed outside the ticket's scope, and files under a protected path. */
export function scopeReport(changed: readonly string[], ticketScope: readonly string[], protectedGlobs: readonly string[]): { outside: string[]; protectedHits: string[] } {
  return {
    outside: changed.filter((path) => !matchesAny(path, ticketScope)),
    protectedHits: changed.filter((path) => matchesAny(path, protectedGlobs)),
  };
}
