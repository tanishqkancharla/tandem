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

type AsyncMethod = (...args: any[]) => Promise<any>
type ServiceMap = Record<string, object>
type UnknownServices = Record<string, { [method: string]: AsyncMethod }>

type AsyncMethodKeys<TService extends object> = Extract<
	{
		[K in keyof TService]: TService[K] extends AsyncMethod ? K : never
	}[keyof TService],
	string
>

type AsyncMethodArgs<
	TService extends object,
	TMethod extends AsyncMethodKeys<TService>,
> = TService[TMethod] extends (...args: infer A) => Promise<any> ? A : never

type ServiceNames<TServices extends ServiceMap> = Extract<keyof TServices, string>

type ServiceMethodNames<TServices extends ServiceMap> = Extract<
	{
		[TService in ServiceNames<TServices>]: AsyncMethodKeys<TServices[TService]>
	}[ServiceNames<TServices>],
	string
>

type ServiceRequestMatcher<
	TServices extends ServiceMap,
	TServiceName extends ServiceNames<TServices>,
> =
	| {
			to: TServiceName
			method: "*"
			args: unknown[] | "*"
	  }
	| {
			[TMethod in AsyncMethodKeys<TServices[TServiceName]>]: {
				to: TServiceName
				method: TMethod
				args: AsyncMethodArgs<TServices[TServiceName], TMethod> | "*"
			}
	  }[AsyncMethodKeys<TServices[TServiceName]>]

// ---- Public interfaces ------------------------------------------------------

/**
 * A handle for a top-level invocation.
 *
 * Resolved handles expose the final value via `unwrapValue()`.
 * Blocked handles keep the intercepted downstream call internal and can be
 * asserted/resumed with `expectRequest()`, `allowRequest()`,
 * `mockReturnValue()`, or `fail()`.
 */
export type RequestMatcher<TServices extends ServiceMap = UnknownServices> =
	| {
			to: "*"
			method: ServiceMethodNames<TServices> | "*"
			args: unknown[] | "*"
	  }
	| {
			[TServiceName in ServiceNames<TServices>]: ServiceRequestMatcher<
				TServices,
				TServiceName
			>
	  }[ServiceNames<TServices>]

export interface Handle<T, TServices extends ServiceMap = UnknownServices> {
	/** Whether the invocation has already resolved to a final value. */
	readonly resolved: boolean

	/** Returns the final value. Throws while the invocation is blocked. */
	unwrapValue(): T

	/** Assert the currently blocked downstream request without unblocking it. */
	expectRequest(matcher: RequestMatcher<TServices>): void
	/** Forward the blocked downstream call to the real implementation. */
	allowRequest(matcher: RequestMatcher<TServices>): Promise<Handle<T, TServices>>
	/** Resolve the blocked downstream call with a mocked value. */
	mockReturnValue(value: unknown): Promise<Handle<T, TServices>>
	/** Reject the blocked downstream call with the supplied error. */
	fail(error: Error): Promise<Handle<T, TServices>>
}

// ---- Internal helpers -------------------------------------------------------

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

type LooseRequestMatcher = {
	to: string | "*"
	method: string | "*"
	args: unknown[] | "*"
}

const CONCURRENT_BLOCKED_CALLS_ERROR =
	"Gatekeeper v1 only supports serial downstream calls; concurrent blocked downstream calls are not supported"

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
	matcher: LooseRequestMatcher
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
	matcher: LooseRequestMatcher
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
class ResolvedHandle<T, TServices extends ServiceMap>
	implements Handle<T, TServices>
{
	readonly resolved = true

	constructor(private readonly value: T) {}

	unwrapValue(): T {
		return this.value
	}

	expectRequest(_matcher: RequestMatcher<TServices>): void {
		throw new Error("Invocation is already resolved")
	}

	allowRequest(_matcher: RequestMatcher<TServices>): Promise<Handle<T, TServices>> {
		return Promise.reject(new Error("Invocation is already resolved"))
	}

	mockReturnValue(_value: unknown): Promise<Handle<T, TServices>> {
		return Promise.reject(new Error("Invocation is already resolved"))
	}

	fail(_error: Error): Promise<Handle<T, TServices>> {
		return Promise.reject(new Error("Invocation is already resolved"))
	}
}

