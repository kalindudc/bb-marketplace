import type { ShellCommand } from "./shell";

export function draftEditSelector(argv: string[]): string | undefined | null {
  const values = ["--add-assignee", "--add-label", "--add-project", "--add-reviewer", "--base", "--body", "--body-file", "--milestone", "--remove-assignee", "--remove-label", "--remove-project", "--remove-reviewer", "--title"];
  const selectors: string[] = [];
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { selectors.push(...argv.slice(i + 1)); break; }
    if (values.includes(arg) || /^-[BbFmt]$/.test(arg)) { if (argv[++i] === undefined) return null; }
    else if (values.some(flag => arg.startsWith(flag + "=")) || /^-[BbFmt].+/.test(arg)) continue;
    else if (arg.startsWith("-")) return null;
    else selectors.push(arg);
  }
  return selectors.length > 1 || selectors.some(value => /[$`]/.test(value)) ? null : selectors[0];
}
export const draftEditKey = (command: ShellCommand) => command.cwd + "\0" + command.sequence + "\0" + (command.repository ?? "") + "\0" + (draftEditSelector(command.argv) ?? "");
export function githubApiRead(argv: string[]): boolean {
  const fields: string[] = [];
  let method: string | undefined, input = false, endpoint: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (["-H", "--header", "--hostname", "-q", "--jq", "-t", "--template", "--cache"].includes(arg)) { i++; continue; }
    if (!arg.startsWith("-") && endpoint === undefined) endpoint = arg;
    if (["-f", "-F", "--field", "--raw-field"].includes(arg)) fields.push(argv[++i] ?? "");
    else if (/^(?:--(?:raw-)?field=|-[fF].)/.test(arg)) fields.push(arg.replace(/^(?:--(?:raw-)?field=|-[fF])/, ""));
    if (["-X", "--method"].includes(arg)) method = argv[++i];
    else if (/^--method=|^-X./.test(arg)) method = arg.replace(/^--method=|^-X/, "");
    if (/^--input(?:=|$)/.test(arg)) input = true;
  }
  if (input) return false;
  if (endpoint === "graphql") {
    if (method && !["GET", "POST"].includes(method)) return false;
    const queries = fields.filter(field => field.startsWith("query="));
    if (queries.length !== 1 || fields.some(field => !/^[A-Za-z_]\w*=/.test(field) || /^(?:mutation|subscription)=/.test(field))) return false;
    const query = queries[0].slice(6).replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n]*/g, " ").trim();
    return /^(?:query\b|\{)/.test(query) && !/\b(?:mutation|subscription)\b/.test(query);
  }
  return (!fields.length || method === "GET") && (!method || ["GET", "HEAD", "OPTIONS"].includes(method));
}
