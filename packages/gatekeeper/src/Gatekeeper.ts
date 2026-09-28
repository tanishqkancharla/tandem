import asyncHooks from "node:async_hooks"
import * as errore from "errore"

export type ServiceGates = {
	enter?: boolean
	exit?: boolean
}

export type ServiceOptions = {
	gates?: ServiceGates
}

export class GatekeeperError extends errore.createTaggedError({
	name: "GatekeeperError",
	message: "$detail",
}) {}

let createCallHandle: <Result>(call: Call) => CallHandle<Result>

export class CallHandle<Result> {
	readonly result: Promise<Result>

	private constructor(private readonly call: Call) {
		this.result = call.result as Promise<Result>
	}

	static {
		createCallHandle = <Result>(call: Call) => new CallHandle<Result>(call)
	}

	assertSentBy(serviceName: string): this {
		this.call.assertSentBy(serviceName)
		return this
	}

	assertWaitingFor(serviceName: string): this {
		this.call.assertWaitingFor(serviceName)
		return this
	}

	assertCompleted(): this {
		this.call.assertCompleted()
		return this
	}

	continueTo(serviceName: string): Promise<void> {
		return this.call.continueTo(serviceName)
	}

	continueToCompletion(): Promise<void> {
		return this.call.continueToCompletion()
	}

	fail(error: Error): Promise<void> {
		return this.call.fail(error)
	}
}

export type GatekeeperListener = {
	/** Start a call delivering this event to its listener. Returns immediately. */
	emit(): void
}

export type GatekeeperEvents = {
	/** Register a listener owned by the service being built or currently running. */
	on(name: string, listener: () => Promise<void>): GatekeeperListener
}

export type ServiceFactoryContext = {
	events: GatekeeperEvents
}

export type PendingCall = {
	readonly handle: CallHandle<unknown>
	readonly label: string
	readonly sentBy: string
	readonly waitingFor: string
}

type AsyncMethodResult<Method> = Method extends (
	...args: infer Args
) => PromiseLike<infer Result>
	? (...args: Args) => Promise<CallHandle<Awaited<Result>>>
	: Method

export type ServiceProxy<Service extends object> = {
	[Key in keyof Service]: AsyncMethodResult<Service[Key]>
}

export type Harness<Services extends Record<string, object>> =
	AsyncDisposable & {
		[Name in keyof Services]: ServiceProxy<Services[Name]>
	} & {
		pendingCalls(): readonly PendingCall[]
		crash(name: Extract<keyof Services, string>): Promise<void>
		restart(name: Extract<keyof Services, string>): Promise<void>
		activateGates(): Promise<void>
		deactivateGates(): Promise<void>
		deactivateGatesAndSettle(): Promise<void>
	}

export class Gatekeeper<Services extends Record<string, object> = {}> {
	private registrations: Registration[] = []

	add<Name extends string, Service extends object>(
		name: Name extends keyof Services ? never : Name,
		factory: (services: Services, context: ServiceFactoryContext) => Service,
		options: ServiceOptions = {},
	): Gatekeeper<Services & Record<Name, Service>> {
		if (
			!name.trim() ||
			this.registrations.some((registration) => registration.name === name)
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
				factory: (services, context) => factory(services as Services, context),
				gates: {
					enter: options.gates?.enter ?? true,
					exit: options.gates?.exit ?? true,
				},
			},
		]
		return builder
	}

	build(): Harness<Services> {
		return new Runtime().build(this.registrations) as Harness<Services>
	}
}

type Registration = {
	name: string
	factory: (
		services: Record<string, object>,
		context: ServiceFactoryContext,
	) => object
	gates: Required<ServiceGates>
}

/** One incarnation of a registered service. A restart creates a new one. */
type Service = {
	name: string
	instance: object
	gates: Required<ServiceGates>
	crashed: boolean
}

