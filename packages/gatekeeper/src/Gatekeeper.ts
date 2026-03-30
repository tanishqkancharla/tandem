/**
 * Gatekeeper — a testing harness for intercepting service-to-service async calls.
 *
 * Builds an ordered, acyclic harness of async-method-only services.
 * Each built service method returns a thenable InvocationHandle that resolves
 * to a Handle. Tests can call `.next()` on the invocation handle to observe
 * blocked downstream calls and resolve them with gate controls.
 */

// ---- Public interfaces ------------------------------------------------------

/**
 * A handle representing a completed invocation's result.
 */
export interface Handle<T> {
	/** Whether the invocation has resolved to a final value. */
	readonly resolved: boolean

	/**
	 * Returns the resolved value. Throws if the invocation has not resolved yet.
	 */
	unwrapValue(): T

	/** The downstream service name, if blocked on a call. `undefined` if resolved. */
	readonly service: string | undefined
	/** The downstream method name, if blocked on a call. `undefined` if resolved. */
	readonly method: string | undefined
	/** The downstream call arguments, if blocked on a call. `undefined` if resolved. */
	readonly args: unknown[] | undefined
}

/**
 * Represents an intercepted downstream call that is blocked at a gate.
 * Tests use `allow()`, `mockReturnValue()`, or `fail()` to resolve it.
 */
export interface BlockedCallHandle {
	/** The downstream service name. */
	readonly service: string
	/** The downstream method name. */
	readonly method: string
	/** The arguments passed to the downstream call. */
	readonly args: unknown[]

	/** Forward the call to the real implementation and resolve the gate. */
	allow(): Promise<void>
	/** Resolve the gate with a mocked value, bypassing the real implementation. */
	mockReturnValue(value: unknown): void
	/** Reject the gate with the supplied error. */
	fail(error: Error): void
}

/**
 * A thenable invocation handle returned by harness service methods.
 * Awaiting it yields the final `Handle<T>` once the invocation completes.
 * Call `.next()` to observe blocked downstream calls.
 */
export interface InvocationHandle<T> extends PromiseLike<Handle<T>> {
	/**
	 * Returns the next blocked downstream call, or `undefined` if the
	 * invocation has settled with no further blocked calls.
	 */
	next(): Promise<BlockedCallHandle | undefined>
}

// ---- Internal helpers -------------------------------------------------------

/** Concrete resolved handle — the invocation completed with a value. */
class ResolvedHandle<T> implements Handle<T> {
	readonly resolved = true
	readonly service = undefined
	readonly method = undefined
	readonly args = undefined

	private _value: T

	constructor(value: T) {
		this._value = value
	}

	unwrapValue(): T {
		return this._value
	}
}

/** Internal implementation of a blocked downstream call with gate controls. */
class BlockedCallHandleImpl implements BlockedCallHandle {
	readonly service: string
	readonly method: string
	readonly args: unknown[]

	private _resolve: (value: unknown) => void
	private _reject: (error: unknown) => void
	private _realMethod: AsyncMethod
	private _realInstance: object
	private _settled = false

	constructor(
		service: string,
		method: string,
		args: unknown[],
		realMethod: AsyncMethod,
		realInstance: object,
		resolve: (value: unknown) => void,
		reject: (error: unknown) => void
	) {
		this.service = service
		this.method = method
		this.args = args
		this._realMethod = realMethod
		this._realInstance = realInstance
		this._resolve = resolve
		this._reject = reject
	}

	private _guard(): void {
		if (this._settled) {
			throw new Error("Blocked call has already been resolved")
		}
		this._settled = true
	}

	async allow(): Promise<void> {
		this._guard()
		try {
			const result = await this._realMethod.apply(this._realInstance, this.args)
			this._resolve(result)
		} catch (error) {
			this._reject(error)
		}
	}

	mockReturnValue(value: unknown): void {
		this._guard()
		this._resolve(value)
	}

	fail(error: Error): void {
		this._guard()
		this._reject(error)
	}
}

/** Internal implementation of the thenable invocation handle. */
class InvocationHandleImpl<T> implements InvocationHandle<T> {
	private _handlePromise!: Promise<Handle<T>>
	private _callQueue: BlockedCallHandleImpl[] = []
	private _callWaiter: ((call: BlockedCallHandleImpl | undefined) => void) | null = null
	private _settled = false

	/** Set the underlying result promise (called after construction so the
	 *  active-invocation reference is in place before the method executes). */
	_setResult(resultPromise: Promise<T>): void {
		this._handlePromise = resultPromise.then(
			(value) => {
				this._settled = true
				this._flushWaiter()
				return new ResolvedHandle(value)
			},
			(error) => {
				this._settled = true
				this._flushWaiter()
				throw error
			}
		)
		// Suppress unhandled-rejection warnings — callers attach their own handlers via then().
		this._handlePromise.catch(() => {})
	}

