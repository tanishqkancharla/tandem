import { AsyncLocalStorage } from "node:async_hooks"
import { isEqual } from "lodash-es"

/**
 * Gatekeeper — a testing harness for intercepting service-to-service async calls.
 *
 * Builds an ordered, acyclic harness of services.
 * Promise-returning methods are intercepted and surface handles, while sync
 * methods and non-function properties stay usable as-is.
 *
 * When a harness async method is awaited, it resolves with a handle for the
 * first observable state transition of that invocation:
 * - a resolved handle if the invocation completed without blocking downstream
 * - a blocked handle if it suspended on a downstream service call
 */

type AsyncMethod = (...args: any[]) => Promise<any>
type ServiceMap = Record<string, object>
type UnknownServices = Record<string, object>

type Primitive = string | number | boolean | bigint | symbol | null | undefined
type OpaqueValue =
	| Primitive
	| Promise<any>
	| readonly any[]
	| Date
	| RegExp
	| Error
	| Map<any, any>
	| ReadonlyMap<any, any>
	| Set<any>
	| ReadonlySet<any>
	| WeakMap<object, any>
	| WeakSet<object>

type AsyncMethodPaths<TService extends object> = Extract<
	{
		[K in Extract<keyof TService, string>]: TService[K] extends AsyncMethod
			? K
			: TService[K] extends OpaqueValue
				? never
				: TService[K] extends object
					? {
							[NestedKey in Extract<
								keyof TService[K],
								string
							>]: TService[K][NestedKey] extends AsyncMethod
								? `${K}.${NestedKey}`
								: never
						}[Extract<keyof TService[K], string>]
					: never
	}[Extract<keyof TService, string>],
	string
>

type AsyncMethodArgsByPath<
	TService extends object,
	TPath extends AsyncMethodPaths<TService>,
> = TPath extends `${infer TParent}.${infer TMethod}`
	? TParent extends keyof TService
		? TMethod extends keyof TService[TParent]
			? TService[TParent][TMethod] extends (...args: infer A) => Promise<any>
				? A
				: never
			: never
		: never
	: TPath extends keyof TService
		? TService[TPath] extends (...args: infer A) => Promise<any>
			? A
			: never
		: never

type ServiceNames<TServices extends ServiceMap> = Extract<
	keyof TServices,
	string
>

