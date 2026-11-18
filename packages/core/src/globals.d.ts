// Globals that browsers, web workers, Node, Bun, Deno, Cloudflare Workers, and
// React Native all provide. Shared core may use only these and ECMAScript.
// Add one here only when every runtime above has it.

export {}

declare global {
	// Browsers return a number and Node a Timeout object.
	function setTimeout(callback: () => void, ms?: number): number | object
	function clearTimeout(id: number | object | undefined): void
	function setInterval(callback: () => void, ms?: number): number | object
	function clearInterval(id: number | object | undefined): void
	function queueMicrotask(callback: () => void): void
	function structuredClone<T>(value: T): T

	var console: Record<
		"debug" | "info" | "warn" | "log" | "error",
		(...data: unknown[]) => void
	>

	interface AbortSignal {
		readonly aborted: boolean
		addEventListener(
			type: "abort",
			listener: () => void,
			options?: { once?: boolean },
		): void
		removeEventListener(type: "abort", listener: () => void): void
	}

	var MessageChannel: new () => {
		readonly port1: TandemMessagePort
		readonly port2: TandemMessagePort
	}

	interface TandemMessagePort {
		addEventListener(type: "message", listener: () => void): void
		postMessage(message: unknown): void
		start(): void
		close(): void
	}
}
