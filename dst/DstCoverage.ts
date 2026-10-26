import type { DstClientName, DstFaultKind, DstSchema } from "./DstWorld.js"

/** Observations from executed public operations, not generated intentions. */
export type DstCoverage = {
	mutationsByClient: Record<DstClientName, number>
	operations: Record<string, number>
	batchSizes: Record<string, number>
	multiOperationCommits: number
	compoundIdentityCommits: number
	conflictingMutations: number
	subscriptionChanges: number
	callbacks: number
	nonemptyCallbacks: number
	pageMembershipChanges: number
	filterMembershipChanges: number
	viewChecks: number
	nonemptyViewChecks: number
	offsetViewChecks: number
	nestedRelationChecks: number
	compoundViewChecks: number
	dropsByKind: Record<DstFaultKind, number>
	partitionDrops: number
	disconnects: number
	reconnects: number
	crashesBeforeDurability: number
	crashesAfterDurability: number
	restarts: number
}

const collections = [
	"projects",
	"tasks",
	"comments",
	"memberships",
] as const satisfies readonly (keyof DstSchema)[]

const faultKinds = [
	"requestLost",
	"responseLost",
	"pokeLost",
] as const satisfies readonly DstFaultKind[]

const writeChecks = [
	"multiOperationCommits",
	"compoundIdentityCommits",
] as const

const subscriptionChecks = [
	"subscriptionChanges",
	"callbacks",
	"nonemptyCallbacks",
	"pageMembershipChanges",
	"filterMembershipChanges",
	"viewChecks",
	"nonemptyViewChecks",
	"offsetViewChecks",
	"nestedRelationChecks",
	"compoundViewChecks",
] as const

const faultChecks = ["partitionDrops", "disconnects", "reconnects"] as const
const crashChecks = [
	"crashesBeforeDurability",
	"crashesAfterDurability",
	"restarts",
] as const

export function emptyCoverage(
	clientNames: readonly DstClientName[],
): DstCoverage {
	return {
		mutationsByClient: Object.fromEntries(clientNames.map((name) => [name, 0])),
		operations: {},
		batchSizes: {},
		multiOperationCommits: 0,
		compoundIdentityCommits: 0,
		conflictingMutations: 0,
		subscriptionChanges: 0,
		callbacks: 0,
		nonemptyCallbacks: 0,
		pageMembershipChanges: 0,
		filterMembershipChanges: 0,
		viewChecks: 0,
		nonemptyViewChecks: 0,
		offsetViewChecks: 0,
		nestedRelationChecks: 0,
		compoundViewChecks: 0,
		dropsByKind: {
			requestLost: 0,
			responseLost: 0,
			pokeLost: 0,
		},
		partitionDrops: 0,
		disconnects: 0,
		reconnects: 0,
		crashesBeforeDurability: 0,
		crashesAfterDurability: 0,
		restarts: 0,
	}
}

function sumCounts<Key extends string>(
	target: Record<Key, number>,
	source: Record<Key, number>,
): void {
	for (const key of Object.keys(source) as Key[]) {
		target[key] = (target[key] ?? 0) + source[key]
	}
}

/** Sweep requirements may be satisfied by different seeds. */
export function aggregateCoverage(
	coverages: readonly DstCoverage[],
): DstCoverage {
	const total = emptyCoverage([])
	for (const coverage of coverages) {
		sumCounts(total.mutationsByClient, coverage.mutationsByClient)
		sumCounts(total.operations, coverage.operations)
		sumCounts(total.batchSizes, coverage.batchSizes)
		sumCounts(total.dropsByKind, coverage.dropsByKind)
		for (const key of [
			...writeChecks,
			"conflictingMutations",
			...subscriptionChecks,
			...faultChecks,
			...crashChecks,
		] as const) {
			total[key] += coverage[key]
		}
	}
	return total
}

export function missingCoverage(
	coverage: DstCoverage,
	profile: "writes" | "subscriptions" | "faults" | "crashes" | "all",
): string[] {
	const missing: string[] = []
	if (profile === "writes" || profile === "all") {
		for (const [client, count] of Object.entries(coverage.mutationsByClient)) {
			if (!(count > 0)) missing.push(`mutationsByClient.${client}`)
		}
		for (const collection of collections) {
			for (const operation of ["set", "update", "remove"] as const) {
				const key = `${collection}.${operation}`
				if (!((coverage.operations[key] ?? 0) > 0)) {
					missing.push(`operations.${key}`)
				}
			}
		}
		for (const key of writeChecks) {
			if (!(coverage[key] > 0)) missing.push(key)
		}
		if (
			Object.keys(coverage.mutationsByClient).length > 1 &&
			!(coverage.conflictingMutations > 0)
		) {
			missing.push("conflictingMutations")
		}
	}
	if (profile === "subscriptions" || profile === "all") {
		for (const key of subscriptionChecks) {
			if (!(coverage[key] > 0)) missing.push(key)
		}
	}
	if (profile === "faults" || profile === "all") {
		for (const kind of faultKinds) {
			if (!(coverage.dropsByKind[kind] > 0)) missing.push(`dropsByKind.${kind}`)
		}
		for (const key of faultChecks) {
			if (!(coverage[key] > 0)) missing.push(key)
		}
	}
	if (profile === "crashes" || profile === "all") {
		for (const key of crashChecks) {
			if (!(coverage[key] > 0)) missing.push(key)
		}
	}
	return missing
}
