import type { ByteBudget, Deadline } from "./contracts.ts";

export class DeadlineError extends Error {
	readonly stage: string;

	constructor(stage: string, message = `${stage} timed out`) {
		super(message);
		this.name = "DeadlineError";
		this.stage = stage;
	}
}

export class ByteBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ByteBudgetError";
	}
}

export function createDeadline(timeoutMs: number, parent?: AbortSignal): Deadline {
	const duration = Math.max(0, Math.floor(timeoutMs));
	const expiresAt = Date.now() + duration;
	const controller = new AbortController();
	let disposed = false;
	let expired = false;
	const expire = () => {
		if (disposed || controller.signal.aborted) return;
		expired = true;
		controller.abort(new DeadlineError("operation"));
	};
	const timer = setTimeout(expire, duration);
	timer.unref?.();
	const onParentAbort = () => {
		if (!controller.signal.aborted) controller.abort(parent?.reason);
	};
	if (parent?.aborted) onParentAbort();
	else parent?.addEventListener("abort", onParentAbort, { once: true });

	return {
		expiresAt,
		signal: controller.signal,
		remainingMs: () => Math.max(0, expiresAt - Date.now()),
		throwIfExpired(stage: string) {
			if (expired || Date.now() >= expiresAt) throw new DeadlineError(stage);
			if (parent?.aborted || (controller.signal.aborted && !expired)) {
				throw parent?.reason instanceof Error ? parent.reason : new Error(`${stage} cancelled`);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clearTimeout(timer);
			parent?.removeEventListener("abort", onParentAbort);
		},
	};
}

export function createByteBudget(bytes: number): ByteBudget {
	let available = Math.max(0, Math.floor(bytes));
	return {
		remaining: () => available,
		consume(count: number) {
			if (!Number.isSafeInteger(count) || count < 0) throw new ByteBudgetError("Byte budget consumption must be a non-negative safe integer");
			if (count > available) throw new ByteBudgetError(`Byte budget exceeded: need ${count} bytes with ${available} remaining`);
			available -= count;
		},
	};
}
