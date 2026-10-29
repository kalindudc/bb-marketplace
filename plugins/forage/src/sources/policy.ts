import { sourceScopeKey } from "../web/contracts.ts";
import type { AccessDescriptor, RecordRetrievalInput, ScopeAuthorityResult, SourceRepository, SourceScope } from "./model.ts";

const SENSITIVE_QUERY_KEYS = new Set(["token", "key", "secret", "signature", "sig", "auth", "access_token", "code", "session"]);
const URL_TOKEN_LIMIT = 4096;
const URL_TOKEN = /https?:\/\/[^\s<>()"'`]+/giu;

export interface CapturePolicyDecision {
	persist: boolean;
	code: "POLICY_BLOCKED" | null;
	message: string | null;
}

export function isSensitiveUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return true;
	}
	if (url.username !== "" || url.password !== "") return true;
	for (const key of url.searchParams.keys()) {
		if (SENSITIVE_QUERY_KEYS.has(key.toLocaleLowerCase("en-US"))) return true;
	}
	return false;
}

type UrlPolicyResult = "clear" | "sensitive" | "unverified";

function contentUrlPolicy(content: string): UrlPolicyResult {
	URL_TOKEN.lastIndex = 0;
	let count = 0;
	for (const match of content.matchAll(URL_TOKEN)) {
		count += 1;
		if (count > URL_TOKEN_LIMIT) return "unverified";
		const candidate = match[0].replace(/[.,;:!?\])}]+$/u, "");
		if (isSensitiveUrl(candidate)) return "sensitive";
	}
	return "clear";
}

function artifactUrlPolicy(input: Extract<RecordRetrievalInput, { artifact: object }>): UrlPolicyResult {
	const { artifact } = input;
	const urls = [artifact.requestedUrl, artifact.resolvedUrl, artifact.finalUrl, artifact.structured?.canonicalUrl ?? null];
	for (const url of urls) {
		if (url !== null && isSensitiveUrl(url)) return "sensitive";
	}
	for (const link of artifact.structured?.links ?? []) {
		if (isSensitiveUrl(link.url)) return "sensitive";
	}
	return contentUrlPolicy(artifact.content);
}

export function artifactHasSensitiveUrl(input: Extract<RecordRetrievalInput, { artifact: object }>): boolean {
	return artifactUrlPolicy(input) !== "clear";
}

export function isRestrictedAccess(access: AccessDescriptor): boolean {
	return access.network !== "public" || access.credentialed;
}

export function evaluateCapturePolicy(input: RecordRetrievalInput): CapturePolicyDecision {
	if (input.save === false) return { persist: false, code: null, message: null };
	if (input.scope.kind === "project") {
		return { persist: false, code: "POLICY_BLOCKED", message: "Project capture requires an explicit public source copy." };
	}
	const access = input.artifact === null ? input.access : input.artifact.access;
	if (isRestrictedAccess(access) && input.allowRestrictedThreadCapture !== true) {
		return { persist: false, code: "POLICY_BLOCKED", message: "Restricted thread capture is disabled." };
	}
	if (input.artifact !== null) {
		const urlPolicy = artifactUrlPolicy(input as Extract<RecordRetrievalInput, { artifact: object }>);
		if (urlPolicy === "sensitive") {
			return { persist: false, code: "POLICY_BLOCKED", message: "Capture was rejected by the sensitive URL policy." };
		}
		if (urlPolicy === "unverified") {
			return { persist: false, code: "POLICY_BLOCKED", message: `Capture contains more than ${URL_TOKEN_LIMIT} URL tokens, which is too many URL tokens to verify safely.` };
		}
	} else if (isSensitiveUrl(input.requestedUrl)) {
		return { persist: false, code: "POLICY_BLOCKED", message: "Capture was rejected by the sensitive URL policy." };
	}
	return { persist: true, code: null, message: null };
}

export interface OrphanReconciliationResult {
	deleted: string[];
	failed: Array<{ scopeKey: string; error: string }>;
}

export async function reconcileOrphanScopes(
	repository: SourceRepository,
	authority: (scope: SourceScope) => Promise<ScopeAuthorityResult>,
): Promise<OrphanReconciliationResult> {
	const result: OrphanReconciliationResult = { deleted: [], failed: [] };
	for await (const scope of repository.scopes()) {
		const key = sourceScopeKey(scope);
		try {
			const state = await authority(scope);
			if (state.status !== "missing") continue;
			await repository.deleteScope(scope);
			result.deleted.push(key);
		} catch (error) {
			result.failed.push({ scopeKey: key, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}
