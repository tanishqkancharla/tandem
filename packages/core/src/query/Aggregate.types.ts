import type { TandemClient } from "../TandemClient.js"
import type { Assert, TestIsEqual } from "../utils/typeUtils.js"

type Schema = {
	threads: {
		id: string
		workspaceId: string
		replyCount: number
		active: boolean
	}
}
declare const client: TandemClient<Schema>

const count = client.query({
	collection: "threads",
	aggregate: (rows) => rows.length,
})
type _Count = Assert<TestIsEqual<typeof count, number>>

const grouped = client.query({
	collection: "threads",
	groupBy: ["workspaceId"],
	aggregate: (rows) => ({ count: rows.length, average: rows[0]?.replyCount }),
})
const _expected: {
	workspaceId: string
	count: number
	average: number | undefined
}[] = grouped

const _subscribed = client.subscribe(
	{
		collection: "threads",
		where: { active: true },
		groupBy: ["workspaceId"],
		aggregate: (rows) => ({ count: rows.length }),
	},
	(result) => {
		type _Result = Assert<
			TestIsEqual<typeof result, { workspaceId: string; count: number }[]>
		>
	},
)

// @ts-expect-error Aggregate inputs cannot be paginated.
client.query({
	collection: "threads",
	limit: 2,
	aggregate: (rows) => rows.length,
})
// @ts-expect-error Nonprimitive fields cannot be grouping keys.
client.query({
	collection: "threads",
	groupBy: ["missing"],
	aggregate: (rows) => ({ count: rows.length }),
})