type ServiceSlot = {
	registration: Registration
	dependencies: Readonly<Record<string, object>>
	current?: Service
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

type ExecutionContext = {
	runtime: Runtime
	service: Service
	call?: Call
}

const context = new asyncHooks.AsyncLocalStorage<ExecutionContext>()

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
	private readonly slots = new Map<string, ServiceSlot>()
	private readonly events: GatekeeperEvents = {
		on: (name, listener) => this.listen(name, listener),
	}
	private building?: Service
	private gatesActive = false
	private disposed = false
	private disposal?: Promise<void>

	build(registrations: Registration[]) {
		const dependencies: Record<string, object> = Object.create(null)
		const harness: Record<string | symbol, unknown> = Object.create(null)

		for (const registration of registrations) {
			const slot: ServiceSlot = {
				registration,
				dependencies: Object.freeze({ ...dependencies }),
			}
			this.slots.set(registration.name, slot)
			this.startService(slot)
			dependencies[registration.name] = this.proxy(slot, false)
			harness[registration.name] = this.proxy(slot, true)
		}

		harness.pendingCalls = () => this.pendingCalls()
		harness.crash = (name: string) => this.crash(name)
		harness.restart = (name: string) => this.restart(name)
		harness.activateGates = () => this.activateGates()
		harness.deactivateGates = () => this.deactivateGates()
		harness.deactivateGatesAndSettle = () => this.deactivateGatesAndSettle()
		harness[Symbol.asyncDispose] = () => this.dispose()

		return harness
	}

	private startService(slot: ServiceSlot): void {
		const { registration } = slot
		const service: Service = {
			name: registration.name,
			instance: {},
			gates: registration.gates,
			crashed: false,
		}
		this.building = service
		const instance = registration.factory(slot.dependencies, {
			events: this.events,
		})
		this.building = undefined
		if (
			instance === null ||
			typeof instance !== "object" ||
			isPromiseLike(instance)
		) {
			throw new GatekeeperError({
				detail: `${registration.name}: factory must return a service object synchronously`,
			})
		}
		service.instance = instance
		slot.current = service
	}

	private running(slot: ServiceSlot): Service {
		if (slot.current) return slot.current
		throw new GatekeeperError({
			detail: `${slot.registration.name} has crashed`,
		})
	}

	private proxy(slot: ServiceSlot, external: boolean): object {
		return new Proxy(this.running(slot).instance, {
			get: (_target, key) => {
				const service = this.running(slot)
				const value: unknown = Reflect.get(
					service.instance,
					key,
					service.instance,
				)
				if (typeof value !== "function") return value

				return (...args: unknown[]) => {
					this.assertUsable()
					const invoke = () => Reflect.apply(value, service.instance, args)
					const parent = context.getStore()

					// A crashed instance's code can keep running, but nothing it
					// calls leaves it: the call never settles and is not tracked.
					if (parent?.service.crashed) return new Promise(() => {})

					if (parent) {
						if (parent.runtime !== this) {
							throw new GatekeeperError({
								detail: "Cannot call a service from another harness",
							})
						}
						if (this.gatesActive && parent.call) {
							return parent.call.interact({
								sender: parent.service,
								receiver: service,
								invoke,
							})
						}
						return context.run({ ...parent, service }, invoke)
					}

					if (!external) {
						return context.run({ runtime: this, service }, invoke)
					}

					const call = new Call({
						runtime: this,
						label: `${service.name}.${String(key)}`,
						root: service,
					})
					this.calls.add(call)
					return call.start({ service, invoke })
				}
			},
			set: (_target, key, value: unknown) => {
				const service = this.running(slot)
				return Reflect.set(service.instance, key, value, service.instance)
			},
		})
	}

	private listen(
		name: string,
		listener: () => Promise<void>,
	): GatekeeperListener {
		this.assertUsable()
		const owner = this.building ?? context.getStore()?.service
		if (!owner) {
			throw new GatekeeperError({
				detail: `events.on("${name}") must be called by a service`,
			})
		}
		return { emit: () => this.emit(owner, name, listener) }
	}

	private emit(
		owner: Service,
		name: string,
		listener: () => Promise<void>,
	): void {
		this.assertUsable()
		const label = `${owner.name}.${name}`
		const sender = context.getStore()?.service
		if (!sender) {
			throw new GatekeeperError({
				detail: `${label}: events must be emitted by a service`,
			})
		}
		// A crashed instance sends nothing, and nobody hears a crashed listener.
		if (sender.crashed || owner.crashed) return
		const call = new Call({ runtime: this, label, root: owner })
		this.calls.add(call)
		call.deliverEvent({ sender, receiver: owner, invoke: listener })
	}

	private slot(name: string): ServiceSlot {
		const slot = this.slots.get(name)
		if (slot) return slot
		throw new GatekeeperError({ detail: `Unknown service: ${name}` })
	}

	private async crash(name: string): Promise<void> {
		this.assertUsable()
		const slot = this.slot(name)
		const service = this.running(slot)
		service.crashed = true
		slot.current = undefined
		for (const call of this.calls) call.serviceCrashed(service)
		await Promise.resolve()
	}

	private async restart(name: string): Promise<void> {
		this.assertUsable()
		const slot = this.slot(name)
		if (slot.current) {
			throw new GatekeeperError({
				detail: `${name} is running; crash it before restarting it`,
			})
		}
		this.startService(slot)
		await Promise.resolve()
	}

	private assertUsable(): void {
		if (this.disposed)
			throw new GatekeeperError({ detail: "Harness is disposed" })
	}

	isGating(): boolean {
		return this.gatesActive
	}

	forget(call: Call): void {
		this.calls.delete(call)
	}

	private pendingCalls(): readonly PendingCall[] {
		this.assertUsable()
		return [...this.calls].flatMap((call) => call.pendingCall() ?? [])
	}

	private activateGates(): Promise<void> {
		this.assertUsable()
		this.gatesActive = true
		return Promise.resolve()
	}

	private async deactivateGates(): Promise<void> {
		this.assertUsable()
		this.gatesActive = false
		for (const call of this.calls) call.releaseGates()
		await Promise.resolve()
	}

	private async deactivateGatesAndSettle(): Promise<void> {
		await this.deactivateGates()
		while (this.calls.size > 0) {
			await Promise.all([...this.calls].map((call) => call.drained))
		}
	}

	private dispose(): Promise<void> {
		if (this.disposal) return this.disposal
		this.disposed = true
		const error = new GatekeeperError({ detail: "Harness is disposed" })
		for (const call of this.calls) call.cancel(error)
		this.calls.clear()
		this.disposal = Promise.resolve()
		return this.disposal
	}
}

