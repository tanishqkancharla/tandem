import * as errore from "errore"

/** Maximum age or clock skew accepted for signed server-to-server requests. */
const signedRequestMaxSkewMs = 5 * 60_000

const encoder = new TextEncoder()

export type TandemSignaturePurpose = "bridge" | "invalidate" | "stats" | "token"

export class TandemAuthError extends errore.createTaggedError({
	name: "TandemAuthError",
	message: "Tandem authentication failed: $reason",
}) {}

function base64UrlEncode(bytes: Uint8Array) {
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")
}

function base64UrlDecode(text: string) {
	const padded = text.replaceAll("-", "+").replaceAll("_", "/")
	const binary = errore.try(() =>
		atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
	)
	if (binary instanceof Error) return binary
	return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function importKey(secret: string) {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	)
}

/** Each purpose signs a distinct message so one signature cannot be replayed as another. */
function signedMessage(purpose: TandemSignaturePurpose, parts: string[]) {
	return encoder.encode(["tandem", purpose, ...parts].join("\n"))
}

async function sign(
	secret: string,
	purpose: TandemSignaturePurpose,
	parts: string[],
) {
	const key = await importKey(secret)
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		signedMessage(purpose, parts),
	)
	return base64UrlEncode(new Uint8Array(signature))
}

async function verify(
	secret: string,
	purpose: TandemSignaturePurpose,
	parts: string[],
	signature: string,
) {
	const bytes = base64UrlDecode(signature)
	if (bytes instanceof Error) return false
	const key = await importKey(secret)
	return crypto.subtle.verify("HMAC", key, bytes, signedMessage(purpose, parts))
}

export type TandemClientTokenClaims = {
	appId: string
	/** Stable identity of the signed-in user or device. Scopes client IDs. */
	sub: string
	/** Expiry in milliseconds since the epoch. */
	exp: number
}

export async function createTandemClientToken(args: {
	appId: string
	secret: string
	subject: string
	/** @default 600_000 (10 minutes) */
	ttlMs?: number
	now?: number
}): Promise<string> {
	const claims: TandemClientTokenClaims = {
		appId: args.appId,
		sub: args.subject,
		exp: (args.now ?? Date.now()) + (args.ttlMs ?? 600_000),
	}
	const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)))
	return `${payload}.${await sign(args.secret, "token", [payload])}`
}

function isTokenClaims(value: unknown): value is TandemClientTokenClaims {
	if (typeof value !== "object" || value === null) return false
	const claims = value as Record<string, unknown>
	return (
		typeof claims.appId === "string" &&
		typeof claims.sub === "string" &&
		claims.sub.length > 0 &&
		claims.sub.length <= 256 &&
		typeof claims.exp === "number"
	)
}

export async function verifyTandemClientToken(args: {
	token: string
	appId: string
	secret: string
	now?: number
}): Promise<TandemClientTokenClaims | TandemAuthError> {
	const [payload, signature, ...rest] = args.token.split(".")
	if (!payload || !signature || rest.length) {
		return new TandemAuthError({ reason: "malformed token" })
	}
	const valid = await verify(args.secret, "token", [payload], signature)
	if (!valid) return new TandemAuthError({ reason: "invalid token signature" })

	const bytes = base64UrlDecode(payload)
	if (bytes instanceof Error) {
		return new TandemAuthError({ reason: "malformed token", cause: bytes })
	}
	const claims = errore.try(
		() => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
	)
	if (claims instanceof Error || !isTokenClaims(claims)) {
		return new TandemAuthError({ reason: "malformed token claims" })
	}
	if (claims.appId !== args.appId) {
		return new TandemAuthError({ reason: "token belongs to another app" })
	}
	if (claims.exp <= (args.now ?? Date.now())) {
		return new TandemAuthError({ reason: "token expired" })
	}
	return claims
}

export const tandemSignatureHeaders = {
	appId: "x-tandem-app",
	timestamp: "x-tandem-timestamp",
	signature: "x-tandem-signature",
} as const

/** Sign a server-to-server request body (bridge calls and invalidations). */
export async function signTandemRequest(args: {
	purpose: Exclude<TandemSignaturePurpose, "token">
	appId: string
	secret: string
	body: string
	now?: number
}): Promise<Record<string, string>> {
	const timestamp = String(args.now ?? Date.now())
	return {
		[tandemSignatureHeaders.appId]: args.appId,
		[tandemSignatureHeaders.timestamp]: timestamp,
		[tandemSignatureHeaders.signature]: await sign(args.secret, args.purpose, [
			args.appId,
			timestamp,
			args.body,
		]),
	}
}

export async function verifyTandemRequest(args: {
	purpose: Exclude<TandemSignaturePurpose, "token">
	appId: string
	secret: string
	headers: Headers
	body: string
	now?: number
}): Promise<TandemAuthError | undefined> {
	const appId = args.headers.get(tandemSignatureHeaders.appId)
	const timestamp = args.headers.get(tandemSignatureHeaders.timestamp)
	const signature = args.headers.get(tandemSignatureHeaders.signature)
	if (!appId || !timestamp || !signature) {
		return new TandemAuthError({ reason: "missing signature headers" })
	}
	if (appId !== args.appId) {
		return new TandemAuthError({ reason: "request belongs to another app" })
	}
	const sentAt = Number(timestamp)
	if (
		!Number.isFinite(sentAt) ||
		Math.abs((args.now ?? Date.now()) - sentAt) > signedRequestMaxSkewMs
	) {
		return new TandemAuthError({ reason: "stale request timestamp" })
	}
	const valid = await verify(
		args.secret,
		args.purpose,
		[appId, timestamp, args.body],
		signature,
	)
	if (!valid)
		return new TandemAuthError({ reason: "invalid request signature" })
}
