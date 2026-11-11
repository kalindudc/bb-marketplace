import { QueryClient } from "@tanstack/react-query";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

const clients = new Set<QueryClient>();
export const queryClients = () => clients;
let restore: () => void;

// SDK slots unmount React but leave their five-minute query GC timers alive.
beforeEach(() => {
  const getQueryCache = QueryClient.prototype.getQueryCache;
  const getMutationCache = QueryClient.prototype.getMutationCache;
  const query = vi.spyOn(QueryClient.prototype, "getQueryCache").mockImplementation(function (this: QueryClient) {
    clients.add(this);
    return getQueryCache.call(this);
  });
  const mutation = vi.spyOn(QueryClient.prototype, "getMutationCache").mockImplementation(function (this: QueryClient) {
    clients.add(this);
    return getMutationCache.call(this);
  });
  restore = () => {
    query.mockRestore();
    mutation.mockRestore();
  };
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    restore();
    for (const client of clients) {
      // MutationCache.clear removes entries without destroying their GC timers.
      for (const mutation of client.getMutationCache().getAll()) mutation.destroy();
      client.clear();
    }
    clients.clear();
  }
});