let nextInteractionId = 0

type InteractionArgs = {
	call: Call
	sender: Service
	receiver: Service
	invoke: () => unknown
	/** Events have no reply, so their result is never held at the exit gate. */
	oneWay?: boolean
}

type InteractionPhase = "enter" | "processing" | "exit" | "delivered"

class Interaction {
	readonly id = nextInteractionId++
	readonly response = Promise.withResolvers<Outcome>()
	phase: InteractionPhase
	private outcome?: Outcome

	constructor(private readonly args: InteractionArgs) {
		this.phase =
			args.call.runtime.isGating() && args.receiver.gates.enter
				? "enter"
				: "processing"
	}

	get key(): string {
		return `${this.id}:${this.phase}`
	}

	get sentBy(): Service {
		return this.phase === "exit" ? this.args.receiver : this.args.sender
	}

	get waitingFor(): Service {
		return this.phase === "exit" ? this.args.sender : this.args.receiver
	}

	get isStop(): boolean {
		if (this.phase === "enter" || this.phase === "exit") return true
		return (
			this.phase === "processing" &&
			!this.args.receiver.gates.enter &&
			this.args.call.runtime.isGating()
		)
	}

	start(): void {
		if (this.phase === "enter") {
			this.args.call.changed()
			return
		}
		this.process()
	}

	release(): void {
		if (this.phase === "enter") {
			this.phase = "processing"
			this.process()
			return
		}
		if (this.phase === "exit" && this.outcome) {
			this.deliver(this.outcome)
			return
		}
		throw new GatekeeperError({
			detail: `${this.args.receiver.name}: interaction is not held at a gate`,
		})
	}

	fail(error: Error): void {
		if (this.phase === "delivered") {
			throw new GatekeeperError({
				detail: `${this.args.receiver.name}: interaction has completed`,
			})
		}
		this.deliver({ ok: false, error })
	}

	private process(): void {
		const invoked: Outcome = (() => {
			try {
				return {
					ok: true,
					value: context.run(
						{
							runtime: this.args.call.runtime,
							service: this.args.receiver,
							call: this.args.call,
						},
						this.args.invoke,
					),
				}
			} catch (error) {
				return { ok: false, error }
			}
		})()

		if (!invoked.ok) {
			this.processed(invoked)
			return
		}
		if (!isPromiseLike(invoked.value)) {
			this.args.call.cancel(
				new GatekeeperError({
					detail: `${this.args.receiver.name}: calls between services must return promises`,
				}),
			)
			return
		}

		void Promise.resolve(invoked.value).then(
			(value) => this.processed({ ok: true, value }),
			(error: unknown) => this.processed({ ok: false, error }),
		)
	}

	/** Applies a crash to this handoff, so it can never wait on a dead service. */
	serviceCrashed(service: Service): void {
		if (this.phase === "delivered") return
		if (this.args.receiver === service && this.phase !== "exit") {
			// A request or event addressed to a crashed service fails, as a refused
			// connection would, so a live sender is never left waiting.
			this.deliver({
				ok: false,
				error: new GatekeeperError({ detail: `${service.name} has crashed` }),
			})
			return
		}
		// Its reply is addressed to the crashed sender, so nobody receives it.
		if (this.args.sender === service && this.phase === "exit") this.drop()
	}

