export function withEngagement<T>(capture: T): T {
  if (Array.isArray(capture)) return capture.map(withEngagement) as T;
  if (capture === null || typeof capture !== "object") return capture;
  const record = Object.fromEntries(Object.entries(capture).map(([key, value]) => [key, withEngagement(value)]));
  if (typeof record.threadId !== "string" || typeof record.classId !== "string" || !["member", "keeper", "solo"].includes(record.role)) return record as T;
  const observed = record.state;
  if (observed === "done" || observed === "stopped") record.state = "idle";
  if (record.role !== "keeper" && record.engagement === undefined)
    record.engagement = observed === "done" ? "resting" : observed === "stopped" ? "stopped" : "active";
  delete record.place;
  return record as T;
}
