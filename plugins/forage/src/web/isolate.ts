import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";

export class BoundedProcessTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Child process timed out after ${timeoutMs}ms`);
		this.name = "BoundedProcessTimeoutError";
	}
}

export interface BoundedProcessOptions {
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
	signal?: AbortSignal;
	stdin?: Uint8Array;
}

export interface BoundedProcessResult {
	stdout: Uint8Array;
	stderr: Uint8Array;
	code: number;
}

export function runBoundedProcess(command: string, args: readonly string[], options: BoundedProcessOptions): Promise<BoundedProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		let failure: Error | undefined;
		const finish = (error?: Error, result?: BoundedProcessResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(result!);
		};
		const stop = (error: Error) => {
			if (failure) return;
			failure = error;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => stop(new BoundedProcessTimeoutError(options.timeoutMs)), Math.max(1, options.timeoutMs));
		timer.unref?.();
		const onAbort = () => stop(new Error("Child process cancelled"));
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > options.maxStdoutBytes) stop(new Error(`Child process stdout exceeded limit of ${options.maxStdoutBytes} bytes`));
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.byteLength;
			if (stderrBytes > options.maxStderrBytes) stop(new Error(`Child process stderr exceeded limit of ${options.maxStderrBytes} bytes`));
			else stderr.push(chunk);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") finish(new Error(`Executable not found: ${command}`));
			else finish(error);
		});
		child.on("close", (code) => {
			if (failure) return finish(failure);
			finish(undefined, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? -1 });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.stdin ? Buffer.from(options.stdin) : undefined);
	});
}

export interface IsolatedPassage {
	index: number;
	line: number;
	excerpt: string;
}

const REGEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { content, source, flags, context, max } = workerData;
try {
  const re = new RegExp(source, flags);
  const passages = [];
  let lastEnd = -1;
  let line = 1;
  let lineScanned = 0;
  let outputChars = 0;
  let match;
  while ((match = re.exec(content)) !== null && passages.length < max) {
    if (match[0] === "") { re.lastIndex++; continue; }
    const index = match.index;
    if (index < lastEnd) continue;
    const start = Math.max(0, index - context);
    const end = Math.min(content.length, index + match[0].length + context);
    const excerpt = (start > 0 ? "…" : "") + content.slice(start, end).trim() + (end < content.length ? "…" : "");
    for (let i = lineScanned; i < index; i++) if (content.charCodeAt(i) === 10) line++;
    lineScanned = index;
    outputChars += excerpt.length;
    if (outputChars > 1048576) throw new Error("Regular expression output exceeded 1 MiB limit");
    passages.push({ index, line, excerpt });
    lastEnd = end;
  }
  parentPort.postMessage({ passages });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
`;

export function runRegexPassages(input: {
	content: string;
	source: string;
	flags: string;
	context: number;
	max: number;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<IsolatedPassage[]> {
	if (input.content.length > 8 * 1024 * 1024) return Promise.reject(new Error("Regex input exceeds 8 MiB isolation limit"));
	if (input.source.length > 2_000) return Promise.reject(new Error("Regex pattern exceeds 2,000 character isolation limit"));
	return new Promise((resolve, reject) => {
		const worker = new Worker(REGEX_WORKER_SOURCE, {
			eval: true,
			workerData: {
				content: input.content,
				source: input.source,
				flags: input.flags,
				context: Math.max(0, Math.min(input.context, 8 * 1024 * 1024)),
				max: Math.max(0, Math.min(input.max, 100)),
			},
		});
		let settled = false;
		const finish = (error?: Error, passages?: IsolatedPassage[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
			void worker.terminate();
			if (error) reject(error);
			else resolve(passages ?? []);
		};
		const timer = setTimeout(() => finish(new Error(`Regular expression timed out after ${input.timeoutMs}ms`)), Math.max(1, input.timeoutMs));
		timer.unref?.();
		const onAbort = () => finish(new Error("Regular expression cancelled"));
		if (input.signal?.aborted) onAbort();
		else input.signal?.addEventListener("abort", onAbort, { once: true });
		worker.once("message", (message: { passages?: IsolatedPassage[]; error?: string }) => {
			if (message.error) finish(new Error(message.error));
			else finish(undefined, message.passages);
		});
		worker.once("error", (error) => finish(error));
		worker.once("exit", (code) => {
			if (!settled && code !== 0) finish(new Error(`Regular expression worker exited with code ${code}`));
		});
	});
}
