import * as errore from "errore"

export class InvalidValue extends errore.createTaggedError({
	name: "InvalidValue",
	message: "Values must be nonnegative: $value",
}) {}

export class DeliveryFailed extends errore.createTaggedError({
	name: "DeliveryFailed",
	message: "The remote operation failed",
}) {}

export interface ValueStore {
	store(value: number): Promise<number | InvalidValue>
	fetch(): Promise<number>
}

/** A real in-process service. Its public read method lets a driver observe it. */
export class Server implements ValueStore {
	private value = 0

	read(): number {
		return this.value
	}

	store(value: number): Promise<number | InvalidValue> {
		if (value < 0) return Promise.resolve(new InvalidValue({ value }))
		this.value = value
		return Promise.resolve(value)
	}

	fetch(): Promise<number> {
		return Promise.resolve(this.value)
	}
}

/**
 * A small editor, independent of Gatekeeper and Tandem. Saves are queued, local
 * edits are immediate, and a stale read cannot overwrite a newer local edit.
 */
export class Client {
	private value = 0
	private revision = 0
	private pendingWrites = 0
	private previousWrite: Promise<void> = Promise.resolve()

	constructor(private readonly server: ValueStore) {}

	read(): number {
		return this.value
	}

	isSaving(): boolean {
		return this.pendingWrites > 0
	}

	write(value: number): Promise<number | InvalidValue | DeliveryFailed> {
		const previous = this.value
		const revision = ++this.revision
		this.value = value
		this.pendingWrites += 1

		const pending = this.previousWrite
			.then(() => this.server.store(value))
			.catch((cause) => new DeliveryFailed({ cause }))
			.then((result) => {
				this.pendingWrites -= 1
				if (result instanceof Error) {
					if (this.revision === revision) this.value = previous
					return result
				}
				return result
			})

		// Only the completion signal feeds the queue; the result goes to the caller.
		this.previousWrite = pending.then(() => undefined)
		return pending
	}

	async refresh(): Promise<number | DeliveryFailed> {
		const revision = this.revision
		const result = await this.server
			.fetch()
			.catch((cause) => new DeliveryFailed({ cause }))
		if (result instanceof Error) return result
		if (this.pendingWrites === 0 && this.revision === revision) {
			this.value = result
		}
		return result
	}

	/** One public action makes multiple visits to the same remote service. */
	async add(amount: number): Promise<number | InvalidValue | DeliveryFailed> {
		const result = await this.server
			.fetch()
			.catch((cause) => new DeliveryFailed({ cause }))
		if (result instanceof Error) return result
		return this.write(result + amount)
	}
}

/** Preparation finishes asynchronously before local editing and delivery. */
export class PreparingClient extends Client {
	override async write(value: number) {
		const prepared = await Promise.resolve(value)
		return super.write(prepared)
	}
}

/** A second service topology: a request passes through a forwarding client. */
export class Forwarder {
	constructor(private readonly client: Pick<Client, "write">) {}

	write(value: number): Promise<number | InvalidValue | DeliveryFailed> {
		return this.client.write(value)
	}
}
