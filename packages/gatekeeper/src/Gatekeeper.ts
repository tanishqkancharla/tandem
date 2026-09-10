import asyncHooks from "node:async_hooks"
import * as errore from "errore"

const serviceIdentity: unique symbol = Symbol("Gatekeeper service")

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

/** A misuse of the test harness, distinct from an application's error value. */
export class GatekeeperError extends errore.createTaggedError({
	name: "GatekeeperError",
	message: "$detail",
}) {}

/** Register services and build an isolated execution controller for each test. */
export class Gatekeeper<Services extends Record<string, object> = {}> {
	private registrations: Registration[] = []

	/**
	 * Register a real service. Factories see previously registered services with
	 * their normal APIs; only the test-facing proxies expose operation controls.
	 */
	add<Name extends string, Service extends object>(
		name: Name extends keyof Services ? never : Name,
		factory: (services: Services) => Service,
	): Gatekeeper<Services & Record<Name, Service>> {
		if (
			!name.trim() ||
			this.registrations.some((entry) => entry.name === name)
		) {
			throw new GatekeeperError({
				detail: `Service name must be unique and nonempty: ${name}`,
			})
		}
		const builder = new Gatekeeper<Services & Record<Name, Service>>()
		builder.registrations = [
			...this.registrations,
			{
				name,
				factory: (services) => factory(services as Services),
			},
		]
		return builder
	}

	/** Build isolated proxies. Disposing the harness must release its resources. */
	build(): Harness<Services> {
		return new Runtime().build(this.registrations) as Harness<Services>
	}
}

type Registration = {
	name: string
	factory: (services: Record<string, object>) => object
}
type Service = { name: string; instance: object }
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
type Phase = "before" | "after"
type Target = { service: Service; phase: Phase }

const context = new asyncHooks.AsyncLocalStorage<Call>()

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof value.then === "function"
	)
}

function unwrap(outcome: Outcome): unknown {
	if (!outcome.ok) throw outcome.error
	return outcome.value
}

class Runtime {
	readonly calls = new Set<Call>()
	private readonly identities = new WeakMap<object, Service>()
	private disposal: Promise<void> | undefined
	disposed = false

	build(
		registrations: Registration[],
	): Record<string, object> & AsyncDisposable {
		const dependencies: Record<string, object> = Object.create(null)
		const harness = Object.create(null) as Record<string, object> &
			AsyncDisposable
		for (const { name, factory } of registrations) {
			const instance = factory(Object.freeze({ ...dependencies }))
			if (
				instance === null ||
				typeof instance !== "object" ||
				isPromiseLike(instance)
			) {
				throw new GatekeeperError({
					detail: `${name}: factory must return a service object synchronously`,
				})
			}
			const service = { name, instance }
			dependencies[name] = this.proxy(service, false)
			harness[name] = this.proxy(service, true)
			this.identities.set(harness[name], service)
		}
		harness[Symbol.asyncDispose] = () => this.dispose()
		return harness
	}

	private proxy(service: Service, external: boolean): object {
		return new Proxy(service.instance, {
			get: (_target, key) => {
				if (key === serviceIdentity) return true
				const value: unknown = Reflect.get(
					service.instance,
					key,
					service.instance,
				)
				if (typeof value !== "function") return value
				const descriptor = Reflect.getOwnPropertyDescriptor(
					service.instance,
					key,
				)
				if (
					descriptor &&
					!descriptor.configurable &&
					descriptor.writable === false
				) {
					throw new GatekeeperError({
						detail: `${service.name}.${String(key)}: cannot proxy a frozen method`,
					})
				}
				return (...args: unknown[]) => {
					if (this.disposed)
						throw new GatekeeperError({ detail: "Harness is disposed" })
					const invoke = (): unknown =>
						Reflect.apply(value, service.instance, args)
					const parent = context.getStore()
					if (parent) {
						if (parent.runtime !== this) {
							throw new GatekeeperError({
								detail: "Cannot call a service from another harness",
							})
						}
						return parent.interact(service, invoke)
					}
					if (!external) return invoke()
					const call = new Call(this, `${service.name}.${String(key)}`)
					return call.start(invoke)
				}
			},
			set: (_target, key, value: unknown) =>
				Reflect.set(service.instance, key, value, service.instance),
		})
	}

