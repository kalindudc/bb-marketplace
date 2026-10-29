import type { Deadline } from "../contracts.ts";
import { NetError, type Resolver, vetUrl } from "../net.ts";

const SENSITIVE_QUERY_KEYS = new Set(["token", "key", "secret", "signature", "sig", "auth", "access_token", "code", "session"]);

export class RemoteForwardingError extends Error {
	constructor(message: string) {
		super(`POLICY_BLOCKED: ${message}`);
		this.name = "RemoteForwardingError";
	}
}

export async function assertRemoteForwardableUrl(
	input: string,
	options: { resolver?: Resolver; signal?: AbortSignal; deadline?: Deadline } = {},
): Promise<URL> {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new RemoteForwardingError("remote readers require a valid HTTP(S) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new RemoteForwardingError("remote readers accept only HTTP(S) URLs");
	if (url.username || url.password) throw new RemoteForwardingError("URLs with userinfo cannot be sent to a remote reader");
	for (const key of url.searchParams.keys()) {
		if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) throw new RemoteForwardingError("a sensitive query name prevents remote forwarding");
	}
	url.hash = "";
	try {
		await vetUrl(url, { allowPrivateNetwork: false, resolver: options.resolver, signal: options.signal, deadline: options.deadline });
	} catch (error) {
		if (error instanceof NetError && error.kind === "blocked") throw new RemoteForwardingError("private, local, link-local and credentialed targets cannot be sent to a remote reader");
		throw new RemoteForwardingError("the target could not be proven public before remote forwarding");
	}
	return url;
}
