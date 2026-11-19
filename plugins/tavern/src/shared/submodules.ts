import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

export function submoduleConfigReads(root: string) {
  const file = join(root, ".gitmodules"), stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error("Tavern cannot check submodules from a non-regular .gitmodules file.");
  return [
    { source: "HEAD:.gitmodules", blob: true },
    ...(stat ? [{ source: file, blob: false }] : []),
  ].map(({ source, blob }) => ({ blob, args: ["config", "--no-includes", "--null", ...(blob ? ["--blob=" + source] : ["--file", source]), "--get-regexp", "^submodule\\..*\\.path$"] }));
}

export function missingSubmoduleConfig(blob: boolean, code: number | null | undefined, stderr: string) {
  return code === 1 || blob && code === 128 && stderr.includes("unable to resolve config blob 'HEAD:.gitmodules'");
}

export function populatedSubmodules(root: string, config: string[]): { path: string; root: string }[] {
  const paths = new Set<string>(), checkout = realpathSync(root);
  for (const row of config.flatMap(text => text.split("\0")).filter(Boolean)) {
    const split = row.indexOf("\n"), path = row.slice(split + 1);
    if (split < 0 || !path || isAbsolute(path) || /[\0\r\n\\]/.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))
      throw new Error("Tavern cannot check a submodule with an invalid checkout path.");
    paths.add(path);
  }
  return [...paths].flatMap(path => {
    const nested = join(checkout, path), marker = lstatSync(join(nested, ".git"), { throwIfNoEntry: false });
    if (!marker) return [];
    const real = realpathSync(nested);
    if (real !== nested || !real.startsWith(checkout + sep)) throw new Error("Tavern cannot check a submodule outside the checkout: " + path);
    return [{ path, root: real }];
  });
}