	private processed(outcome: Outcome): void {
		if (this.phase === "delivered") return
		this.outcome = outcome

		if (
			this.args.call.runtime.isGating() &&
			this.args.receiver.gates.exit &&
			!this.args.oneWay &&
			!this.args.sender.crashed &&
			!this.args.call.runsToCompletion
		) {
			this.phase = "exit"
			this.args.call.changed()
			return
		}

		this.deliver(outcome)
	}

	private deliver(outcome: Outcome): void {
		if (this.phase === "delivered") return
		// A reply to a crashed sender reaches nobody.
		if (this.args.sender.crashed) {
			this.drop()
			return
		}
		this.phase = "delivered"
		this.args.call.remove(this)
		this.response.resolve(outcome)
	}

	private drop(): void {
		this.phase = "delivered"
		this.args.call.remove(this)
	}
}

type CallArgs = {
	runtime: Runtime
	label: string
	/** The service whose top-level call this is; if it crashes, the call is orphaned. */
	root: Service
}

class Call {
	readonly runtime: Runtime
	readonly result: Promise<unknown>
	readonly drained: Promise<void>
	readonly interactions = new Set<Interaction>()
	runsToCompletion = false

	private readonly label: string
	private readonly root: Service
	private orphaned = false
	private readonly resultResolver = Promise.withResolvers<Outcome>()
	private readonly publicResult = Promise.withResolvers<CallHandle<unknown>>()
	private readonly drainedResolver = Promise.withResolvers<void>()
	private readonly handle: CallHandle<unknown>
	private signal = Promise.withResolvers<void>()
	private outcome?: Outcome
	private exposed = false
	private controlling = false
	private controlError?: GatekeeperError

	constructor({ runtime, label, root }: CallArgs) {
		this.runtime = runtime
		this.label = label
		this.root = root
		this.result = this.resultResolver.promise.then(unwrap)
		this.result.catch(() => {})
		this.drained = this.drainedResolver.promise
		this.handle = createCallHandle(this)
	}

	start({ service, invoke }: { service: Service; invoke: () => unknown }) {
		const invoked: Outcome = (() => {
			try {
				return {
					ok: true,
					value: context.run(
						{ runtime: this.runtime, service, call: this },
						invoke,
					),
				}
			} catch (error) {
				return { ok: false, error }
			}
		})()

		if (!invoked.ok) {
			this.finish(invoked)
			throw invoked.error
		}
		if (!isPromiseLike(invoked.value)) {
			if (this.interactions.size > 0) {
				const error = new GatekeeperError({
					detail: `${this.label}: a method making service calls must return a promise`,
				})
				this.cancel(error)
				throw error
			}
			this.finish({ ok: true, value: invoked.value })
			return invoked.value
		}

		void Promise.resolve(invoked.value).then(
			(value) => this.finish({ ok: true, value }),
			(error: unknown) => this.finish({ ok: false, error }),
		)
		return this.publicResult.promise
	}

	deliverEvent(args: {
		sender: Service
		receiver: Service
		invoke: () => unknown
	}): void {
		void this.interact({ ...args, oneWay: true }).then(
			(value) => this.finish({ ok: true, value }),
			(error: unknown) => this.finish({ ok: false, error }),
		)
	}

	interact({
		sender,
		receiver,
		invoke,
		oneWay,
	}: {
		sender: Service
		receiver: Service
		invoke: () => unknown
		oneWay?: boolean
	}): Promise<unknown> {
		if (this.controlError) return Promise.reject(this.controlError)
		if (this.outcome) {
			return Promise.reject(
				new GatekeeperError({
					detail: `${this.label}: cannot add a service handoff after the call completed`,
				}),
			)
		}
		const interaction = new Interaction({
			call: this,
			sender,
			receiver,
			invoke,
			oneWay,
		})
		this.interactions.add(interaction)
		this.expose()

		if (this.runsToCompletion && interaction.phase === "enter") {
			interaction.release()
		} else {
			interaction.start()
		}
		this.changed()
		return interaction.response.promise.then(unwrap)
	}

	assertSentBy(serviceName: string): void {
		const interaction = this.currentInteraction()
		if (interaction?.sentBy.name === serviceName) return
		throw new GatekeeperError({
			detail: `${this.label}: expected call sent by ${serviceName}, received ${interaction?.sentBy.name ?? "completed call"}`,
		})
	}

	assertWaitingFor(serviceName: string): void {
		const interaction = this.currentInteraction()
		if (interaction?.waitingFor.name === serviceName) return
		throw new GatekeeperError({
			detail: `${this.label}: expected call waiting for ${serviceName}, received ${interaction?.waitingFor.name ?? "completed call"}`,
		})
	}

