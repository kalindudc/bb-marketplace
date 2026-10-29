import type {
	ConcreteSearchProvider,
	CrawlBackendName,
	ReaderProviderName,
	SearchProviderName,
	WebConfig,
} from "./web/config.ts";

export const PROFILE_NAMES = ["auto", "fast", "fresh", "docs", "private", "deep"] as const;
export type SearchProfileName = (typeof PROFILE_NAMES)[number];
export const PRIVACY_PROFILES = ["standard", "private"] as const;
export type PrivacyProfileName = (typeof PRIVACY_PROFILES)[number];

export class PolicyError extends Error {
	constructor(message: string) {
		super(`POLICY_BLOCKED: ${message}`);
		this.name = "PolicyError";
	}
}

export interface PolicyRequest {
	profile?: SearchProfileName;
	provider?: SearchProviderName;
	reader?: ReaderProviderName;
	backend?: CrawlBackendName;
	fallback?: boolean;
}

export interface ResolvedPolicy {
	profile: SearchProfileName;
	privacy: PrivacyProfileName;
	providers: ConcreteSearchProvider[];
	readers: ReaderProviderName[];
	backends: CrawlBackendName[];
	fallback: boolean;
	strictRecency: boolean;
	explicitProvider: boolean;
	allowPaidProviderFallback: boolean;
}

const PAID_PROVIDERS = new Set<ConcreteSearchProvider>(["brave", "tavily"]);

function configured(provider: ConcreteSearchProvider, config: WebConfig): boolean {
	if (provider === "brave") return Boolean(config.braveApiKey);
	if (provider === "tavily") return Boolean(config.tavilyApiKey);
	if (provider === "searxng") return Boolean(config.searxngUrl);
	return true;
}

function profileProviders(profile: SearchProfileName, config: WebConfig): ConcreteSearchProvider[] {
	const paid = config.allowPaidProviderFallback;
	switch (profile) {
		case "fast": return ["duckduckgo", ...(paid ? ["brave" as const] : []), "searxng"];
		case "fresh": return [...(paid ? ["brave" as const] : []), "exa", ...(paid ? ["tavily" as const] : [])];
		case "docs": return ["exa", "duckduckgo"];
		case "private": return ["searxng"];
		case "deep": return [...(paid ? ["brave" as const] : []), "exa", ...(paid ? ["tavily" as const] : [])];
		case "auto":
		default: return [...(paid ? ["brave" as const] : []), "searxng", "duckduckgo", "exa"];
	}
}

function ensureAllowed<T extends string>(kind: string, requested: T, allowed: readonly T[]): void {
	if (!allowed.includes(requested)) throw new PolicyError(`${kind} "${requested}" is outside the configured ${kind} ceiling`);
}

export function resolvePolicy(config: WebConfig, request: PolicyRequest, operation: "search" | "retrieval" = "search"): ResolvedPolicy {
	const requestedProfile = request.profile;
	const configuredProfile = config.profile;
	const privacy: PrivacyProfileName = config.privacyProfile === "private" || configuredProfile === "private" || requestedProfile === "private" ? "private" : "standard";
	if (privacy === "private" && requestedProfile !== undefined && requestedProfile !== "private") {
		throw new PolicyError(`profile "${requestedProfile}" cannot widen the configured private privacy ceiling`);
	}
	const profile: SearchProfileName = privacy === "private" ? "private" : requestedProfile ?? configuredProfile;
	const allowedProviders = privacy === "private" ? config.allowedProviders.filter((provider) => provider === "searxng") : config.allowedProviders;
	const allowedReaders = privacy === "private" ? config.allowedReaders.filter((reader) => reader === "direct") : config.allowedReaders;
	const allowedBackends = privacy === "private" ? config.allowedBackends.filter((backend) => backend === "local") : config.allowedBackends;
	if (request.reader) ensureAllowed("reader", request.reader, allowedReaders);
	if (request.backend) ensureAllowed("backend", request.backend, allowedBackends);

	const settingProvider = operation === "search" && config.provider !== "auto" ? config.provider : undefined;
	const callProvider = request.provider && request.provider !== "auto" ? request.provider : undefined;
	const requestedProvider = callProvider ?? settingProvider;
	const explicitProvider = Boolean(requestedProvider);
	const fallback = request.fallback ?? !requestedProvider;
	let providers: ConcreteSearchProvider[];
	if (requestedProvider) {
		ensureAllowed("provider", requestedProvider, allowedProviders);
		if (privacy === "private" && requestedProvider !== "searxng") throw new PolicyError(`provider "${requestedProvider}" is not permitted by the private profile`);
		providers = [requestedProvider];
		if (fallback) providers.push(...profileProviders(profile, config));
	} else {
		providers = profileProviders(profile, config);
	}
	providers = [...new Set(providers)].filter((provider) => allowedProviders.includes(provider) && (provider === requestedProvider || configured(provider, config)));
	if (!config.allowPaidProviderFallback && !explicitProvider) providers = providers.filter((provider) => !PAID_PROVIDERS.has(provider));
	if (privacy === "private") providers = providers.filter((provider) => provider === "searxng");
	if (!fallback) providers = providers.slice(0, 1);
	if (operation === "search" && providers.length === 0) throw new PolicyError(`no configured provider remains for profile "${profile}" within the current ceiling`);

	return {
		profile,
		privacy,
		providers,
		readers: request.reader ? [request.reader] : allowedReaders,
		backends: request.backend ? [request.backend] : allowedBackends,
		fallback,
		strictRecency: profile === "fresh" || profile === "deep",
		explicitProvider,
		allowPaidProviderFallback: config.allowPaidProviderFallback,
	};
}
