/** A summary model as `provider/modelId`; null when the spec cannot name a registry model. Pure, so the bb app bundle can import it. */
export function parseSummaryModel(spec: string): { provider: string; modelId: string } | null {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1 || /\s|\/\//u.test(spec)) return null;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}
