export const MAX_LINEUP = 60;
export const DEFAULT_RECENT_LIMIT = 25;
export const MAX_RECENT_LIMIT = 100;

export interface ModelRef {
  providerId: string;
  model: string;
}

/** Which list the model menu shows: bb's own, or one of the two the plugin adds. */
export type View = "native" | "recent" | "lineup";
export const VIEWS: readonly View[] = ["native", "recent", "lineup"];

export interface LineupState {
  lineup: ModelRef[];
  lastView: View;
}

export const EMPTY_STATE: LineupState = { lineup: [], lastView: "native" };

export interface RecentModel extends ModelRef {
  /** When the most recent thread on this model was last active, in epoch milliseconds. */
  usedAt: number;
}

export interface CatalogModel {
  model: string;
  displayName: string;
  routeProviderId?: string;
}

export interface CatalogProvider {
  id: string;
  displayName: string;
  /** Prefix bb strips from model names in the menu, such as "GPT-" for Codex. */
  brandPrefix?: string;
  models: CatalogModel[];
}

export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.model === b.model;
}

/** A stable key for a provider and model; model ids can contain any character. */
export function modelKey(ref: ModelRef): string {
  return JSON.stringify([ref.providerId, ref.model]);
}

/** Drop duplicates and cap the length, keeping the first occurrence of each model. */
export function normalizeLineup(lineup: readonly ModelRef[]): ModelRef[] {
  const out: ModelRef[] = [];
  for (const ref of lineup) {
    if (out.length >= MAX_LINEUP) break;
    if (!out.some((existing) => sameModel(existing, ref))) {
      out.push({ providerId: ref.providerId, model: ref.model });
    }
  }
  return out;
}

export function inLineup(lineup: readonly ModelRef[], ref: ModelRef): boolean {
  return lineup.some((existing) => sameModel(existing, ref));
}

/**
 * Pin a model (at the end) or unpin it. Idempotent, so two windows that pin
 * the same model, or a repeated request, leave one copy.
 */
export function setPinned(lineup: readonly ModelRef[], ref: ModelRef, pinned: boolean): ModelRef[] {
  if (!pinned) return lineup.filter((existing) => !sameModel(existing, ref));
  return inLineup(lineup, ref) ? [...lineup] : normalizeLineup([...lineup, ref]);
}

export function moveModel(lineup: readonly ModelRef[], ref: ModelRef, delta: number): ModelRef[] {
  const index = lineup.findIndex((existing) => sameModel(existing, ref));
  const target = index + delta;
  if (index < 0 || target < 0 || target >= lineup.length) return [...lineup];
  const next = [...lineup];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

/** The model's name as bb's menu shows it: the display name without the provider's brand prefix. */
export function modelName(model: CatalogModel, brandPrefix?: string): string {
  const name = model.displayName || model.model;
  if (brandPrefix && name.toLowerCase().startsWith(brandPrefix.toLowerCase())) {
    return name.slice(brandPrefix.length).trimStart() || name;
  }
  return name;
}

/** The `title` bb puts on a model row in its menu: the name, then " · route" when there is one. */
export function nativeRowTitle(model: CatalogModel, brandPrefix?: string): string {
  const name = modelName(model, brandPrefix);
  return model.routeProviderId ? `${name} · ${model.routeProviderId}` : name;
}

export interface ResolvedModel extends ModelRef {
  name: string;
  route?: string;
  providerName: string;
}

/** Look up a provider and model in the catalog; null when this machine does not offer it. */
export function resolveModel(catalog: readonly CatalogProvider[], ref: ModelRef): ResolvedModel | null {
  const provider = catalog.find((candidate) => candidate.id === ref.providerId);
  const model = provider?.models.find((candidate) => candidate.model === ref.model);
  if (provider === undefined || model === undefined) return null;
  return {
    providerId: provider.id,
    model: model.model,
    name: modelName(model, provider.brandPrefix),
    ...(model.routeProviderId ? { route: model.routeProviderId } : {}),
    providerName: provider.displayName,
  };
}

/** True when the model's name, id, route or provider contain every word of the query. */
export function matchesQuery(model: ResolvedModel, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${model.name} ${model.model} ${model.route ?? ""} ${model.providerName}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Every model in the catalog that matches the query and is not in `exclude`, up to `limit`. */
export function searchCatalog(
  catalog: readonly CatalogProvider[],
  query: string,
  exclude: readonly ModelRef[],
  limit: number,
): ResolvedModel[] {
  if (query.trim() === "") return [];
  const out: ResolvedModel[] = [];
  for (const provider of catalog) {
    for (const model of provider.models) {
      const resolved = resolveModel([provider], { providerId: provider.id, model: model.model })!;
      if (!matchesQuery(resolved, query) || exclude.some((ref) => sameModel(ref, resolved))) continue;
      out.push(resolved);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Map each title on bb's rows to the one model id it names for a provider.
 * Titles that more than one model shares are left out, so a pin never lands
 * on the wrong model.
 */
export function rowTitleIndex(provider: CatalogProvider): Map<string, string> {
  const counts = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const model of provider.models) {
    const title = nativeRowTitle(model, provider.brandPrefix);
    counts.set(title, (counts.get(title) ?? 0) + 1);
    ids.set(title, model.model);
  }
  for (const [title, count] of counts) if (count > 1) ids.delete(title);
  return ids;
}

/** "now", "4m", "5h" or "3d" since a time in epoch milliseconds. */
export function timeAgo(at: number, now = Date.now()): string {
  const elapsed = now - at;
  if (!Number.isFinite(elapsed) || elapsed < 2 * 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h`;
  return `${Math.round(elapsed / 86_400_000)}d`;
}