	target(boundary: Boundary): Target | GatekeeperError {
		if (!boundary || typeof boundary !== "object") {
			return new GatekeeperError({
				detail: "Select exactly one processing boundary",
			})
		}
		const before = "beforeProcessedBy" in boundary
		const after = "afterProcessedBy" in boundary
		if (before === after)
			return new GatekeeperError({
				detail: "Select exactly one processing boundary",
			})
		const ref = before ? boundary.beforeProcessedBy : boundary.afterProcessedBy
		const service = ref && this.identities.get(ref)
		if (!service)
			return new GatekeeperError({
				detail: "Boundary service must belong to this harness",
			})
		return { service, phase: before ? "before" : "after" }
	}

	private dispose(): Promise<void> {
		if (this.disposal) return this.disposal
		this.disposed = true
		for (const call of this.calls)
			call.cancel(new GatekeeperError({ detail: "Harness is disposed" }))
		this.calls.clear()
		this.disposal = Promise.resolve()
		return this.disposal
	}
}

class Interaction {
	phase: Phase | "processing" | "delivered" = "before"
	readonly response = Promise.withResolvers<Outcome>()
	private outcome: Outcome | undefined

	constructor(
		readonly call: Call,
		readonly service: Service,
		private readonly invoke: () => unknown,
	) {}

	advance(): void {
		if (this.phase === "after" && this.outcome) {
			this.deliver(this.outcome)
			return
		}
		if (this.phase !== "before") return
		this.phase = "processing"
		// The consumer method is an uncontrolled boundary. Both synchronous throws
		// and promise rejections retain their original identity for its caller.
		void Promise.resolve()
			.then(() =>
				context.run(this.call, () => {
					if (this.call.runtime.disposed)
						throw new GatekeeperError({ detail: "Harness is disposed" })
					const result = this.invoke()
					if (!isPromiseLike(result)) {
						const error = new GatekeeperError({
							detail: `${this.service.name}: calls between services must return promises`,
						})
						this.call.cancel(error)
						throw error
					}
					return Promise.resolve(result)
				}),
			)
			.then(
				(value: unknown) => this.processed({ ok: true, value }),
				(error: unknown) => this.processed({ ok: false, error }),
			)
	}

	private processed(outcome: Outcome): void {
		if (this.phase === "delivered") return
		this.outcome = outcome
		this.phase = "after"
		this.call.changed()
		if (this.call.running) this.advance()
	}

	deliver(outcome: Outcome): void {
		if (this.phase === "delivered") return
		this.phase = "delivered"
		this.call.interactions.delete(this)
		this.response.resolve(outcome)
		this.call.changed()
	}
}

class Call implements Operation<unknown>, HeldCall<unknown> {
	readonly interactions = new Set<Interaction>()
	private readonly result = Promise.withResolvers<Outcome>()
	private signal = Promise.withResolvers<void>()
	private outcome: Outcome | undefined
	private selection: "normal" | "held" | undefined
	private current: Interaction | undefined
	private controlling = false
	private controlError: GatekeeperError | undefined
	running = false

	constructor(
		readonly runtime: Runtime,
		private readonly label: string,
	) {
		runtime.calls.add(this)
	}

	start(invoke: () => unknown): unknown {
		// Keep synchronous observations synchronous, including thrown exceptions.
		// Catch only at this consumer boundary so failed calls cannot leak gates.
		const invoked: Outcome = (() => {
			try {
				return { ok: true, value: context.run(this, invoke) }
			} catch (error) {
				return { ok: false, error }
			}
		})()
		if (!invoked.ok) {
			this.finish(invoked)
			throw invoked.error
		}
		const { value } = invoked
		if (!isPromiseLike(value)) {
			if (this.interactions.size) {
				const error = new GatekeeperError({
					detail: `${this.label}: a method making service calls must return a promise`,
				})
				this.cancel(error)
				throw error
			}
			this.finish({ ok: true, value })
			if (this.controlError) throw this.controlError
			return value
		}
		context.run(this, () => {
			void Promise.resolve(value).then(
				(result: unknown) => this.finish({ ok: true, value: result }),
				(error: unknown) => this.finish({ ok: false, error }),
			)
		})
		// Arm interception before invoking the service. A synchronous .hold()
		// claims the operation; otherwise ordinary calls flow on the next microtask.
		queueMicrotask(() => {
			if (!this.selection) {
				this.selection = "normal"
				this.release()
			}
		})
		return this
	}

