// Query names that mark a URL as credential-bearing, for both the capture policy
// (never persist the URL) and the remote-reader gate (never forward it). Exact,
// case-insensitive matches on decoded names: both gates block rather than redact,
// so a substring rule on "key" would also reject benign ?keyword= URLs.
export const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
	"token", "key", "secret", "signature", "sig", "auth", "access_token", "code", "session",
	"api_key", "apikey", "api-key", "client_secret", "refresh_token", "id_token", "session_id",
	"password", "passwd", "private_key", "secret_key", "access_key", "app_token",
	"x-amz-signature", "x-amz-credential", "x-goog-signature", "x-goog-signatures",
]);

export function isSensitiveQueryName(name: string): boolean {
	return SENSITIVE_QUERY_KEYS.has(name.toLowerCase());
}
