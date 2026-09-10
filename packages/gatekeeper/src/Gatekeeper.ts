declare const serviceIdentity: unique symbol

/** A registered service, usable as an execution boundary. */
export type ServiceRef = { readonly [serviceIdentity]: true }

/** Select exactly one side of the next matching service interaction. */
export type Boundary =
	| { beforeProcessedBy: ServiceRef; afterProcessedBy?: never }
	| { afterProcessedBy: ServiceRef; beforeProcessedBy?: never }

/**
 * An async public call. Await normally for its actual result, or hold it to
 * control its progress. Synchronous methods remain ordinary service methods.
 */
export interface Operation<Result> extends PromiseLike<Result> {
	/**
	 * Run local work until the first outgoing call to another registered service,
	 * then return with that call held before the receiver processes it.
	 * Reject if the operation completes without an outgoing service call.
	 */
	hold(): Promise<HeldCall<Result>>
}

export interface HeldCall<Result> {
	/**
	 * Advance to the next matching event. After processing, the receiver's effects
	 * remain real, but its response has not been delivered to the caller.
	 * Wait for real dependencies as needed; never release another call's holds.
	 * An already-held matching boundary is satisfied without advancing.
	 * Reject if the operation completes without reaching the requested boundary.
	 */
	continueUntil(boundary: Boundary): Promise<void>
	/** Release this call's holds and await its original result or rejection. */
	continue(): Promise<Result>
	/**
	 * Reject the currently held interaction and run the actual caller's recovery
	 * path. The result is whatever that caller returns, including error values.
	 */
	fail(error: Error): Promise<Result>
}

/**
 * Initial typing contract: ordinary, non-overloaded async methods. Preserving
 * generic method correlations and overloads needs a separate type design.
 */
export type ServiceProxy<Service extends object> = ServiceRef & {
	[Key in keyof Service]: Service[Key] extends (
		...args: infer Args
	) => PromiseLike<infer Result>
		? (...args: Args) => Operation<Awaited<Result>>
		: Service[Key]
}

export type Harness<Services extends Record<string, object>> =
	AsyncDisposable & {
		[Name in keyof Services]: ServiceProxy<Services[Name]>
	}

/** API scaffold only. The runtime intentionally remains unimplemented. */
export class Gatekeeper<Services extends Record<string, object> = {}> {
	/**
	 * Register a real service. Factories see previously registered services with
	 * their normal APIs; only the test-facing proxies expose operation controls.
	 */
	add<Name extends string, Service extends object>(
		_name: Name extends keyof Services ? never : Name,
		_factory: (services: Services) => Service,
	): Gatekeeper<Services & Record<Name, Service>> {
		throw new Error(
			"Gatekeeper.add is not implemented; review the contract tests",
		)
	}

	/** Build isolated proxies. Disposing the harness must release its resources. */
	build(): Harness<Services> {
		throw new Error(
			"Gatekeeper.build is not implemented; review the contract tests",
		)
	}
}