type ServiceMethodNames<TServices extends ServiceMap> = Extract<
	{
		[TService in ServiceNames<TServices>]: AsyncMethodPaths<TServices[TService]>
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
			[TMethod in AsyncMethodPaths<TServices[TServiceName]>]: {
				to: TServiceName
				method: TMethod
				args: AsyncMethodArgsByPath<TServices[TServiceName], TMethod> | "*"
			}
	  }[AsyncMethodPaths<TServices[TServiceName]>]

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
	allowRequest(
		matcher: RequestMatcher<TServices>,
	): Promise<Handle<T, TServices>>
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
	matcher: LooseRequestMatcher,
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
	matcher: LooseRequestMatcher,
): void {
	if (matchesRequest(request, matcher)) {
		return
	}

	throw new Error(
		`Blocked request did not match matcher. Expected ${stringifyForError(
			matcher,
		)}, received ${stringifyForError(request)}`,
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

	allowRequest(
		_matcher: RequestMatcher<TServices>,
	): Promise<Handle<T, TServices>> {
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
	private settled = false

	constructor(private readonly onSettled: () => void) {
		this.nextHandle.promise.catch(() => {})
	}

	observe(): Promise<Handle<T, TServices>> {
		return this.nextHandle.promise
	}

	/**
	 * Mark the invocation as settled. If no blocked handle is active, clean up
	 * immediately. Otherwise defer cleanup until the blocked handle is resolved
	 * via prepareForResume().
	 */
	private markSettled(): void {
		this.settled = true
		if (!this.activeBlockedHandle) {
			this.onSettled()
		}
	}

	track(result: PromiseLike<T>): void {
		Promise.resolve(result).then(
			(value) => {
				this.nextHandle.resolve(new ResolvedHandle<T, TServices>(value))
				this.markSettled()
			},
			(error) => {
				if (this.activeBlockedHandle) {
					this.blockedWhileSettledReason = error
				} else {
					this.nextHandle.reject(error)
				}
				this.markSettled()
			},
		)
	}

	blockOnCall(
		service: string,
		method: string,
		args: unknown[],
		callRealImplementation: () => Promise<unknown>,
		getInvocation: () => InvocationController<T, TServices>,
		resumeInContext: <R>(fn: () => R) => R,
	): Promise<unknown> {
		let blockedCallPromise: Promise<unknown> | null = null

		const ensureBlocked = (): Promise<unknown> => {
			if (blockedCallPromise) {
				return blockedCallPromise
			}

			if (this.activeBlockedHandle) {
				this.blockedWhileSettledReason ??= new Error(
					CONCURRENT_BLOCKED_CALLS_ERROR,
				)

				blockedCallPromise = Promise.reject(this.blockedWhileSettledReason)
				blockedCallPromise.catch(() => {})
				return blockedCallPromise
			}

			const deferred = createDeferred<unknown>()
			deferred.promise.catch(() => {})

			const blockedHandle = new BlockedHandle(
				getInvocation,
				resumeInContext,
				{ to: service, method, args },
				callRealImplementation,
				deferred.resolve,
				deferred.reject,
			)

			this.activeBlockedHandle = blockedHandle
			this.nextHandle.resolve(blockedHandle)
			blockedCallPromise = deferred.promise
			return blockedCallPromise
		}

		return {
			then: (onFulfilled, onRejected) =>
				ensureBlocked().then(onFulfilled, onRejected),
			catch: (onRejected) => ensureBlocked().catch(onRejected),
			finally: (onFinally) => ensureBlocked().finally(onFinally),
			[Symbol.toStringTag]: "Promise",
		} as Promise<unknown>
	}

	prepareForResume(
		blockedHandle: BlockedHandle<T, TServices>,
	): Promise<Handle<T, TServices>> {
		if (this.activeBlockedHandle !== blockedHandle) {
			throw new Error("Blocked call is already resolved")
		}

		if (this.blockedWhileSettledReason !== null) {
			const reason = this.blockedWhileSettledReason
			this.blockedWhileSettledReason = null
			this.activeBlockedHandle = null
			if (this.settled) this.onSettled()
			throw reason
		}

		this.activeBlockedHandle = null
		if (this.settled) this.onSettled()
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
		private readonly getInvocation: () => InvocationController<T, TServices>,
		private readonly resumeInContext: <R>(fn: () => R) => R,
		private readonly request: BlockedRequest,
		private readonly callRealImplementation: () => Promise<unknown>,
		private readonly resolveBlockedCall: (value: unknown) => void,
		private readonly rejectBlockedCall: (reason: unknown) => void,
	) {}

	unwrapValue(): T {
		throw new Error("Invocation is blocked on a downstream call")
	}

	expectRequest(matcher: RequestMatcher<TServices>): void {
		assertRequestMatches(this.request, matcher)
	}

	async allowRequest(
		matcher: RequestMatcher<TServices>,
	): Promise<Handle<T, TServices>> {
		assertRequestMatches(this.request, matcher)

		return await this.runOnce(async () => {
			const invocation = this.getInvocation()
			const nextHandle = invocation.prepareForResume(this)

			await this.resumeInContext(async () => {
				try {
					this.resolveBlockedCall(await this.callRealImplementation())
				} catch (error) {
					this.rejectBlockedCall(error)
				}
			})

			return await nextHandle
		})
	}

	mockReturnValue(value: unknown): Promise<Handle<T, TServices>> {
		return this.runOnce(async () => {
			const invocation = this.getInvocation()
			const nextHandle = invocation.prepareForResume(this)
			this.resumeInContext(() => this.resolveBlockedCall(value))
			return await nextHandle
		})
	}

	fail(error: Error): Promise<Handle<T, TServices>> {
		return this.runOnce(async () => {
			const invocation = this.getInvocation()
			const nextHandle = invocation.prepareForResume(this)
			this.resumeInContext(() => this.rejectBlockedCall(error))
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

// ---- Proxy helpers ----------------------------------------------------------

type SyncMethod = (...args: any[]) => any
type ObjectProxyCache = WeakMap<object, object>
type PathProxyCache = WeakMap<object, Map<string, object>>

function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as PromiseLike<T>).then === "function"
	)
}

function shouldProxyObject(value: unknown): value is object {
	return (
		typeof value === "object" &&
		value !== null &&
		!isPromiseLike(value) &&
		!Array.isArray(value) &&
		!(value instanceof Date) &&
		!(value instanceof RegExp) &&
		!(value instanceof Error) &&
		!(value instanceof Map) &&
		!(value instanceof Set) &&
		!(value instanceof WeakMap) &&
		!(value instanceof WeakSet)
	)
}

function getPathCachedProxy(
	cache: PathProxyCache,
	target: object,
	path: readonly string[],
): object | undefined {
	return cache.get(target)?.get(path.join("."))
}

function setPathCachedProxy(
	cache: PathProxyCache,
	target: object,
	path: readonly string[],
	proxy: object,
): object {
	const pathKey = path.join(".")
	const existing = cache.get(target)
	if (existing) {
		existing.set(pathKey, proxy)
		return proxy
	}

	cache.set(target, new Map([[pathKey, proxy]]))
	return proxy
}

/**
 * Create a proxy object for a service that intercepts method calls and routes
 * them through the currently active top-level invocation.
 */
function createDependencyProxy<TServices extends ServiceMap>(
	serviceName: string,
	realInstance: object,
	getCurrentInvocation: () => InvocationController<unknown, TServices> | null,
	createBoundInvocationLookup: () => {
		getInvocation: () => InvocationController<unknown, TServices>
		resumeInContext: <R>(fn: () => R) => R
	},
	shouldBypassInterception: () => boolean,
	path: readonly string[] = [],
	cache: PathProxyCache = new WeakMap(),
): object {
	const existing = getPathCachedProxy(cache, realInstance, path)
	if (existing) {
		return existing
	}

	const proxy = new Proxy(realInstance, {
		get(target, property) {
			if (typeof property !== "string" || property === "constructor") {
				return Reflect.get(target, property, target)
			}

			const value = Reflect.get(target, property, target)
			if (typeof value === "function") {
				const method = value as SyncMethod
				const methodPath = [...path, property]

				return (...args: unknown[]): Promise<unknown> => {
					if (shouldBypassInterception()) {
						return method.apply(target, args)
					}

					const currentInvocation = getCurrentInvocation()
					if (!currentInvocation) {
						return method.apply(target, args)
					}

					const bound = createBoundInvocationLookup()
					return currentInvocation.blockOnCall(
						serviceName,
						methodPath.join("."),
						args,
						() => Promise.resolve(method.apply(target, args)),
						bound.getInvocation,
						bound.resumeInContext,
					)
				}
			}

			if (shouldProxyObject(value)) {
				return createDependencyProxy<TServices>(
					serviceName,
					value,
					getCurrentInvocation,
					createBoundInvocationLookup,
					shouldBypassInterception,
					[...path, property],
					cache,
				)
			}

			return value
		},
	})

	return setPathCachedProxy(cache, realInstance, path, proxy)
}

function createHarnessServiceProxy<TServices extends ServiceMap>(
	realInstance: object,
	startInvocation: (run: () => unknown) => unknown,
	shouldBypassInterception: () => boolean,
	cache: ObjectProxyCache = new WeakMap(),
): object {
	const existing = cache.get(realInstance)
	if (existing) {
		return existing
	}

	const proxy = new Proxy(realInstance, {
		get(target, property) {
			if (typeof property !== "string" || property === "constructor") {
				return Reflect.get(target, property, target)
			}

			const value = Reflect.get(target, property, target)
			if (typeof value === "function") {
				const method = value as SyncMethod
				return (...args: unknown[]): unknown => {
					if (shouldBypassInterception()) {
						return method.apply(target, args)
					}

					return startInvocation(() => method.apply(target, args))
				}
			}

			if (shouldProxyObject(value)) {
				return createHarnessServiceProxy<TServices>(
					value,
					startInvocation,
					shouldBypassInterception,
					cache,
				)
			}

			return value
		},
	})

	cache.set(realInstance, proxy)
	return proxy
}

// ---- Service type utilities -------------------------------------------------

type GatekeeperValue<TServices extends ServiceMap, TValue> = TValue extends (
	...args: infer A
) => Promise<infer R>
	? (...args: A) => Promise<Handle<R, TServices>>
	: TValue extends (...args: infer A) => infer R
		? (...args: A) => R
		: TValue extends OpaqueValue
			? TValue
			: TValue extends object
				? {
						[K in keyof TValue]: GatekeeperValue<TServices, TValue[K]>
					}
				: TValue

/** Maps every promise-returning method of a service to a handle promise. */
export type GatekeeperProxy<TServices extends ServiceMap, S> = GatekeeperValue<
	TServices,
	S
>

type ServiceEntry = {
	name: string
	factory: (deps: Record<string, any>) => object
}

type Prettify<T> = { [K in keyof T]: T[K] } & {}

type GatekeeperControls<TServices extends ServiceMap> = {
	withUnlockedGates<R>(fn: (services: TServices) => R | Promise<R>): Promise<R>
}

// ---- Gatekeeper (built harness) ---------------------------------------------

/** The built harness: each service's async methods return handle promises. */
export type Gatekeeper<TServices extends Record<string, object> = {}> = {
	[K in keyof TServices]: GatekeeperProxy<TServices, TServices[K]>
} & GatekeeperControls<TServices>

// ---- Builder ----------------------------------------------------------------

/**
 * Builder for an ordered, acyclic service harness.
 *
 * ```ts
 * const gatekeeper = new GatekeeperBuilder()
 *   .add("server", () => new Server())
 *   .add("client", ({ server }) => new Client(server))
 *   .build()
 * ```
 */
export class GatekeeperBuilder<TServices extends Record<string, object> = {}> {
	private entries: ServiceEntry[] = []

	/**
	 * Register a named service factory. Factories receive proxy-wrapped versions
	 * of all previously registered services.
	 */
	add<Name extends string, S extends object>(
		name: Name,
		factory: (deps: TServices) => S,
	): GatekeeperBuilder<Prettify<TServices & Record<Name, S>>> {
		const next = new GatekeeperBuilder<Prettify<TServices & Record<Name, S>>>()
		next.entries = [
			...this.entries,
			{ name, factory: factory as ServiceEntry["factory"] },
		]
		return next
	}

	/**
	 * Build all registered services in order.
	 */
	build(): Gatekeeper<TServices> {
		type InvocationId = number

		const invocationContext = new AsyncLocalStorage<InvocationId>()
		const invocations = new Map<
			InvocationId,
			InvocationController<unknown, TServices>
		>()
		let nextInvocationId = 1

		function getInvocationById(
			invocationId: InvocationId,
		): InvocationController<unknown, TServices> {
			const invocation = invocations.get(invocationId)
			if (!invocation) {
				throw new Error(
					`Gatekeeper invariant: invocation ${invocationId} is no longer live`,
				)
			}
			return invocation
		}

		function getCurrentInvocation(): InvocationController<
			unknown,
			TServices
		> | null {
			const invocationId = invocationContext.getStore()
			if (invocationId === undefined) return null
			return getInvocationById(invocationId)
		}

		function createBoundInvocationLookup(): {
			getInvocation: () => InvocationController<unknown, TServices>
			resumeInContext: <R>(fn: () => R) => R
		} {
			const invocationId = invocationContext.getStore()
			if (invocationId === undefined) {
				throw new Error(
					"Gatekeeper invariant: cannot create bound invocation lookup outside invocation context",
				)
			}
			return {
				getInvocation: () => getInvocationById(invocationId),
				resumeInContext: <R>(fn: () => R): R =>
					invocationContext.run(invocationId, fn),
			}
		}

		const rawServices: Record<string, object> = {}
		const proxiedDependencies: Record<string, object> = {}
		const harness: Record<string, object> = {}

		const unlockedGateContext = new AsyncLocalStorage<boolean>()

		const shouldBypassInterception = (): boolean =>
			unlockedGateContext.getStore() === true

		for (const entry of this.entries) {
			const instance = entry.factory({ ...proxiedDependencies })
			rawServices[entry.name] = instance

			proxiedDependencies[entry.name] = createDependencyProxy<TServices>(
				entry.name,
				instance,
				getCurrentInvocation,
				createBoundInvocationLookup,
				shouldBypassInterception,
			)

			harness[entry.name] = createHarnessServiceProxy<TServices>(
				instance,
				(run) => {
					const invocationId = nextInvocationId++
					const invocation = new InvocationController<unknown, TServices>(
						() => {
							invocations.delete(invocationId)
						},
					)

					invocations.set(invocationId, invocation)

					let result: unknown
					try {
						result = invocationContext.run(invocationId, run)
					} catch (error) {
						invocations.delete(invocationId)
						throw error
					}

					if (!isPromiseLike(result)) {
						invocations.delete(invocationId)
						return result
					}

					invocation.track(result)
					return invocation.observe()
				},
				shouldBypassInterception,
			)
		}

		Object.defineProperty(harness, "withUnlockedGates", {
			value: async <R>(
				fn: (services: TServices) => R | Promise<R>,
			): Promise<R> => {
				return await unlockedGateContext.run(true, () =>
					fn(rawServices as TServices),
				)
			},
		})

		return harness as Gatekeeper<TServices>
	}
}
