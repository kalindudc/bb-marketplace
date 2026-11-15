const DEFINITE_TICK_REFUSALS = new Set([400, 401, 403, 404, 405, 410, 413, 422]);

export function isDefiniteTickRefusal(error: unknown) {
  if (error && typeof error === "object") {
    for (const key of ["status", "statusCode"] as const) {
      if (key in error) return DEFINITE_TICK_REFUSALS.has(Number(error[key as keyof typeof error]));
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = /^HTTP\s+(\d{3})(?=[:\s]|$)/i.exec(message);
  return status !== null && DEFINITE_TICK_REFUSALS.has(Number(status[1]));
}

export function isNotFound(error: unknown) {
  return (
    (typeof error === "object" &&
      error !== null &&
      (("status" in error && error.status === 404) ||
        ("statusCode" in error && error.statusCode === 404) ||
        ("code" in error && error.code === "not_found"))) ||
    /thread not found/i.test(String(error))
  );
}