	// Operations deliberately implement the public PromiseLike contract.
	// oxlint-disable-next-line unicorn/no-thenable
	then<TResult1 = unknown, TResult2 = never>(
		onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		if (!this.selection) {
			this.selection = "normal"
			this.release()
		}
		const result =
			this.selection === "held"
				? Promise.reject(
						new GatekeeperError({
							detail: `${this.label}: operation is held; use its controls`,
						}),
					)
				: this.result.promise.then(unwrap)
		return result.then(onfulfilled, onrejected)
	}

	async hold(): Promise<HeldCall<unknown>> {
		if (this.selection)
			throw new GatekeeperError({
				detail: `${this.label}: operation already started or held`,
			})
		this.selection = "held"
		await this.progress()
		// A held handle must not be thenable, or await would assimilate it.
		return {
			continueUntil: (boundary) => this.continueUntil(boundary),
			continue: () => this.continue(),
			fail: (error) => this.fail(error),
		}
	}

	async continueUntil(boundary: Boundary): Promise<void> {
		this.checkControl()
		const target = this.runtime.target(boundary)
		if (target instanceof Error) throw target
		this.controlling = true
		await this.progress(target).then(
			() => {
				this.controlling = false
			},
			(error: unknown) => {
				this.controlling = false
				throw error
			},
		)
	}

	async continue(): Promise<unknown> {
		this.checkControl()
		this.controlling = true
		this.release()
		return await this.result.promise.then(unwrap)
	}

	async fail(error: Error): Promise<unknown> {
		this.checkControl()
		if (!(error instanceof Error))
			throw new GatekeeperError({ detail: "Fault injection requires an Error" })
		if (!this.current)
			throw new GatekeeperError({
				detail: `${this.label}: no interaction is held`,
			})
		this.controlling = true
		this.current.deliver({ ok: false, error })
		this.release()
		return await this.result.promise.then(unwrap)
	}

	private checkControl(): void {
		if (this.controlError) throw this.controlError
		if (this.runtime.disposed)
			throw new GatekeeperError({ detail: "Harness is disposed" })
		if (this.outcome)
			throw new GatekeeperError({ detail: `${this.label}: call has completed` })
		if (this.controlling)
			throw new GatekeeperError({
				detail: `${this.label}: another control is in progress`,
			})
	}

	interact(service: Service, invoke: () => unknown): Promise<unknown> {
		if (this.controlError) return Promise.reject(this.controlError)
		if (this.outcome && !this.running)
			return Promise.reject(
				new GatekeeperError({
					detail: `${this.label}: outgoing call after operation completed; await service work`,
				}),
			)
		const interaction = new Interaction(this, service, invoke)
		this.interactions.add(interaction)
		this.runtime.calls.add(this)
		this.changed()
		if (this.running) interaction.advance()
		return interaction.response.promise.then(unwrap)
	}

	changed(): void {
		if (this.outcome && !this.interactions.size) this.runtime.calls.delete(this)
		this.signal.resolve()
		this.signal = Promise.withResolvers<void>()
	}

	private async progress(target?: Target): Promise<void> {
		while (true) {
			const changed = this.signal.promise
			if (this.controlError) throw this.controlError
			const ready = [...this.interactions].filter(
				(event) => event.phase === "before" || event.phase === "after",
			)
			const match = ready.find(
				(event) =>
					!target ||
					(event.service === target.service && event.phase === target.phase),
			)
			if (match) {
				this.current = match
				return
			}
			if (this.outcome) {
				if (!this.outcome.ok) throw this.outcome.error
				throw new GatekeeperError({
					detail: target
						? `${this.label}: boundary ${target.phase} ${target.service.name} not reached before completion`
						: `${this.label}: no outgoing service call before completion`,
				})
			}
			for (const event of ready) event.advance()
			await changed
		}
	}

	private release(): void {
		this.running = true
		this.current = undefined
		for (const event of this.interactions) event.advance()
	}

	private finish(outcome: Outcome): void {
		if (this.outcome) return
		this.outcome = outcome
		this.result.resolve(outcome)
		this.changed()
	}

	cancel(error: GatekeeperError): void {
		this.controlError = error
		for (const event of this.interactions) event.deliver({ ok: false, error })
		this.finish({ ok: false, error })
	}
}
