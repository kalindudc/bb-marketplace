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
export function legacyAct(command: ShellCommand): boolean {
  const [program, sub, action] = command.argv, argv = command.argv;
  if (["bb", "cortex"].includes(program)) return !agentProgram(argv);
  if (program === "dt") return sub === "deploy" || sub === "pr" && ["merge", "comment", "review", "close", "edit", "create"].includes(action);
  if (program === "quick") return argv.slice(1).includes("deploy");
  if (program === "security") return /^find-.*password$/.test(sub ?? "") && argv.some(arg => /^-[^-]*[wg]/.test(arg));
  if (program === "vault") return argv.slice(1).includes("read") || argv.includes("kv") && argv.includes("get");
  if (["slack", "slack-cli", "mail", "mailx", "sendmail", "mutt"].includes(program)) return true;
  if (program === "gcloud") {
    const reads = ["list", "describe", "get-value", "read", "cat", "ls", "info"];
    const writes = ["cp", "mv", "rm", "rsync", "create", "delete", "update", "set", "reset", "deploy", "apply", "destroy", "import", "install", "uninstall", "remove", "add"];
    const verb = argv.slice(2).find(arg => reads.includes(arg) || writes.includes(arg));
    return !verb || !reads.includes(verb);
  }
  if (program === "curl") return argv.some((arg, i) => /^--(?:data|json|form|upload|config)|^-[^-]*[dFTK]/.test(arg) || /^(?:--request=|-X)(?!GET$|HEAD$|OPTIONS$).+/.test(arg) || ["-X", "--request"].includes(arg) && !["GET", "HEAD", "OPTIONS"].includes(argv[i + 1]));
  if (program === "wget") return argv.some(arg => /^--(?:post|body|method|input-file)/.test(arg));
  return false;
}
const clientOnlyMethods = ["answerAsk", "applyClassExecution", "archiveBoardQuests", "awayClose", "awayReturn", "deleteBoardQuest", "dismissClassNotice", "releaseCheckerHandoff", "removeClassOverride", "restoreDeletedQuest", "saveClass", "setTaleKept", "settingsApplySuggestion", "settingsFile", "settingsImport", "settingsUndo", "settingsUpdate", "voiceCheckCancel", "voiceCheckStart"];
const namedUserMethods = ["resumeAll", "releaseHold", "backupRestore", "confirmRule", "stopBoardQuest", "addRule", "widenRule", "undoDecision", "correctRoute", "resumeKeeper", "journalEdit", "saveCharacterVoice"];
const userMethods = new Set([...clientOnlyMethods, ...namedUserMethods]);
export function userControl(command: ShellCommand): boolean {
  const words = bbPositionals(command.argv);
  if (words[0] !== "bb" || !words.includes("tavern")) return false;
  const has = (word: string) => words.includes(word);
  const rpc = words.indexOf("rpc"), call = words.indexOf("call", rpc + 1);
  if (rpc >= 0 && call > rpc && words.slice(call + 1).some(word => userMethods.has(word))) return true;
  if (rpc >= 0 && call > rpc && /[$`]/.test(words[words.indexOf("tavern") + 1] ?? "")) return true;
  return ["ask", "release", "return", "rule", "stop"].some(has) ||
    has("settings") && ["set", "import", "undo", "apply", "file"].some(has) ||
    has("guard") && ["install", "uninstall"].some(has) ||
    has("backup") && has("restore") || has("stop-all") && has("resume");
}
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
