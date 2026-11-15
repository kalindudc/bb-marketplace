export function normalizeRemote(remote: string): string {
  const value = remote.trim();
  let normalized: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const url = new URL(value);
    normalized = url.hostname.toLowerCase() + (url.port && url.port !== "22" && url.port !== "443" ? ":" + url.port : "") + "/" + url.pathname.replace(/^\/+/, "");
  } else if (/^(?:[^@/]+@)?[^/:]+:/.test(value)) {
    const match = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(value)!;
    normalized = match[1].toLowerCase() + "/" + match[2];
  } else {
    const clean = value.replace(/^[^@/]+@/, "");
    const slash = clean.indexOf("/");
    normalized = slash < 0 ? clean.toLowerCase() : clean.slice(0, slash).toLowerCase() + clean.slice(slash);
  }
  return normalized.replace(/\.git\/?$/, "").replace(/\/$/, "");
}
export function pushSpec(argv: string[]): { remote: string; refs: string[] } | null {
  if (argv[0] !== "git" || argv[1] !== "push") return null;
  let remote: string | undefined;
  const refs: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (["-o", "--push-option", "--receive-pack", "--exec"].includes(arg)) { i++; continue; }
    if (arg === "--repo") { remote = argv[++i]; continue; }
    if (arg.startsWith("--repo=")) { remote = arg.slice(7); continue; }
    if (arg.startsWith("-")) continue;
    if (!remote) remote = arg;
    else refs.push(arg);
  }
  return remote ? { remote, refs } : null;
}
