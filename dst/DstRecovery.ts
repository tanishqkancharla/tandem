import {
	DstWorld,
	type DstIntent,
	type DstOutcome,
	type DstTraceRecord,
} from "./DstWorld.js"

export type DstRecoveryResult = {
	ordinary: "passed" | "budgetExceeded" | "viewMismatch" | "notRun"
	repaired: "passed" | "viewMismatch"
	eventsDelivered: number
}

export function recoveryOutcome(
	ordinary: DstOutcome | undefined,
	repaired: DstOutcome,
	eventsDelivered: number,
) {
	const recovery: DstRecoveryResult = {
		ordinary:
			ordinary === undefined
				? "notRun"
				: !ordinary.settled
					? "budgetExceeded"
					: ordinary.violation
						? "viewMismatch"
						: "passed",
		repaired: repaired.violation ? "viewMismatch" : "passed",
		eventsDelivered,
	}
	return {
		...repaired,
		violation: ordinary?.violation ?? repaired.violation,
		recovery,
	}
}

/** A finite fair delivery schedule, not a claim that infinite timers quiesce. */
export async function recover(
	world: DstWorld,
	{
		startStep,
		eventBudget,
		record,
	}: {
		startStep: number
		eventBudget: number
		record: (event: DstTraceRecord) => void
	},
) {
	let step = startStep
	const emit = async (intent: DstIntent) => {
		world.pending()
		const event = await world.apply(step++, intent)
		record(event)
		await world.settle()
		return event
	}
	for (const client of world.partitioned) await emit({ type: "heal", client })
	for (const client of world.down) await emit({ type: "restart", client })
	for (const client of world.offline) await emit({ type: "reconnect", client })
	if (world.tabs && world.tabs.alive.length === 0)
		await emit({ type: "openTab" })
	for (const tab of world.tabs?.offline ?? [])
		await emit({ type: "toggleTab", tab })
	for (const tab of world.tabs?.alive ?? [])
		await emit({ type: "flushTab", tab })
	for (const tab of new Set([
		...(world.tabs?.unacceptedTabs ?? []),
		...(world.tabs?.failedConnectionTabs ?? []),
	]))
		await emit({ type: "connectTab", tab })
	let queue: string[] = []
	let eventsDelivered = 0
	for (; eventsDelivered < eventBudget; eventsDelivered++) {
		const pending = new Set(world.pending().map(({ name }) => name))
		if (world.serverTicksPending > 0) pending.add("serverTick")
		queue = queue.filter((name) => pending.has(name))
		for (const name of pending) if (!queue.includes(name)) queue.push(name)
		const next = queue.shift()
		if (!next) break
		await emit(
			next === "serverTick"
				? { type: "serverTick" }
				: { type: "advance", call: next },
		)
	}
	const ordinary = await emit({ type: "checkpoint" })
	const repaired = await emit({ type: "repair" })
	if (ordinary.type !== "checkpoint" || repaired.type !== "repair")
		throw new Error("Recovery returned a different event")
	return recoveryOutcome(ordinary.outcome, repaired.outcome, eventsDelivered)
}
