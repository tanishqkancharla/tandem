import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import {
	codec,
	collection,
	defineSchema,
	partialObject,
	string,
} from "@tanishqkancharla/tandem-core"

/** A class instance that survives storage only through its codec. */
export class EventStart {
	constructor(readonly iso: string) {}
}

export type TestsEvent = {
	id: string
	title: string
	startAt: EventStart
}

type TestsEventStorageValue = {
	id: string
	title: string
	startAt: string
}

export type TestsEventSchema = {
	events: TestsEvent
}

export const eventCodec = partialObject({
	id: string,
	title: string,
	startAt: codec<EventStart, string>(
		"EventStart",
		(input) => (input as EventStart).iso,
		(input) => new EventStart(input as string),
	),
})

export const testsEventRuntimeSchema = defineSchema({
	events: collection<TestsEvent, TestsEventStorageValue>({
		fields: ["id", "title", "startAt"],
		codec: eventCodec,
	}),
})

export function buildClientGatekeeper<Client extends object>(client: Client) {
	return new Gatekeeper().add("client", () => client).build()
}
