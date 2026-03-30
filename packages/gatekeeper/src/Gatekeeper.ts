import { isEqual } from "lodash-es"

/**
 * Gatekeeper — a testing harness for intercepting service-to-service async calls.
 *
 * Builds an ordered, acyclic harness of async-method-only services.
 * When a harness method is awaited, it resolves with a handle for the first
 * observable state transition of that invocation:
 * - a resolved handle if the invocation completed without blocking downstream
 * - a blocked handle if it suspended on a downstream service call
 */

// ---- Public interfaces ------------------------------------------------------

/**
 * A handle for a top-level invocation.
 *
 * Resolved handles expose the final value via `unwrapValue()`.
 * Blocked handles keep the intercepted downstream call internal and can be
 * asserted/resumed with `expectRequest()`, `allowRequest()`,
 * `mockReturnValue()`, or `fail()`.
 */
export type RequestMatcher = {
	to: string | "*"
	method: string | "*"
	args: unknown[] | "*"
}

export interface Handle<T> {
	/** Whether the invocation has already resolved to a final value. */
	readonly resolved: boolean

	/** Returns the final value. Throws while the invocation is blocked. */
	unwrapValue(): T

	/** Assert the currently blocked downstream request without unblocking it. */
	expectRequest(matcher: RequestMatcher): void
	/** Forward the blocked downstream call to the real implementation. */
	allowRequest(matcher: RequestMatcher): Promise<Handle<T>>
	/** Resolve the blocked downstream call with a mocked value. */
	mockReturnValue(value: unknown): Promise<Handle<T>>
	/** Reject the blocked downstream call with the supplied error. */
	fail(error: Error): Promise<Handle<T>>
}

// ---- Internal helpers -------------------------------------------------------

type AsyncMethod = (...args: any[]) => Promise<any>

type Deferred<T> = {
	promise: Promise<T>
	resolve: (value: T | PromiseLike<T>) => void
	reject: (reason?: unknown) => void
}

type BlockedRequest = {
	to: string
	method: string
	args: unknown[]
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"]
	let reject!: Deferred<T>["reject"]

	const promise = new Promise<T>((innerResolve, innerReject) => {
		resolve = innerResolve
		reject = innerReject
	})

	return { promise, resolve, reject }
}

function matchesRequest(
	request: BlockedRequest,
	matcher: RequestMatcher
): boolean {
	return (
		(matcher.to === "*" || matcher.to === request.to) &&
		(matcher.method === "*" || matcher.method === request.method) &&
		(matcher.args === "*" || isEqual(matcher.args, request.args))
	)
}