	/** Push an intercepted call from a dependency proxy. */
	_pushCall(call: BlockedCallHandleImpl): void {
		if (this._callWaiter) {
			const waiter = this._callWaiter
			this._callWaiter = null
			waiter(call)
		} else {
			this._callQueue.push(call)
		}
	}

	// -- PromiseLike ----------------------------------------------------------

	then<TResult1 = Handle<T>, TResult2 = never>(
		onfulfilled?: ((value: Handle<T>) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	): Promise<TResult1 | TResult2> {
		return this._handlePromise.then(onfulfilled, onrejected)
	}

	// -- InvocationHandle -----------------------------------------------------

	async next(): Promise<BlockedCallHandle | undefined> {
		// If there's already a queued call, return it immediately.
		if (this._callQueue.length > 0) {
			return this._callQueue.shift()!
		}
		// If the invocation has settled, no more calls are coming.
		if (this._settled) {
			return undefined
		}
		// Wait for either a new blocked call or the invocation to settle.
		return new Promise<BlockedCallHandle | undefined>((resolve) => {
			this._callWaiter = resolve as (call: BlockedCallHandleImpl | undefined) => void
			// Also race against the invocation settling without another call.
			this._handlePromise.then(
				() => {
					if (this._callWaiter === (resolve as unknown)) {
						this._callWaiter = null
						resolve(undefined)
					}
				},
				() => {
					if (this._callWaiter === (resolve as unknown)) {
						this._callWaiter = null
						resolve(undefined)
					}
				}
			)
		})
	}

	private _flushWaiter(): void {
		if (this._callWaiter) {
			const waiter = this._callWaiter
			this._callWaiter = null
			waiter(undefined)
		}
	}
}

// ---- Dependency proxy -------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncMethod = (...args: any[]) => Promise<any>

/**
 * Create a proxy object for a service that intercepts method calls and routes
 * them through the currently active invocation handle.
 */
function createDependencyProxy(
	serviceName: string,
	realInstance: object,
	getActiveInvocation: () => InvocationHandleImpl<unknown> | null
): object {
	const proxy: Record<string, unknown> = {}
	const proto = Object.getPrototypeOf(realInstance)

	for (const key of Object.getOwnPropertyNames(proto)) {
		if (key === "constructor") continue
		const realMethod = (realInstance as Record<string, AsyncMethod>)[key]
		if (typeof realMethod !== "function") continue

		proxy[key] = (...args: unknown[]): Promise<unknown> => {
			const invocation = getActiveInvocation()
			if (!invocation) {
				// No active invocation context — pass through directly.
				return realMethod.apply(realInstance, args)
			}

			return new Promise<unknown>((resolve, reject) => {
				const blocked = new BlockedCallHandleImpl(
					serviceName,
					key,
					args,
					realMethod,
					realInstance,
					resolve,
					reject
				)
				invocation._pushCall(blocked)
			})
		}
	}

	return proxy
}

// ---- Service type utilities -------------------------------------------------

/** Maps every async method of a service to return an InvocationHandle. */
type HandleWrapped<S> = {
	[K in keyof S]: S[K] extends (...args: infer A) => Promise<infer R>
		? (...args: A) => InvocationHandle<R>
		: never
}

// ---- Builder ----------------------------------------------------------------

type ServiceEntry = {
	name: string
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	factory: (deps: Record<string, any>) => object
}

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
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class Gatekeeper<TServices extends Record<string, object> = {}> {
	private entries: ServiceEntry[] = []

	/**
	 * Register a named service factory. Factories receive an object containing
	 * proxy-wrapped versions of all previously registered services.
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
	 * Build all registered services in order and return the harness.
	 * Each service method on the harness returns an `InvocationHandle<R>`.
	 */
	build(): { [K in keyof TServices]: HandleWrapped<TServices[K]> } {
		const realInstances: Record<string, object> = {}
		const proxiedDeps: Record<string, object> = {}
		const harness: Record<string, Record<string, unknown>> = {}

		// Shared mutable reference to the currently active invocation.
		let activeInvocation: InvocationHandleImpl<unknown> | null = null

		for (const entry of this.entries) {
			// Build the real service, passing proxied earlier services.
			const instance = entry.factory({ ...proxiedDeps })
			realInstances[entry.name] = instance

			// Create a dependency proxy for later services to consume.
			proxiedDeps[entry.name] = createDependencyProxy(
				entry.name,
				instance,
				() => activeInvocation
			)

			// Wrap every method so it returns an InvocationHandle.
			const wrapped: Record<string, unknown> = {}
			for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(instance))) {
				if (key === "constructor") continue
				const method = (instance as Record<string, AsyncMethod>)[key]
				if (typeof method === "function") {
					wrapped[key] = (...args: unknown[]): InvocationHandleImpl<unknown> => {
						const invocation = new InvocationHandleImpl<unknown>()
						activeInvocation = invocation
						const resultPromise = method.apply(instance, args)
						invocation._setResult(resultPromise)
						return invocation
					}
				}
			}

			harness[entry.name] = wrapped
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return harness as any
	}
}