	assertCompleted(): void {
		if (this.outcome) return
		throw new GatekeeperError({
			detail: `${this.label}: expected call to be completed`,
		})
	}

	pendingCall(): PendingCall | undefined {
		if (this.outcome || this.controlError || this.controlling) return undefined
		const interaction = this.currentInteraction()
		if (interaction?.phase !== "enter" && interaction?.phase !== "exit") {
			return undefined
		}
		return {
			handle: this.handle,
			label: this.label,
			sentBy: interaction.sentBy.name,
			waitingFor: interaction.waitingFor.name,
		}
	}

	continueTo(serviceName: string): Promise<void> {
		return this.control(async () => {
			const interaction = this.requireCurrent()
			if (interaction.waitingFor.name !== serviceName) {
				throw new GatekeeperError({
					detail: `${this.label}: call is waiting for ${interaction.waitingFor.name}, not ${serviceName}`,
				})
			}
			const previous = interaction.key
			interaction.release()
			await this.waitForProgress(previous)
		})
	}

	continueToCompletion(): Promise<void> {
		return this.control(async () => {
			this.runsToCompletion = true
			this.releaseGates()
			await this.drained
		})
	}

	fail(error: Error): Promise<void> {
		return this.control(async () => {
			if (!(error instanceof Error)) {
				throw new GatekeeperError({
					detail: "Fault injection requires an Error",
				})
			}
			const interaction = this.requireCurrent()
			const previous = interaction.key
			interaction.fail(error)
			await this.waitForProgress(previous)
		})
	}

	releaseGates(): void {
		for (const interaction of this.interactions) {
			if (interaction.phase === "enter" || interaction.phase === "exit") {
				interaction.release()
			}
		}
	}

	remove(interaction: Interaction): void {
		this.interactions.delete(interaction)
		this.changed()
		this.finishOrphan()
		this.finishDraining()
	}

	serviceCrashed(service: Service): void {
		for (const interaction of this.interactions) {
			interaction.serviceCrashed(service)
		}
		if (this.root === service) this.orphaned = true
		this.finishOrphan()
	}

	/**
	 * A crashed service's call can still hold requests it sent. Once none remain,
	 * it fails, so nothing waits on a result a dead instance will never produce.
	 */
	private finishOrphan(): void {
		if (!this.orphaned || this.interactions.size > 0) return
		this.finish({
			ok: false,
			error: new GatekeeperError({
				detail: `${this.label}: ${this.root.name} crashed`,
			}),
		})
	}

	changed(): void {
		this.signal.resolve()
		this.signal = Promise.withResolvers<void>()
	}

	cancel(error: GatekeeperError): void {
		if (this.controlError) return
		this.controlError = error
		for (const interaction of this.interactions) {
			interaction.fail(error)
		}
		if (!this.outcome) this.finish({ ok: false, error })
		this.finishDraining()
	}

	private expose(): void {
		if (this.exposed) return
		this.exposed = true
		this.publicResult.resolve(this.handle)
	}

	private finish(outcome: Outcome): void {
		if (this.outcome) return
		this.outcome = outcome
		this.resultResolver.resolve(outcome)
		this.expose()
		this.changed()
		this.finishDraining()
	}

	private finishDraining(): void {
		if (!this.outcome || this.interactions.size > 0) return
		this.runtime.forget(this)
		this.drainedResolver.resolve()
	}

	private currentInteraction(): Interaction | undefined {
		return [...this.interactions]
			.reverse()
			.find((interaction) => interaction.isStop)
	}

	private requireCurrent(): Interaction {
		if (this.controlError) throw this.controlError
		if (this.outcome) {
			throw new GatekeeperError({
				detail: `${this.label}: call has completed`,
			})
		}
		const interaction = this.currentInteraction()
		if (interaction) return interaction
		throw new GatekeeperError({
			detail: `${this.label}: call is not waiting at a controllable boundary`,
		})
	}

	private async waitForProgress(previous: string): Promise<void> {
		while (true) {
			if (this.controlError) throw this.controlError
			const interaction = this.currentInteraction()
			if (interaction && interaction.key !== previous) return
			if (this.outcome) return
			const changed = this.signal.promise
			await changed
		}
	}

	private control(run: () => Promise<void>): Promise<void> {
		if (this.controlError) return Promise.reject(this.controlError)
		if (this.controlling) {
			return Promise.reject(
				new GatekeeperError({
					detail: `${this.label}: another control is in progress`,
				}),
			)
		}
		this.controlling = true
		return run().then(
			() => {
				this.controlling = false
			},
			(error: unknown) => {
				this.controlling = false
				throw error
			},
		)
	}
}
