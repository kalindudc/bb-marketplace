export interface CdpSession {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
}

const COMMAND_TIMEOUT_MS = 15_000;

/**
 * Connect to the scoped CDP endpoint bb hands out for a control lease and attach to the leased page. bb's bridge
 * forwards page-level domains such as Network to that page, and every page shares bb Browser's one cookie store, so
 * `Network.setCookies` on the leased page writes cookies every bb Browser tab sees.
 */
export async function withLeasedPage<T>(endpoint: string, signal: AbortSignal, use: (page: CdpSession) => Promise<T>): Promise<T> {
  const socket = new WebSocket(endpoint);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let closed: Error | null = null;

  const fail = (error: Error) => {
    closed ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  await new Promise<void>((resolve, reject) => {
    const stop = (error: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.close();
      reject(error);
    };
    const onAbort = () => stop(new Error("The sync was cancelled"));
    const timer = setTimeout(() => stop(new Error("bb's Browser did not accept the connection")), COMMAND_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => stop(new Error("Could not connect to bb's Browser")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message ?? "CDP command failed"));
    else entry.resolve(message.result ?? {});
  });
  socket.addEventListener("close", () => fail(new Error("bb's Browser closed the connection")));
  const onAbort = () => {
    fail(new Error("The sync was cancelled"));
    socket.close();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const send = <R>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<R> => {
    if (closed) return Promise.reject(closed);
    const id = nextId++;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`bb's Browser did not answer ${method}`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };

  try {
    const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
    const target = targetInfos.find((info) => info.type === "page");
    if (!target) throw new Error("The leased bb Browser tab is gone");
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    return await use({ send: (method, params) => send(method, params, sessionId) });
  } finally {
    signal.removeEventListener("abort", onAbort);
    socket.close();
  }
}
