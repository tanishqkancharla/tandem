/**
 * Gatekeeper — a testing harness for intercepting service-to-service async calls.
 *
 * Builds an ordered, acyclic harness of async-method-only services.
 * Each built service method returns a promise that resolves to a Handle.
 * The handle represents the invocation's current state: either resolved
 * (with a value) or blocked on a downstream service call (with gate controls).
 */

/**
 * A handle returned by awaiting a built service method call.
 *
 * When the invocation completed without any downstream calls, it is already
 * resolved and `.unwrapValue()` returns the return value.
 *
 * When the invocation is blocked on a downstream call (Phase 3+), the handle
 * exposes the target service, method, and args, plus gate controls like
 * `.allow()`, `.mockReturnValue()`, and `.fail()`.
 */
export interface Handle<T> {
	/** Whether the invocation has resolved to a final value. */
	readonly resolved: boolean

	/**
	 * Returns the resolved value. Throws if the invocation has not resolved yet
	 * (blocked on a downstream call that hasn't been resolved yet).
	 */
	unwrapValue(): T

	/** The downstream service name, if blocked on a call. `undefined` if resolved. */
	readonly service: string | undefined
	/** The downstream method name, if blocked on a call. `undefined` if resolved. */
	readonly method: string | undefined
	/** The downstream call arguments, if blocked on a call. `undefined` if resolved. */
	readonly args: unknown[] | undefined
}

// ---- Internal helpers -------------------------------------------------------

/** Concrete resolved handle — the invocation completed with no downstream calls. */
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

// ---- Service type utilities -------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncMethod = (...args: any[]) => Promise<any>

/** Maps every async method of a service to return a Promise<Handle<R>>. */
type HandleWrapped<S> = {
	[K in keyof S]: S[K] extends (...args: infer A) => Promise<infer R>
		? (...args: A) => Promise<Handle<R>>
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
	 * all previously registered services (in Phase 2 these are the real
	 * instances; proxy wrapping is added in Phase 3).
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
	 * Each service method on the harness returns a `Promise<Handle<R>>`.
	 */
	build(): { [K in keyof TServices]: HandleWrapped<TServices[K]> } {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const instances: Record<string, any> = {}
		const harness: Record<string, Record<string, unknown>> = {}

		for (const entry of this.entries) {
			// Build the real service instance, passing previously built instances.
			const instance = entry.factory(instances)
			instances[entry.name] = instance

			// Wrap every method so it returns a Promise<Handle>.
			const wrapped: Record<string, unknown> = {}
			for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(instance))) {
				if (key === "constructor") continue
				const method = (instance as Record<string, AsyncMethod>)[key]
				if (typeof method === "function") {
					wrapped[key] = async (...args: unknown[]): Promise<Handle<unknown>> => {
						const result = await method.apply(instance, args)
						return new ResolvedHandle(result)
					}
				}
			}

			harness[entry.name] = wrapped
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return harness as any
	}
}