class InvocationController<T, TServices extends ServiceMap> {
	private nextHandle = createDeferred<Handle<T, TServices>>()
	private activeBlockedHandle: BlockedHandle<T, TServices> | null = null
	private blockedWhileSettledReason: unknown = null

	constructor(private readonly onSettled: () => void) {
		this.nextHandle.promise.catch(() => {})
	}

	observe(): Promise<Handle<T, TServices>> {
		return this.nextHandle.promise
	}

	start(run: () => Promise<T>): void {
		Promise.resolve()
			.then(run)
			.then(
				(value) => {
					this.nextHandle.resolve(new ResolvedHandle<T, TServices>(value))
					this.onSettled()
				},
				(error) => {
					if (this.activeBlockedHandle) {
						this.blockedWhileSettledReason = error
					} else {
						this.nextHandle.reject(error)
					}
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
			this.blockedWhileSettledReason ??= new Error(CONCURRENT_BLOCKED_CALLS_ERROR)

			return Promise.reject(
				this.blockedWhileSettledReason
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

	prepareForResume(
		blockedHandle: BlockedHandle<T, TServices>
	): Promise<Handle<T, TServices>> {
		if (this.activeBlockedHandle !== blockedHandle) {
			throw new Error("Blocked call is already resolved")
		}

		if (this.blockedWhileSettledReason !== null) {
			const reason = this.blockedWhileSettledReason
			this.blockedWhileSettledReason = null
			this.activeBlockedHandle = null
			throw reason
		}

		this.activeBlockedHandle = null
		this.nextHandle = createDeferred<Handle<T, TServices>>()
		this.nextHandle.promise.catch(() => {})
		return this.nextHandle.promise
	}
}

/** Concrete handle for an invocation blocked on a downstream call. */
class BlockedHandle<T, TServices extends ServiceMap>
	implements Handle<T, TServices>
{
	readonly resolved = false

	private alreadyResolved = false

	constructor(
		private readonly invocation: InvocationController<T, TServices>,
		private readonly request: BlockedRequest,
		private readonly callRealImplementation: () => Promise<unknown>,
		private readonly resolveBlockedCall: (value: unknown) => void,
		private readonly rejectBlockedCall: (reason: unknown) => void
	) {}

	unwrapValue(): T {
		throw new Error("Invocation is blocked on a downstream call")
	}

	expectRequest(matcher: RequestMatcher<TServices>): void {
		assertRequestMatches(this.request, matcher)
	}

	async allowRequest(
		matcher: RequestMatcher<TServices>
	): Promise<Handle<T, TServices>> {
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

	mockReturnValue(value: unknown): Promise<Handle<T, TServices>> {
		return this.runOnce(async () => {
			const nextHandle = this.invocation.prepareForResume(this)
			this.resolveBlockedCall(value)
			return await nextHandle
		})
	}

	fail(error: Error): Promise<Handle<T, TServices>> {
		return this.runOnce(async () => {
			const nextHandle = this.invocation.prepareForResume(this)
			this.rejectBlockedCall(error)
			return await nextHandle
		})
	}

	private runOnce(
		action: () => Promise<Handle<T, TServices>>,
	): Promise<Handle<T, TServices>> {
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
function createDependencyProxy<TServices extends ServiceMap>(
	serviceName: string,
	realInstance: object,
	getActiveInvocation: () => InvocationController<unknown, TServices> | null
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
type HandleWrapped<TServices extends ServiceMap, S> = {
	[K in keyof S]: S[K] extends (...args: infer A) => Promise<infer R>
		? (...args: A) => Promise<Handle<R, TServices>>
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
	build(): { [K in keyof TServices]: HandleWrapped<TServices, TServices[K]> } {
		const proxiedDependencies: Record<string, object> = {}
		const harness: Record<string, Record<string, unknown>> = {}

		let activeInvocation: InvocationController<unknown, TServices> | null = null

		for (const entry of this.entries) {
			const instance = entry.factory({ ...proxiedDependencies })

			proxiedDependencies[entry.name] = createDependencyProxy<TServices>(
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

				wrappedService[key] = (
					...args: unknown[]
				): Promise<Handle<unknown, TServices>> => {
					const invocation = new InvocationController<unknown, TServices>(
						() => {
							if (activeInvocation === invocation) {
								activeInvocation = null
							}
						},
					)

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