function stringifyForError(value: unknown): string {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function assertRequestMatches(
	request: BlockedRequest,
	matcher: RequestMatcher
): void {
	if (matchesRequest(request, matcher)) {
		return
	}

	throw new Error(
		`Blocked request did not match matcher. Expected ${stringifyForError(
			matcher
		)}, received ${stringifyForError(request)}`
	)
}

/** Concrete handle for a completed invocation. */
class ResolvedHandle<T> implements Handle<T> {
	readonly resolved = true

	constructor(private readonly value: T) {}

	unwrapValue(): T {
		return this.value
	}

	expectRequest(_matcher: RequestMatcher): void {
		throw new Error("Invocation is already resolved")
	}

	allowRequest(_matcher: RequestMatcher): Promise<Handle<T>> {
		return Promise.reject(new Error("Invocation is already resolved"))
	}

	mockReturnValue(_value: unknown): Promise<Handle<T>> {
		return Promise.reject(new Error("Invocation is already resolved"))
	}

	fail(_error: Error): Promise<Handle<T>> {
		return Promise.reject(new Error("Invocation is already resolved"))
	}
}

class InvocationController<T> {
	private nextHandle = createDeferred<Handle<T>>()
	private activeBlockedHandle: BlockedHandle<T> | null = null

	constructor(private readonly onSettled: () => void) {
		this.nextHandle.promise.catch(() => {})
	}

	observe(): Promise<Handle<T>> {
		return this.nextHandle.promise
	}

	start(run: () => Promise<T>): void {
		Promise.resolve()
			.then(run)
			.then(
				(value) => {
					this.nextHandle.resolve(new ResolvedHandle(value))
					this.onSettled()
				},
				(error) => {
					this.nextHandle.reject(error)
					this.onSettled()
				}
			)
	}

	blockOnCall(
		service: string,
		method: string,
		args: unknown[],
		callRealImplementation: () => Promise<unknown>
	): Promise<unknown> {
		if (this.activeBlockedHandle) {
			return Promise.reject(
				new Error("Concurrent blocked downstream calls are not supported")
			)
		}

		return new Promise<unknown>((resolve, reject) => {
			const blockedHandle = new BlockedHandle(
				this,
				{ to: service, method, args },
				callRealImplementation,
				resolve,
				reject
			)

			this.activeBlockedHandle = blockedHandle
			this.nextHandle.resolve(blockedHandle)
		})
	}

	prepareForResume(blockedHandle: BlockedHandle<T>): Promise<Handle<T>> {
		if (this.activeBlockedHandle !== blockedHandle) {
			return Promise.reject(new Error("Blocked call is already resolved"))
		}

		this.activeBlockedHandle = null
		this.nextHandle = createDeferred<Handle<T>>()
		this.nextHandle.promise.catch(() => {})
		return this.nextHandle.promise
	}
}

/** Concrete handle for an invocation blocked on a downstream call. */
class BlockedHandle<T> implements Handle<T> {
	readonly resolved = false

	private alreadyResolved = false

	constructor(
		private readonly invocation: InvocationController<T>,
		private readonly request: BlockedRequest,
		private readonly callRealImplementation: () => Promise<unknown>,
		private readonly resolveBlockedCall: (value: unknown) => void,
		private readonly rejectBlockedCall: (reason: unknown) => void
	) {}

	unwrapValue(): T {
		throw new Error("Invocation is blocked on a downstream call")
	}

	expectRequest(matcher: RequestMatcher): void {
		assertRequestMatches(this.request, matcher)
	}

	async allowRequest(matcher: RequestMatcher): Promise<Handle<T>> {
		assertRequestMatches(this.request, matcher)

		return await this.runOnce(async () => {
			const nextHandle = this.invocation.prepareForResume(this)

			try {
				this.resolveBlockedCall(await this.callRealImplementation())
			} catch (error) {
				this.rejectBlockedCall(error)
			}

			return await nextHandle
		})
	}

	mockReturnValue(value: unknown): Promise<Handle<T>> {
		return this.runOnce(async () => {
			const nextHandle = this.invocation.prepareForResume(this)
			this.resolveBlockedCall(value)
			return await nextHandle
		})
	}

	fail(error: Error): Promise<Handle<T>> {
		return this.runOnce(async () => {
			const nextHandle = this.invocation.prepareForResume(this)
			this.rejectBlockedCall(error)
			return await nextHandle
		})
	}

	private runOnce(action: () => Promise<Handle<T>>): Promise<Handle<T>> {
		if (this.alreadyResolved) {
			return Promise.reject(new Error("Blocked call is already resolved"))
		}

		this.alreadyResolved = true
		return action()
	}
}

// ---- Dependency proxy -------------------------------------------------------

/**
 * Create a proxy object for a service that intercepts method calls and routes
 * them through the currently active top-level invocation.
 */
function createDependencyProxy(
	serviceName: string,
	realInstance: object,
	getActiveInvocation: () => InvocationController<unknown> | null
): object {
	const proxy: Record<string, unknown> = {}
	const prototype = Object.getPrototypeOf(realInstance)

	for (const key of Object.getOwnPropertyNames(prototype)) {
		if (key === "constructor") continue

		const realMethod = (realInstance as Record<string, AsyncMethod>)[key]
		if (typeof realMethod !== "function") continue

		proxy[key] = (...args: unknown[]): Promise<unknown> => {
			const activeInvocation = getActiveInvocation()
			if (!activeInvocation) {
				return realMethod.apply(realInstance, args)
			}

			return activeInvocation.blockOnCall(serviceName, key, args, () =>
				realMethod.apply(realInstance, args)
			)
		}
	}

	return proxy
}

// ---- Service type utilities -------------------------------------------------

/** Maps every async method of a service to return a handle promise. */
type HandleWrapped<S> = {
	[K in keyof S]: S[K] extends (...args: infer A) => Promise<infer R>
		? (...args: A) => Promise<Handle<R>>
		: never
}

type ServiceEntry = {
	name: string
	factory: (deps: Record<string, any>) => object
}

// ---- Builder ----------------------------------------------------------------

/**
 * Builder for an ordered, acyclic service harness.
 *
 * ```ts
 * const harness = new Gatekeeper()
 *   .add("server", () => new Server())
 *   .add("client", ({ server }) => new Client(server))
 *   .build()
 * ```
 */
export class Gatekeeper<TServices extends Record<string, object> = {}> {
	private entries: ServiceEntry[] = []

	/**
	 * Register a named service factory. Factories receive proxy-wrapped versions
	 * of all previously registered services.
	 */
	add<Name extends string, S extends object>(
		name: Name,
		factory: (deps: TServices) => S
	): Gatekeeper<TServices & Record<Name, S>> {
		const next = new Gatekeeper<TServices & Record<Name, S>>()
		next.entries = [...this.entries, { name, factory: factory as ServiceEntry["factory"] }]
		return next
	}

	/**
	 * Build all registered services in order.
	 * Harness methods resolve to a handle when the invocation either completes or
	 * blocks on the next intercepted downstream call.
	 */
	build(): { [K in keyof TServices]: HandleWrapped<TServices[K]> } {
		const proxiedDependencies: Record<string, object> = {}
		const harness: Record<string, Record<string, unknown>> = {}

		let activeInvocation: InvocationController<unknown> | null = null

		for (const entry of this.entries) {
			const instance = entry.factory({ ...proxiedDependencies })

			proxiedDependencies[entry.name] = createDependencyProxy(
				entry.name,
				instance,
				() => activeInvocation
			)

			const wrappedService: Record<string, unknown> = {}
			const prototype = Object.getPrototypeOf(instance)

			for (const key of Object.getOwnPropertyNames(prototype)) {
				if (key === "constructor") continue

				const method = (instance as Record<string, AsyncMethod>)[key]
				if (typeof method !== "function") continue

				wrappedService[key] = (...args: unknown[]): Promise<Handle<unknown>> => {
					const invocation = new InvocationController<unknown>(() => {
						if (activeInvocation === invocation) {
							activeInvocation = null
						}
					})

					activeInvocation = invocation
					invocation.start(() => method.apply(instance, args))
					return invocation.observe()
				}
			}

			harness[entry.name] = wrappedService
		}

		return harness as any
	}
}
