import { isSink } from "./paths";
import { normalizeCommand, stripWrappers, type ShellCommand } from "./shell";

export function xxdRead(argv: string[]): boolean {
  let i = 1;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { i++; break; }
    if (arg === "-" || !arg.startsWith("-")) break;
    if (["-a", "-b", "-C", "-d", "-E", "-e", "-h", "-i", "-p", "-ps", "-r", "-u", "-v", "--help", "--version"].includes(arg)) continue;
    if (/^-[cglnosR]/.test(arg)) {
      if (arg.length === 2 && ++i >= argv.length) return false;
    } else return false;
  }
  const files = argv.slice(i);
  return files.length <= 1 || files.length === 2 && (files[1] === "-" || isSink(files[1]));
}
export function fileRead(argv: string[]): boolean {
  const values = ["--magic-file", "--files-from", "--separator", "--exclude", "--exclude-quiet", "--parameter"];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const option = arg.split("=")[0];
      if ("--compile".startsWith(option)) return false;
      if (!arg.includes("=") && values.some(value => value.startsWith(option))) i++;
    } else if (arg.startsWith("-")) {
      for (let n = 1; n < arg.length; n++) {
        if (arg[n] === "C") return false;
        if ("mMfFeP".includes(arg[n])) { if (n === arg.length - 1) i++; break; }
      }
    }
  }
  return true;
}

function sedProgram(script: string): boolean {
  let i = 0;
  const delimited = () => {
    const delimiter = script[i++];
    while (i < script.length) { if (script[i] === "\\") i += 2; else if (script[i++] === delimiter) return true; }
    return false;
  };
  while (i < script.length) {
    while (/[\s;]/.test(script[i] ?? "") && i < script.length) i++;
    if (i === script.length) return true;
    for (let address = 0; address < 2; address++) {
      if (/\d/.test(script[i] ?? "")) while (/\d/.test(script[i] ?? "") && i < script.length) i++;
      else if (script[i] === "$") i++;
      else if (script[i] === "/" && !delimited()) return false;
      if (script[i] !== ",") break;
      i++;
    }
    if (script[i] === "!") i++;
    while (/\s/.test(script[i] ?? "") && i < script.length) i++;
    const command = script[i++];
    if (command === "s") {
      const delimiter = script[i];
      if (!delimiter || /[\s\\]/.test(delimiter) || !delimited()) return false;
      // The replacement starts after the pattern's closing delimiter.
      i--;
      if (!delimited()) return false;
      const start = i; while (i < script.length && !/[;\n]/.test(script[i])) i++;
      if (!/^[gIpM\d\s]*$/.test(script.slice(start, i))) return false;
    } else if (command === "{" || command === "}") continue;
    else if (!["p", "d", "q", "="].includes(command)) return false;
    else if (i < script.length && !/[\s;}]/.test(script[i])) return false;
  }
  return true;
}
export function sedRead(argv: string[]): boolean {
  const scripts: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (/^--(?:in-place|file)|^-[^-]*[if]/.test(arg)) return false;
    if (arg === "-e" || arg === "--expression") scripts.push(argv[++i] ?? "");
    else if (arg.startsWith("--expression=")) scripts.push(arg.slice(13));
    else if (arg.startsWith("-e")) scripts.push(arg.slice(2));
    else if (arg.startsWith("-")) { if (!/^-[nEr]+$/.test(arg)) return false; }
    else if (!scripts.length) scripts.push(arg);
  }
  return scripts.length > 0 && scripts.every(sedProgram);
}
export function awkRead(argv: string[]): boolean {
  let program: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (/^-[ifW]|^--(?:include|file)/.test(arg)) return false;
    if (arg === "-v" || arg === "-F") { i++; continue; }
    if (/^-[vF]./.test(arg)) continue;
    if (!arg.startsWith("-")) { program = arg; break; }
  }
  if (program === undefined) return false;
  let inspected = "", regexStart = true;
  for (let i = 0; i < program.length; i++) {
    const char = program[i];
    if (char === '"' || char === "/" && regexStart) {
      const delimiter = char;
      let closed = false;
      while (++i < program.length) {
        if (program[i] === "\\") i++;
        else if (program[i] === delimiter) { closed = true; break; }
      }
      if (!closed) return false;
      inspected += "STRING"; regexStart = false;
    } else {
      inspected += char;
      if (!/\s/.test(char)) regexStart = /[({=,:;!&|?~+*%<>\/\-]/.test(char);
    }
  }
  if (/@(?:load|include)|\b(?:system|getline)\b/.test(inspected)) return false;
  const tokens = inspected.match(/\|\||>>|[A-Za-z_]\w*|[(){};>|]|\S/g) ?? [];
  let depth = 0, printAt: number | undefined;
  for (const token of tokens) {
    if (token === "(") depth++;
    else if (token === ")") depth--;
    else if ([";", "{", "}"].includes(token)) printAt = undefined;
    else if (token === "print" || token === "printf") printAt = depth;
    else if (token === "|" || ((token === ">" || token === ">>") && printAt === depth)) return false;
  }
  return true;
}
export function findRead(command: ShellCommand, read: (command: ShellCommand) => boolean): boolean {
  const argv = command.argv;
  for (let i = 1; i < argv.length; i++) {
    if (/^-(?:delete|ok|fprint|fprintf|fls)/.test(argv[i])) return false;
    if (argv[i] !== "-exec" && argv[i] !== "-execdir") continue;
    const end = argv.findIndex((arg, n) => n > i && [";", "+"].includes(arg));
    if (end < 0) return false;
    const normalized = normalizeCommand(stripWrappers(argv.slice(i + 1, end)));
    if (!read({ ...command, argv: normalized.argv, text: normalized.argv.join(" "), scriptInput: undefined })) return false;
    i = end;
  }
  return true;
}
