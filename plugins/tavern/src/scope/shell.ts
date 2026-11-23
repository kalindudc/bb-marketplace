import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { parseScript, type Command, type List, type Redirect, type Word } from "./parser";
import type { ShellRule } from "./schema";
import { glob } from "./paths";

export interface ShellCommand { argv: string[]; originalArgv?: string[]; executable?: string; cwd: string; writes: string[]; text: string; source?: string; uncertain?: boolean; scriptInput?: "inline" | "heredoc" | "opaque"; gitEnvironment?: boolean; aliases?: Record<string, string>; repository?: string; sequence?: number; cwdAlternative?: boolean; githubEnvironment?: boolean; fedInput?: boolean; xargs?: true; literalStdin?: string }
export interface ShellFacts { captureStdin?: boolean; containment?: "sandbox"; temporaryRoot?: string; isRead?(command: ShellCommand): boolean; directories?: string[]; gitRoots?: Record<string, string>; env?: Record<string, string> }
export function unquote(value: string): string {
  return value.replace(/\\\n/g, "").replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/gs, (_all, single, double, escaped) => single ?? (double !== undefined ? double.replace(/\\([\\"$`])/g, "$1") : escaped));
}
export function stripWrappers(words: string[], chdir?: (path: string) => void, write?: (path: string) => void, captureExecutable?: (path: string) => void): string[] {
  let argv = [...words];
  for (let n = 0; n < 20 && argv.length; n++) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? "")) argv.shift();
    if (!argv.length) break;
    captureExecutable?.(argv[0]);
    argv[0] = basename(argv[0]);
    const wrapper = argv[0];
    if (wrapper === "command" && ["-v", "-V"].includes(argv[1])) return ["which", ...argv.slice(2)];
    if (!["sudo", "env", "command", "exec", "nohup", "timeout", "gtimeout", "nice", "time", "xargs", "caffeinate", "stdbuf", "unbuffer", "chronic", "ionice", "taskset", "flock", "doas", "runuser", "script"].includes(wrapper)) break;
    if (wrapper === "env" && (argv.length === 1 || argv.slice(1).every(arg => ["-0", "-i", "--null", "--ignore-environment"].includes(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)))) break;
    argv.shift();
    const takesValue: Record<string, string[]> = { sudo: ["-u", "-g", "-h", "-p", "-D", "--chdir"], env: ["-u", "--unset", "-C", "--chdir"], timeout: ["-k", "--kill-after", "-s", "--signal"], gtimeout: ["-k", "-s"], nice: ["-n"], time: ["-o", "-f"], xargs: ["-I", "-n", "-P", "-L", "-a", "-d", "-E", "-s", "--max-args", "--max-procs", "--max-lines", "--arg-file", "--delimiter"], caffeinate: ["-t", "-w"], stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"], ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"], flock: ["-w", "--timeout", "-E", "--conflict-exit-code"], doas: ["-u", "-C"], runuser: ["-u", "--user", "-g", "--group", "-G", "--supp-group", "-s", "--shell", "-w", "--whitelist-environment"], script: ["-t", "-I", "-O", "-T"] };
    while (argv[0]?.startsWith("-")) {
      const option = argv.shift()!;
      if (option === "--") break;
      if (["script", "flock", "runuser"].includes(wrapper) && /^(?:-c|--command)(?:=|$)/.test(option)) {
        if (wrapper === "script") write?.(argv[option.includes("=") ? 0 : 1] ?? "typescript");
        return [wrapper, option, ...argv];
      }
      if (wrapper === "taskset" && /^--pid(?:=|$)|^-[a-z]*p/.test(option)) return [wrapper, option, ...argv];
      if (takesValue[wrapper]?.includes(option)) {
        const value = argv.shift();
        if (value && (wrapper === "env" && ["-C", "--chdir"].includes(option) || wrapper === "sudo" && ["-D", "--chdir"].includes(option))) chdir?.(value);
      } else if ((wrapper === "env" || wrapper === "sudo") && option.startsWith("--chdir=")) chdir?.(option.slice(8));
      else if (wrapper === "env" && option.startsWith("-C") || wrapper === "sudo" && option.startsWith("-D")) chdir?.(option.slice(2));
    }
    if (wrapper === "flock" || wrapper === "script") {
      const file = argv.shift();
      if (wrapper === "script" || file && (argv.length || !/^\d+$/.test(file))) write?.(file ?? "typescript");
      if (!argv.length) return [wrapper, ...(file === undefined ? [] : [file])];
      if (wrapper === "flock" && /^(?:-c|--command)(?:=|$)/.test(argv[0])) return [wrapper, ...argv];
    } else if (["timeout", "gtimeout", "taskset"].includes(wrapper)) argv.shift();
  }
  return argv;
}
export function normalizeCommand(argv: string[]): { argv: string[]; directory?: string; repository?: string } {
  let directory: string | undefined, repository: string | undefined;
  const values: Record<string, string[]> = { gcloud: ["--project", "--account", "--configuration", "--impersonate-service-account", "--billing-project", "--access-token-file", "--flags-file"], bb: ["--project", "--host", "--server", "--url", "--token", "--new-machine", "--machine", "--environment-provider"], git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"], gh: ["-R", "--repo", "--hostname"], kubectl: ["--context", "--namespace", "-n", "--kubeconfig", "--cluster", "--user", "--server", "-s", "--token"], helm: ["--burst-limit", "--color", "--colour", "--content-cache", "--kube-apiserver", "--kube-as-group", "--kube-as-user", "--kube-ca-file", "--kube-context", "--kube-tls-server-name", "--kube-token", "--kubeconfig", "--namespace", "-n", "--qps", "--registry-config", "--repository-cache", "--repository-config"], terraform: ["-chdir"], kapp: ["-a", "--app", "-n", "--namespace", "--kubeconfig-context", "--kubeconfig"], dev: ["--context", "--namespace", "--project"], dt: ["--cluster", "--context", "-R", "--repo"] };
  const name = argv[0];
  const flags = /[$`]/.test(name ?? "") ? [...values.kubectl, ...values.helm, ...values.kapp, ...values.terraform] : values[name === "k" ? "kubectl" : name];
  if (!flags) return { argv };
  if (name === "gh" || name === "dt") {
    const normalized = [name];
    for (let i = 1; i < argv.length; i++) {
      if (["-R", "--repo"].includes(argv[i])) repository = argv[++i];
      else if (argv[i].startsWith("--repo=")) repository = argv[i].slice(7);
      else if (argv[i].startsWith("-R") && argv[i].length > 2) repository = argv[i].slice(2);
      else if (["--hostname", "--cluster", "--context"].includes(argv[i])) i++;
      else if (!/^(?:--hostname|--cluster|--context)=/.test(argv[i])) normalized.push(argv[i]);
    }
    return { argv: normalized, repository };
  }
  let index = 1;
  while (argv[index]?.startsWith("-")) {
    const option = argv[index++];
    if (option === "--") break;
    if (["--version", "--help"].includes(option)) return { argv: [name, option] }; 
    if (flags.includes(option)) {
      const value = argv[index++];
      if (option === "-C" || option === "--work-tree" || option === "--git-dir") directory = value;
      if (name === "gh" && ["-R", "--repo"].includes(option)) repository = value;
    } else if (/^--(?:work-tree|git-dir)=/.test(option)) directory = option.split("=").slice(1).join("=");
  }
  return { argv: [name, ...argv.slice(index)], directory, repository };
}
export function ruleMatches(rule: ShellRule, command: ShellCommand): boolean {
  if (rule.argv && !rule.argv.every((pattern, i) => typeof pattern === "string" ? glob(pattern, command.argv[i] ?? "") : pattern.includes(command.argv[i]))) return false;
  if (rule.regex && !new RegExp(rule.regex).test(command.text)) return false;
  return !rule.requires || rule.requires.every(flag => command.argv.includes(flag));
}
interface Location { cwd: string; known: boolean; stack: string[]; alternates?: string[] }
const locations = (loc: Location) => [...new Set([loc.cwd, ...loc.alternates ?? []])];
function changeDirectory(loc: Location, path: string): Location {
  return { ...loc, cwd: resolve(loc.cwd, path), alternates: [...new Set(locations(loc).slice(1).map(base => resolve(base, path)))].filter(base => base !== resolve(loc.cwd, path)), known: loc.known && !/[\$`~]/.test(path) };
}
export function shellCommands(source: string, cwd: string, facts: ShellFacts = {}): ShellCommand[] {
  const out: ShellCommand[] = [], aliases: Record<string, string> = {};
  const commandAliases = new Map<string, string[]>();
  let unknownLinks = false, directoriesStable = true;
  const values: Record<string, string> = {};
  const assigned = new Set<string>(), unsafeTemps = new Set<string>(), activeTemps = new Set<string>();
  let dynamicTargets = false, controlDepth = 0;
  const capture = (value: string) => /^\$\(\s*(?:\/usr\/bin\/)?mktemp(?:\s+(?:-d|--directory|-q|--quiet))*\s*\)$/.test(value);
  const markAssigned = (name: string, temporary = false) => { assigned.add(name); delete values[name]; if (!temporary) unsafeTemps.add(name); };
  const taintAll = () => {
    dynamicTargets = true;
    for (const name of [...Object.keys(facts.env ?? {}), "HOME", "PWD", "TMPDIR", "BB_THREAD_STORAGE", "IFS"]) markAssigned(name);
  };
  const tempValue = (name: string) => facts.temporaryRoot && !assigned.has("TMPDIR") && !dynamicTargets ? resolve(facts.temporaryRoot, "tmp.tavern-scope-" + name) : undefined;
  const valueOf = (raw: string, loc: Location, subs: Word["subs"] = []): string => {
    const replacements: string[] = [];
    const marked = raw.replace(/'[^']*'|\\[\s\S]|\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (token, braced, plain, offset: number) => {
      if (!token.startsWith("$")) return token;
      const quoted = raw.slice(0, offset).replace(/\x27[^\x27]*\x27|\\[\s\S]/g, "").split('"').length % 2 === 0;
      if (assigned.has("IFS") && !quoted) return token;
      const name = braced ?? plain;
      const value = facts.containment === "sandbox" && values[name] !== undefined ? values[name] : activeTemps.has(name) && !unsafeTemps.has(name) ? tempValue(name) : assigned.has(name) ? undefined : name === "PWD" ? loc.known && !loc.alternates?.length ? loc.cwd : undefined : facts.env?.[name];
      if (value === undefined) return token;
      replacements.push(value); return "\0" + (replacements.length - 1) + "\0";
    });
    const value = unquote(marked).replace(/\0(\d+)\0/g, (_token, index) => replacements[Number(index)]);
    if (capture(value) && subs.some(sub => sub.kind === "command")) return tempValue("output") ?? value;
    if (raw === "~" || raw.startsWith("~/")) return assigned.has("HOME") ? value : (facts.env?.HOME ?? homedir()) + value.slice(1);
    return value;
  };
  const inspect = (text: string, loc: Location): Location => {
    for (const arithmetic of text.matchAll(/\(\(([\s\S]*?)\)\)/g)) for (const assignment of arithmetic[1].matchAll(/\b([A-Za-z_]\w*)\s*(?:\+\+|--|(?:[+\-*/%&|^]|<<|>>)?=(?!=))/g)) markAssigned(assignment[1]);
    const inspected = text.replace(/\bfor\s*\(\([A-Za-z0-9_+\-*/%<>=!&| \t;]*\)\)/g, value => "for i".padEnd(value.length)).replace(/\(\([A-Za-z0-9_+\-*/%<>=!&| \t]+\)\)/g, value => "true".padEnd(value.length));
    return visit(parseScript(inspected), loc, inspected);
  };
  const words = (values: Word[], loc: Location) => { for (const word of values) for (const sub of word.subs) if (sub.kind !== "arith") inspect(sub.text, loc); };
  const writes = (values: Redirect[], loc: Location) => {
    words(values.map(value => value.target), loc);
    return values.filter(value => /^(?:>|>>|>\||&>|&>>|<>|>&)$/.test(value.op) && !/^\d+$/.test(value.target.text)).flatMap(value => locations(loc).map(cwd => { const path = valueOf(value.target.text, { ...loc, cwd, alternates: [] }, value.target.subs); return /[\$`]/.test(path) || path.startsWith("~") ? path : resolve(cwd, path); }));
  };
  const run = (node: Command, loc: Location, text: string, pipeInput = false, pipeText?: string): Location => {
    if (node.type === "function") { controlDepth++; run(node.body, loc, text); controlDepth--; return loc; }
    let temporaryAssignment: string | undefined;
    if (node.type === "simple") {
      const raw = node.words.map(word => unquote(word.text));
      const mutationBuiltin = ["export", "unset", "declare", "typeset", "local", "read", "mapfile", "readarray"].includes(raw[0]);
      if (raw[0] === "eval" && raw.slice(1).some(value => /[\$`]/.test(value))) taintAll();
      if (["declare", "typeset", "local"].includes(raw[0]) && raw.some(value => /^-[^-]*n/.test(value)) && !raw.some(value => /^[A-Za-z_]\w*=/.test(value))) taintAll();
      for (let i = 0; i < raw.length; i++) {
        const target = raw[i].split("=")[0];
        if (/^[A-Za-z_]\w*\[[^\]]*\](?:\+)?=/.test(raw[i])) taintAll();
        if (i > 0 && mutationBuiltin && !raw[i].startsWith("-") && /[\$`\[]/.test(target)) taintAll();
        const assignment = /^([A-Za-z_]\w*)=/.exec(raw[i]);
        if (assignment) {
          const temporary = controlDepth === 0 && raw.length === 1 && node.words[i].subs.some(sub => sub.kind === "command") && capture(raw[i].slice(assignment[0].length));
          const resolved = facts.containment === "sandbox" && controlDepth === 0 && raw.length === 1 ? valueOf(node.words[i].text.slice(assignment[0].length), loc, node.words[i].subs) : undefined;
          markAssigned(assignment[1], temporary);
          if (resolved !== undefined && !/[$`]/.test(resolved)) values[assignment[1]] = resolved;
          if (temporary) temporaryAssignment = assignment[1];
          if (["declare", "local", "typeset"].includes(raw[0]) && raw.some(value => /^-[^-]*n/.test(value)) && /^[A-Za-z_]\w*$/.test(raw[i].slice(assignment[0].length))) markAssigned(raw[i].slice(assignment[0].length));
        }
        if (raw.includes("printf") && (raw[i - 1] === "-v" || /^-v.+/.test(raw[i]))) {
          const name = raw[i - 1] === "-v" ? raw[i] : raw[i].slice(2);
          if (!/^[A-Za-z_]\w*$/.test(name)) taintAll(); else markAssigned(name);
        }
        const unset = /^(?:--unset=|-u)([A-Za-z_]\w*)$/.exec(raw[i]);
        if (unset) markAssigned(unset[1]);
        else if ((mutationBuiltin || ["-u", "--unset"].includes(raw[i - 1])) && /^[A-Za-z_]\w*$/.test(raw[i])) markAssigned(raw[i]);
      }
      if (raw.includes("sudo") || raw.includes("env") && raw.some(value => ["-i", "--ignore-environment", "-"].includes(value))) for (const name of Object.keys(facts.env ?? {})) markAssigned(name);
    }
    const targets = writes(node.redirects, loc);
    if (node.type === "simple") {
      words(node.words, loc);
      const original = node.words.map(word => word.text);
      let wrapped = { ...loc };
      const expandedWords = node.words.map(word => valueOf(word.text, loc, word.subs));
      if (expandedWords[0] === "alias") for (const word of expandedWords.slice(1)) {
        const bound = /^([\w-]+)=([^\n]+)$/.exec(word);
        if (!bound) continue;
        try {
          const list = parseScript(bound[2]);
          const line = list[0], command = line?.andOr.first.commands[0];
          if (list.length === 1 && !line.background && !line.andOr.rest.length && !line.andOr.first.negated &&
              line.andOr.first.commands.length === 1 && command?.type === "simple" && !command.redirects.length &&
              !command.words.some(word => word.subs.length))
            commandAliases.set(bound[1], command.words.map(word => unquote(word.text)));
        } catch { /* The alias definition is data until a literal command prefix can be inspected. */ }
      }
      if (expandedWords[0] === "unalias") {
        if (expandedWords.includes("-a")) commandAliases.clear();
        else for (const name of expandedWords.slice(1)) commandAliases.delete(name);
      }
      const change = (path: string) => { wrapped = changeDirectory(wrapped, path); };
      const write = (path: string) => {
        // A wrapped command may change directory after its wrapper opens the file.
        for (const cwd of locations(wrapped)) targets.push(/[$`]/.test(path) || path.startsWith("~") ? path : resolve(cwd, path));
      };
      let executable: string | undefined, xargs = false;
      const captureExecutable = (path: string) => { executable = path; xargs ||= basename(path) === "xargs"; };
      let stripped = stripWrappers(expandedWords, change, write, captureExecutable);
      const expanded = new Set<string>();
      while (commandAliases.has(stripped[0]) && !expanded.has(stripped[0])) {
        expanded.add(stripped[0]);
        stripped = stripWrappers([...commandAliases.get(stripped[0])!, ...stripped.slice(1)], change, write, captureExecutable);
      }
      const normalized = normalizeCommand(stripped), argv = normalized.argv;
      const local = normalized.directory ? changeDirectory(wrapped, normalized.directory) : wrapped;
      let scriptInput: ShellCommand["scriptInput"];
      if (["sh", "bash", "zsh", "dash"].includes(argv[0])) {
        let flag = -1;
        for (let i = 1; i < argv.length; i++) {
          const arg = argv[i];
          if (/^-[a-z]*c[a-z]*$/.test(arg)) { flag = i; break; }
          if (["--noprofile", "--norc", "--login"].includes(arg)) continue;
          if (/^-[eulxvETo]+$/.test(arg)) {
            if (arg.includes("o") && !["pipefail", "errexit", "nounset", "xtrace"].includes(argv[++i])) break;
            continue;
          }
          break;
        }
        const docs = node.redirects.filter(value => value.heredoc);
        scriptInput = flag >= 0 && argv[flag + 1] !== undefined ? "inline" : docs.length ? "heredoc" : "opaque";
        if (scriptInput === "inline") inspect(argv[flag + 1], local);
        for (const doc of docs) inspect(text.slice(doc.heredoc!.bodyStart, doc.heredoc!.bodyEnd), local);
        const hereString = node.redirects.find(value => value.op === "<<<");
        const input = hereString ? valueOf(hereString.target.text, local) : pipeText;
        if (scriptInput === "opaque" && input !== undefined && !/[\$`]/.test(input)) { scriptInput = "heredoc"; inspect(input, local); }
      }
      if (argv[0] === "eval") { scriptInput = "inline"; inspect(argv.slice(1).join(" "), local); }
      if (argv[0] === "mktemp") targets.push(assigned.has("TMPDIR") ? "$TMPDIR" : facts.env?.TMPDIR ?? "$TMPDIR");
      const redirectIn = facts.captureStdin ? node.redirects.filter(item => item.heredoc || item.op === "<" || item.op === "<<<").at(-1) : undefined;
      const doc = redirectIn?.heredoc;
      const docText = doc ? text.slice(doc.bodyStart, doc.bodyEnd) : undefined;
      const literalStdin = doc && docText !== undefined && (doc.quoted || !/[$`\\]/.test(docText))
        ? doc.stripTabs ? docText.replace(/^\t+/gm, "") : docText
        : redirectIn?.op === "<<<" && !redirectIn.target.subs.length && !/[$`]/.test(redirectIn.target.text) ? unquote(redirectIn.target.text) + "\n" : undefined;
      for (const cwd of locations(local)) { const command: ShellCommand = { argv, originalArgv: stripped, executable, cwd, cwdAlternative: !!local.alternates?.length, writes: targets, text: argv.join(" "), source: text.slice(node.start, node.end), repository: normalized.repository, githubEnvironment: original.some(value => /^--hostname(?:=|$)/.test(value)) || ["GH_REPO", "GH_HOST"].some(name => assigned.has(name) || facts.env?.[name] !== undefined), fedInput: pipeInput || node.redirects.some(value => ["<", "<<<"].includes(value.op)), ...(literalStdin === undefined ? {} : { literalStdin }), aliases: { ...aliases }, uncertain: !local.known || unknownLinks || (original.some(value => basename(value) === "env") && original.some(value => /^--split-string(?:=|$)|^-S/.test(value))), scriptInput, gitEnvironment: original.some((value, index) => /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_CONFIG\w*)=/.test(value) || original[index - 1] === "-c" && /^(?:remote\.|url\.|alias\.)/.test(unquote(value)) || value === "--config-env" || value.startsWith("--config-env=")) };
        if (xargs) command.xargs = true;
        out.push(command);
        directoriesStable &&= !!facts.isRead?.(command) || ["mkdir", "touch", "tee", "mktemp"].includes(argv[0]);
      }
      if (argv[0] === "ln" && argv.some(arg => arg === "-s" || /^-[^-]*s/.test(arg))) {
        const operands = argv.slice(1).filter(arg => !arg.startsWith("-"));
        if (operands.length === 2 && operands.every(arg => !/[\$`~]/.test(arg))) aliases[resolve(local.cwd, operands[1])] = resolve(local.cwd, operands[0]);
        else unknownLinks = true;
      }
      if (argv[0] === "popd" && loc.alternates?.length) return { ...loc, known: false };
      if (argv[0] === "popd") return loc.stack.length ? { cwd: loc.stack.at(-1)!, known: loc.known, stack: loc.stack.slice(0, -1) } : { ...loc, known: false };
      if (["cd", "pushd"].includes(argv[0])) {
        const args = argv.slice(1);
        while (args[0] && ["-L", "-P", "--"].includes(args[0])) { if (args.shift() === "--") break; }
        let target = args[0] ?? (assigned.has("HOME") ? "$HOME" : facts.env?.HOME ?? homedir());
        const gitRoot = "$(git rev-parse --show-toplevel)";
        if (target === gitRoot || target.startsWith(gitRoot + "/")) target = facts.gitRoots?.[loc.cwd] ? facts.gitRoots[loc.cwd] + target.slice(gitRoot.length) : target;
        if (args.length > 1 || target.startsWith("-") || /[\$`~]/.test(target)) return { ...loc, known: false };
        return { ...changeDirectory(loc, target), stack: argv[0] === "pushd" ? [...loc.stack, loc.cwd] : loc.stack, known: loc.known && !(argv[0] === "pushd" && loc.alternates?.length) };
      }
      if (temporaryAssignment) activeTemps.add(temporaryAssignment);
      return loc;
    }
    if (targets.length) out.push({ argv: [], cwd: loc.cwd, writes: targets, text: "redirection", uncertain: !loc.known, aliases: { ...aliases } });
    if (node.type === "subshell") { controlDepth++; visit(node.body, loc, text); controlDepth--; return loc; }
    if (node.type === "group") { controlDepth++; const end = visit(node.body, loc, text); controlDepth--; return end; }
    controlDepth++;
    const ends: Location[] = [loc];
    if (node.type === "while") { ends.push(visit(node.cond, loc, text), visit(node.body, loc, text)); }
    if (node.type === "for") {
      markAssigned(node.name); words(node.words ?? [], loc);
      const iterations = (node.words ?? []).map(word => valueOf(word.text, loc, word.subs));
      if (facts.containment === "sandbox" && iterations.length > 0 && iterations.every(value => /^[a-zA-Z0-9_.-]+$/.test(value))) {
        for (const value of iterations) { values[node.name] = value; ends.push(visit(node.body, loc, text)); }
        delete values[node.name];
      } else ends.push(visit(node.body, loc, text));
    }
    if (node.type === "if") { for (const clause of node.clauses) ends.push(visit(clause.body, visit(clause.cond, loc, text), text)); if (node.elseBody) ends.push(visit(node.elseBody, loc, text)); }
    if (node.type === "case") { words([node.subject], loc); for (const item of node.items) ends.push(visit(item.body, loc, text)); }
    controlDepth--;
    return ends.every(end => end.known && end.cwd === loc.cwd && !end.alternates?.some(path => !locations(loc).includes(path)) && end.stack.join("\0") === loc.stack.join("\0")) ? loc : { ...loc, known: false };
  };
  const visit = (list: List, initial: Location, text: string): Location => {
    let loc = { ...initial, stack: [...initial.stack] };
    for (const item of list) {
      const incomingTemps = new Set(activeTemps);
      const clearTemps = () => { for (const name of activeTemps) if (!incomingTemps.has(name)) activeTemps.delete(name); };
      const candidates: string[] = [];
      const pipelines = [item.andOr.first, ...item.andOr.rest.map(rest => rest.pipeline)];
      const conditionalTemps = item.background || item.andOr.rest.some(rest => rest.op !== "&&") || pipelines.some(pipeline => pipeline.negated || pipeline.commands.length !== 1);
      if (conditionalTemps) controlDepth++;
      const final = pipelines.at(-1)!;
      const terminates = item.andOr.rest.at(-1)?.op === "||" && final.commands.length === 1 && final.commands[0].type === "simple" && ["exit", "return"].includes(final.commands[0].words[0]?.text);
      const directoryChoices = terminates ? pipelines.slice(0, -1) : pipelines;
      if (item.andOr.rest.length && item.andOr.rest.every(rest => rest.op === "||") && directoryChoices.every(pipeline => pipeline.commands.length === 1 && pipeline.commands[0].type === "simple" && pipeline.commands[0].words[0]?.text === "cd")) {
        const origin = loc;
        const successes = directoryChoices.map(pipeline => run(pipeline.commands[0], origin, text));
        if (terminates) run(final.commands[0], origin, text);
        const definite = directoriesStable && successes.some(end => end.known && locations(end).every(path => facts.directories?.includes(path)));
        if (!terminates && !definite) successes.push(origin);
        loc = successes.at(-1)!;
        const alternates = [...new Set(successes.flatMap(locations))].filter(path => path !== loc.cwd);
        loc = { ...loc, known: successes.every(end => end.known) && alternates.length <= 32, alternates: alternates.slice(0, 32) };
        if (conditionalTemps) controlDepth--;
        clearTemps(); continue;
      }
      for (let p = 0; p < pipelines.length; p++) {
        if (p > 0 && item.andOr.rest[p - 1].op === "||") { clearTemps(); }
        if (p > 0 && item.andOr.rest[p - 1].op === "||") candidates.push(...locations(loc));
        const before = locations(loc);
        const pipeline = pipelines[p];
        for (let i = 0; i < pipeline.commands.length; i++) {
          const previous = pipeline.commands[i - 1];
          const docs = previous?.type === "simple" && previous.words.length === 1 && unquote(previous.words[0].text) === "cat" ? previous.redirects.filter(value => value.heredoc) : [];
          let literal: string | undefined;
          if (previous?.type === "simple" && ["echo", "printf"].includes(unquote(previous.words[0]?.text ?? ""))) {
            const args = previous.words.slice(1).map(word => valueOf(word.text, loc, word.subs));
            let argument = 1;
            literal = unquote(previous.words[0].text) === "echo" ? args.join(" ") : args[0]?.replace(/%s/g, () => args[argument++] ?? "").replace(/\\n/g, "\n");
          }
          const input = docs.length ? docs.map(doc => text.slice(doc.heredoc!.bodyStart, doc.heredoc!.bodyEnd)).join("\n") : literal;
          const end = run(pipeline.commands[i], loc, text, i > 0, input);
          if (pipeline.commands.length === 1) {
            const moved = end.cwd !== loc.cwd || end.known !== loc.known;
            const definite = directoriesStable && end.known && locations(end).every(path => facts.directories?.includes(path));
            if (moved && !definite || p < pipelines.length - 1 && item.andOr.rest[p].op === "&&" && !(moved && definite)) candidates.push(...before);
            loc = end;
          }
        }
      }
      const alternates = [...new Set([...loc.alternates ?? [], ...candidates])].filter(path => path !== loc.cwd);
      loc = alternates.length > 32 ? { ...loc, known: false, alternates: [] } : { ...loc, alternates };
      if (conditionalTemps) controlDepth--;
      clearTemps();
    }
    return loc;
  };
  inspect(source, { cwd, known: true, stack: [] });
  if (facts.containment === "sandbox") { assigned.clear(); unsafeTemps.clear(); dynamicTargets = false; for (const name of Object.keys(values)) delete values[name]; }
  out.length = 0; unknownLinks = false; directoriesStable = true; activeTemps.clear();
  for (const path of Object.keys(aliases)) delete aliases[path];
  inspect(source, { cwd, known: true, stack: [] });
  return out.map((command, sequence) => ({ ...command, sequence }));
}
export function commandWritePaths(command: ShellCommand): string[] {
  return [...command.writes, ...knownWritePaths(command.argv)].map(path => {
    if (/[\$`]/.test(path) || path.startsWith("~")) return path;
    let full = resolve(command.cwd, path);
    for (let depth = 0; depth < 20; depth++) {
      const alias = Object.keys(command.aliases ?? {}).sort((a, b) => b.length - a.length).find(link => full === link || full.startsWith(link + "/"));
      if (!alias) return full;
      full = command.aliases![alias] + full.slice(alias.length);
    }
    throw new Error("Cannot resolve cyclic shell symlinks");
  });
}
function knownWritePaths(argv: string[]): string[] {
  const name = argv[0];
  const args = argv.slice(1).filter(value => !value.startsWith("-"));
  if (name === "mktemp") {
    const paths = [...args];
    for (let i = 1; i < argv.length; i++) {
      if (["-p", "--tmpdir"].includes(argv[i]) && argv[i + 1] === undefined) paths.push("$MKTEMP_DIRECTORY");
      if (/^--tmpdir=|^-p./.test(argv[i])) paths.push(argv[i].replace(/^--tmpdir=|^-p/, ""));
      if (argv[i] === "-t") paths.push("$MKTEMP_TEMPLATE");
    }
    return paths;
  }
  if (["touch", "mkdir", "rmdir", "rm", "tee", "truncate", "chmod", "chown"].includes(name)) return args;
  if (["mv", "cp", "install", "ln"].includes(name)) return name === "mv" ? args : args.slice(-1);
  if ((name === "sed" || name === "perl") && argv.some(value => /^-.*i/.test(value))) return args.slice(1);
  return [];
}
