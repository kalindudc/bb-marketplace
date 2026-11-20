import { execFile } from "node:child_process";
import { gitArguments, gitContainmentStderr, gitEnvironment, gitInvocation } from "../shared/git-safety";

type GitOptions = NonNullable<Parameters<typeof gitEnvironment>[1]> & {
  timeout: number;
  maxBuffer?: number;
  input?: string | Buffer;
};

export function execGit(root: string, args: readonly string[], options: GitOptions & { encoding: "utf8" }): Promise<string>;
export function execGit(root: string, args: readonly string[], options: GitOptions & { encoding?: never }): Promise<Buffer>;
export async function execGit(root: string, args: readonly string[], options: GitOptions & { encoding?: "utf8" }): Promise<string | Buffer> {
  const env = await gitEnvironment(root, { ...options, timeoutMs: options.timeout });
  const prefix = options.gitDir ? ["--git-dir", options.gitDir] : ["-C", root];
  const command = await gitInvocation(root, [...prefix, ...gitArguments(args, options.kind)], env, options);
  const { cwd, timeout, maxBuffer, signal, encoding, input } = options;
  const execution = { cwd, env, timeout, signal, encoding: encoding ?? "buffer", ...(maxBuffer === undefined ? {} : { maxBuffer }) };
  return new Promise((resolve, reject) => {
    let inputError: Error | undefined;
    const child = execFile(command.file, command.args, execution, (error, stdout, stderr) => {
      if (error) {
        const text = stderr.toString();
        const explained = gitContainmentStderr(command, text);
        if (explained !== text) {
          error.message += "\n" + explained.slice(text.trimEnd().length).trim();
          stderr = typeof stderr === "string" ? explained : Buffer.from(explained);
        }
        reject(Object.assign(error, { stdout, stderr }));
      } else if (inputError) reject(inputError);
      else resolve(stdout);
    });
    child.stdin?.on("error", error => { inputError = error; });
    child.stdin?.end(input);
  });
}
