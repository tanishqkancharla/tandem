import * as errore from "errore"

type Prettify<T> = { [K in keyof T]: T[K] } & {}

type AnyMethod = (...args: never[]) => unknown

export class DuplicateServiceError extends errore.createTaggedError({
	name: "DuplicateServiceError",
	message: "Service $name is already registered",
}) {}

export class CallAlreadySettledError extends errore.createTaggedError({
	name: "CallAlreadySettledError",
	message: "Call $service.$method was already settled",
}) {}

export type GateCall<Result = unknown, Args extends unknown[] = unknown[]> = {
	readonly service: string
	readonly method: string
	readonly args: Args
	allow(): Promise<Result>
	mockReturnValue(value: Result): Promise<Result>
	fail(error: Error): Promise<never>
}

export type GatedService<Service extends object> = {
	[Key in keyof Service]: Service[Key] extends (
		...args: infer Args
	) => infer Return
		? (...args: Args) => GateCall<Awaited<Return>, Args>
		: Service[Key]
}

export type Harness<Services extends Record<string, object>> = {
	[Key in keyof Services]: GatedService<Services[Key]>
} & {
	nextCall(): Promise<GateCall>
}

type ServiceRegistration = {
	name: string
	factory: (deps: Record<string, object>) => object
}

class PendingCall<
	Result = unknown,
	Args extends unknown[] = unknown[],
> implements GateCall<Result, Args> {
	readonly service: string
	readonly method: string
	readonly args: Args

	private closed = false
	private readonly implementation: () => unknown
	private readonly settlement = Promise.withResolvers<Result>()

	constructor(args: {
		service: string
		method: string
		args: Args
		implementation: () => unknown
	}) {
		this.service = args.service
		this.method = args.method
		this.args = args.args
		this.implementation = args.implementation
	}

	get result(): Promise<Result> {
		return this.settlement.promise
	}

	allow(): Promise<Result> {
		this.close()
		return Promise.resolve()
			.then(() => this.implementation())
			.then(
				(value) => {
					this.settlement.resolve(value as Result)
					return value as Result
				},
				(error: unknown) => {
					this.settlement.reject(error)
					return Promise.reject(error)
				},
			)
	}

	mockReturnValue(value: Result): Promise<Result> {
		this.close()
		this.settlement.resolve(value)
		return Promise.resolve(value)
	}

	fail(error: Error): Promise<never> {
		this.close()
		this.settlement.reject(error)
		return this.settlement.promise as Promise<never>
	}

	private close() {
		if (this.closed) {
			throw new CallAlreadySettledError({
				service: this.service,
				method: this.method,
			})
		}
		this.closed = true
	}
}

class GateRuntime {
	private readonly pending: PendingCall[] = []
	private readonly waiters: Array<(call: PendingCall) => void> = []

	createTestProxy(name: string, instance: object) {
		return this.createProxy(name, instance, "test")
	}

	createServiceProxy(name: string, instance: object) {
		return this.createProxy(name, instance, "service")
	}

	nextCall() {
		const queued = this.pending.shift()
		if (queued) return Promise.resolve(queued)

		return new Promise<PendingCall>((resolve) => {
			this.waiters.push(resolve)
		})
	}

	private createProxy(
		name: string,
		instance: object,
		kind: "test" | "service",
	) {
		return new Proxy(instance, {
			get: (target, prop, receiver) => {
				if (typeof prop !== "string" || Object.hasOwn(Object.prototype, prop)) {
					return Reflect.get(target, prop, receiver)
				}

				const value = Reflect.get(target, prop, target)
				if (typeof value !== "function") return value

				return (...args: unknown[]) => {
					const call = new PendingCall({
						service: name,
						method: prop,
						args,
						implementation: () => (value as AnyMethod).apply(target, args),
					})

					if (kind === "service") {
						this.enqueue(call)
						return call.result
					}

					return call
				}
			},
		})
	}

	private enqueue(call: PendingCall) {
		const waiter = this.waiters.shift()
		if (waiter) {
			waiter(call)
			return
		}

		this.pending.push(call)
	}
}

export class Gatekeeper<Services extends Record<string, object> = {}> {
	constructor(private readonly registrations: ServiceRegistration[] = []) {}

	add<Name extends string, Service extends object>(
		name: Name,
		factory: (deps: Services) => Service,
	): Gatekeeper<Prettify<Services & { [K in Name]: Service }>> {
		if (this.registrations.some((registration) => registration.name === name)) {
			throw new DuplicateServiceError({ name })
		}

		return new Gatekeeper([
			...this.registrations,
			{
				name,
				factory: factory as (deps: Record<string, object>) => object,
			},
		])
	}

	build(): Harness<Services> {
		const runtime = new GateRuntime()
		const serviceProxies: Record<string, object> = {}
		const harness = {} as Record<string, object> & {
			nextCall(): Promise<GateCall>
		}

		for (const registration of this.registrations) {
			const instance = registration.factory(serviceProxies)
			serviceProxies[registration.name] = runtime.createServiceProxy(
				registration.name,
				instance,
			)
			harness[registration.name] = runtime.createTestProxy(
				registration.name,
				instance,
			)
		}

		Object.defineProperty(harness, "nextCall", {
			value: () => runtime.nextCall(),
			enumerable: false,
		})

		return harness as Harness<Services>
	}
}
