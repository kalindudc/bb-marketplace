import { shellQuote } from "./sandbox";
import type { ShellCommand } from "./shell";

export function bbPositionals(argv: string[]): string[] {
  if (argv[0] !== "bb") return argv;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (["--input-file", "--project", "--host", "--server", "--url", "--token"].includes(argv[i])) i++;
    else if (!argv[i].startsWith("--")) words.push(argv[i]);
  }
  return words;
}
export function agentProgram(argv: string[]): boolean {
  const help = argv.includes("--help") || argv.includes("--version");
  argv = bbPositionals(argv);
  const [program, sub, action] = argv;
  if (program === "cortex") return ["ls", "show", "search", "recall", "schema", "doctor", "watch", "memory", "add", "update", "edit"].includes(sub);
  if (program !== "bb") return false;
  if (help) return true;
  if (sub === "plugin" && action === "rpc") return ["list", "show"].includes(argv[3]);
  if (sub === "secrets" && action === "request") return true;
  if (["settings", "lan", "secrets"].includes(sub)) return ["show", "status", "list"].includes(action);
  return ["status", "guide", "help", "--help", "--version", "flare", "browser-automation", "journal"].includes(sub) ||
    ["show", "list", "log", "logs", "context", "help", "status", "--help"].includes(action) ||
    sub === "thread" && ["tell", "send", "wait"].includes(action) ||
    sub === "tavern" && ["quests", "stop-all"].includes(action) ||
    sub === "shuttle" && ["prs", "board", "boards"].includes(action) ||
    ["automation", "automations"].includes(sub) && action === "runs" ||
    sub === "browser" && action === "instances" ||
    sub === "tavern" && action === "journal" && ["export", "show", "list"].includes(argv[3]);
}
export { userControl } from "./acts";
export function nestedCommands(command: ShellCommand): string[] {
  const argv = command.argv, [program] = argv;
  const source = (args: string[]) => args.map(shellQuote).join(" ");
  if (program === "find") {
    const found: string[] = [];
    for (let i = 1; i < argv.length; i++) if (["-exec", "-execdir", "-ok", "-okdir"].includes(argv[i])) {
      let end = i + 1; while (end < argv.length && ![";", "+"].includes(argv[end])) end++;
      found.push(source(argv.slice(i + 1, end))); i = end;
    }
    return found;
  }
  if (["parallel", "watch"].includes(program)) {
    let i = 1;
    while (argv[i]?.startsWith("-")) { const option = argv[i++]; if (["-n", "--interval", "-j", "--jobs", "--delay"].includes(option)) i++; }
    let end = argv.indexOf(":::"); if (end < 0) end = argv.length;
    return i < end ? [source(argv.slice(i, end))] : [];
  }
  const generated = /^\$\(\s*echo\s+(\w+)\s*\)$/.exec(program ?? "");
  return generated ? [source([generated[1], ...argv.slice(1)])] : [];
}
