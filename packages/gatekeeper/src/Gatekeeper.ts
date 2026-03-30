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
 * Blocked handles expose the intercepted downstream call metadata and can be
 * resumed with `allow()`, `mockReturnValue()`, or `fail()`.
 */
export interface Handle<T> {
	/** Whether the invocation has already resolved to a final value. */
	readonly resolved: boolean

	/** The blocked downstream service name, or `undefined` when resolved. */
	readonly service: string | undefined
	/** The blocked downstream method name, or `undefined` when resolved. */
	readonly method: string | undefined
	/** The blocked downstream call arguments, or `undefined` when resolved. */
	readonly args: unknown[] | undefined

	/** Returns the final value. Throws while the invocation is blocked. */
	unwrapValue(): T

	/** Forward the blocked downstream call to the real implementation. */
	allow(): Promise<Handle<T>>
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

function createDeferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"]
	let reject!: Deferred<T>["reject"]

	const promise = new Promise<T>((innerResolve, innerReject) => {
		resolve = innerResolve
		reject = innerReject
	})

	return { promise, resolve, reject }
}

/** Concrete handle for a completed invocation. */
class ResolvedHandle<T> implements Handle<T> {
	readonly resolved = true
	readonly service = undefined
	readonly method = undefined
	readonly args = undefined

	constructor(private readonly value: T) {}

	unwrapValue(): T {
		return this.value
	}

	allow(): Promise<Handle<T>> {
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
				service,
				method,
				args,
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
		readonly service: string,
		readonly method: string,
		readonly args: unknown[],
		private readonly callRealImplementation: () => Promise<unknown>,
		private readonly resolveBlockedCall: (value: unknown) => void,
		private readonly rejectBlockedCall: (reason: unknown) => void
	) {}

	unwrapValue(): T {
		throw new Error("Invocation is blocked on a downstream call")
	}

	allow(): Promise<Handle<T>> {
		return this.runOnce(async () => {
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
