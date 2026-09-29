import { match } from "@tanishqkancharla/tandem-core"
import {
	type Action,
	CLIENTS,
	type ClientName,
	createWorld,
	type Model,
	type Records,
	type Snapshot,
	type World,
} from "./sim"

export type Frame = {
	label: string
	snapshot: Snapshot
	status: "" | "bad" | "good"
	focus?: ClientName
}
export type Verdict = { pass: boolean; text: string }
export type VideoProps = {
	issue: number
	title: string
	mode: "failure" | "success"
	subtitle: string
	terminal?: {
		command: string
		output: string[]
		commit: string
		steps: number
	}
	rules?: string[]
	diff?: string
	frames: Frame[]
	verdict: Verdict
	closing: string
}

type ScenarioStep = { label: string; actions: Action[] }
type Issue = {
	num: number
	slug: string
	title: string
	artifact: string
	seed: string
	recordedSteps: number
	output: string[]
	steps: ScenarioStep[]
	check: (world: World) => Verdict
	rules: string[]
	diff: string
}

const both = (a: (c: ClientName) => Action): Action[] => CLIENTS.map(a)
const setup = (extra: Action[] = []): ScenarioStep => ({
	label: "Both clients subscribe to every record and sync",
	actions: [
		...both((c) => ({ a: "subscribe", c })),
		...extra,
		...both((c) => ({ a: "pull", c })),
	],
})
const show = (records: Records) =>
	Object.keys(records).length
		? Object.entries(records)
				.map(([k, v]) => `${k} "${v}"`)
				.join(", ")
		: "nothing"
const same = (a: Records, b: Records) => JSON.stringify(a) === JSON.stringify(b)

function converged(world: World, c: ClientName): Verdict {
	const client = world.clientRecords(c)
	const server = world.serverRecords()
	return same(client, server)
		? { pass: true, text: `${c} matches the server: ${show(server)}` }
		: {
				pass: false,
				text: `${c} shows ${show(client)}; the server has ${show(server)}`,
			}
}

const PHASE1 = `TandemClient.applyPatchAt → applyPull({ patch, lastMutationId })
-  if (patch is empty) return
-  undo speculative writes with their saved undo values
-  apply patch, redo writes after the acked one
+  base.apply(patch)                  // base = last server state
+  pending = pending.filter((m) => m.id > lastMutationId)
+  visible = base + replay(pending)   // nothing is undone

TandemServer.readPull
-  lastMutationId = client.lastMutationId
-  client.lastMutationId = undefined  // cleared once read
+  lastMutationId = client.lastMutationId ?? 0  // on every pull`

const PHASE3 = `SyncEngine.push()
-  catch (error) { handleRollback(mutations); throw error }
+  .catch(() => retry on the next sync tick)   // writes stay pending

TandemServer.applyPush(clientId, mutations)
+  if (mutation.id <= client.lastMutationId) continue  // already applied
+  if (mutation.id > last + 1) return gap error
   apply ops; client.lastMutationId = mutation.id      // same transaction`

const PHASE4 = `Client storage
-  persist visible ["record", …] tuples only
+  persist base, pending mutations, clientId,
+  lastMutationId counter, and cookie

On restart
+  load base, replay pending, keep the same client id,
+  push pending on connect`

const BASE_RULES = [
	"The client keeps the last server state (the base) apart from its pending writes",
	"A pull applies the patch to the base, then replays pending writes",
	"Every pull reports lastMutationId; writes up to it are confirmed",
]

export const ISSUES: Issue[] = [
	{
		num: 41,
		slug: "empty-patch-drops-ack",
		title: "An empty patch drops its acknowledgement",
		artifact: "dst/known-failures/seed-2-empty-patch-drops-ack.jsonl",
		seed: "seed 2, 30 steps",
		recordedSteps: 30,
		output: [
			"replaying dst/known-failures/seed-2-empty-patch-drops-ack.jsonl: seed 2",
			"client2 disagrees with the model at quiescence",
			"  expected: Note item-1 (rev 6), Note item-2 (rev 29), Note item-3 (rev 27)",
			"  actual:   Note item-1 (rev 6), Note item-3 (rev 27)",
		],
		steps: [
			setup(),
			{
				label: "client1 creates todo-1",
				actions: [
					{ a: "set", c: "client1", key: "todo-1", value: "Short-lived" },
				],
			},
			{
				label: "client1 pushes; its pokes are lost from here on",
				actions: [{ a: "push", c: "client1" }],
			},
			{ label: "client2 pulls todo-1", actions: [{ a: "pull", c: "client2" }] },
			{
				label: "client2 deletes todo-1 and pushes",
				actions: [
					{ a: "remove", c: "client2", key: "todo-1" },
					{ a: "push", c: "client2" },
				],
			},
			{ label: "client2 pulls", actions: [{ a: "pull", c: "client2" }] },
			{
				label: "client1 finally pulls: nothing to send, but an ack",
				actions: [{ a: "pull", c: "client1" }],
			},
		],
		check: (w) => converged(w, "client1"),
		rules: BASE_RULES,
		diff: PHASE1,
	},
	{
		num: 42,
		slug: "pushed-keys-not-synced",
		title: "A pushed key comes back after its remove is acknowledged",
		artifact: "dst/known-failures/seed-216-pushed-keys-not-synced.jsonl",
		seed: "seed 216, 30 steps",
		recordedSteps: 30,
		output: [
			"replaying dst/known-failures/seed-216-pushed-keys-not-synced.jsonl: seed 216",
			"client2 disagrees with the model at quiescence",
			"  expected: Note item-2 (rev 23), Note item-3 (rev 27)",
			"  actual:   Note item-1 (rev 1), Note item-2 (rev 23), Note item-3 (rev 27)",
		],
		steps: [
			setup([
				{ a: "set", c: "client1", key: "item-3", value: "rev 0" },
				{ a: "push", c: "client1" },
			]),
			{
				label: "client2 creates item-1 and pushes",
				actions: [
					{ a: "set", c: "client2", key: "item-1", value: "rev 1" },
					{ a: "push", c: "client2" },
				],
			},
			{ label: "client1 pulls item-1", actions: [{ a: "pull", c: "client1" }] },
			{
				label: "client1 deletes item-1, pushes, and pulls",
				actions: [
					{ a: "remove", c: "client1", key: "item-1" },
					{ a: "push", c: "client1" },
					{ a: "pull", c: "client1" },
				],
			},
			{
				label: "client2 also removes item-1",
				actions: [{ a: "remove", c: "client2", key: "item-1" }],
			},
			{
				label: "client2 pulls: its create is acknowledged",
				actions: [{ a: "pull", c: "client2" }],
			},
			{
				label: "client2 pushes its remove",
				actions: [{ a: "push", c: "client2" }],
			},
			{
				label: "client2 pulls: its remove is acknowledged",
				actions: [{ a: "pull", c: "client2" }],
			},
		],
		check: (w) => converged(w, "client2"),
		rules: BASE_RULES,
		diff: PHASE1,
	},
	{
		num: 43,
		slug: "lost-push-rolls-back",
		title: "A push that fails in transit is treated as a rejection",
		artifact: "dst/known-failures/seed-2-lost-push-rolls-back.jsonl",
		seed: "seed 2, 10 steps, fault rate 0.1",
		recordedSteps: 4,
		output: [
			"replaying dst/known-failures/seed-2-lost-push-rolls-back.jsonl: seed 2",
			"client2 disagrees with the model at step 3",
			"  expected: Note item-2 (rev 1)",
			"  actual:   (none)",
		],
		steps: [
			setup(),
			{
				label: "client2 creates item-2",
				actions: [{ a: "set", c: "client2", key: "item-2", value: "rev 1" }],
			},
			{
				label: "client2 pushes, and the request is lost",
				actions: [{ a: "push", c: "client2", lost: true }],
			},
			{
				label: "client2 pushes again on its next sync tick",
				actions: [{ a: "push", c: "client2" }],
			},
			{ label: "Both clients pull", actions: both((c) => ({ a: "pull", c })) },
		],
		check: (w) => {
			const onServer = "item-2" in w.serverRecords()
			if (!onServer)
				return {
					pass: false,
					text: `item-2 never reaches the server; client2 shows ${show(w.clientRecords("client2"))}`,
				}
			return converged(w, "client1").pass && converged(w, "client2").pass
				? {
						pass: true,
						text: `item-2 reached the server, and both clients show it`,
					}
				: converged(w, "client2")
		},
		rules: [
			...BASE_RULES.slice(0, 1),
			"A failed push is retried; writes stay pending until acknowledged",
			"The server skips mutation ids it already applied, so retries are safe",
		],
		diff: PHASE3,
	},
	{
		num: 44,
		slug: "crash-loses-outbox",
		title: "A crash loses writes that were stored but not pushed",
		artifact: "dst/known-failures/seed-13-crash-loses-outbox.jsonl",
		seed: "seed 13, 15 steps, crash rate 0.1",
		recordedSteps: 15,
		output: [
			"replaying dst/known-failures/seed-13-crash-loses-outbox.jsonl: seed 13",
			"client2 disagrees with the model at quiescence",
			"  expected: Note item-1 (rev 9), Note item-3 (rev 14)",
			"  actual:   Note item-1 (rev 9), Note item-2 (rev 5), Note item-3 (rev 14)",
		],
		steps: [
			setup(),
			{
				label: "client2 creates item-2; it reaches local storage",
				actions: [{ a: "set", c: "client2", key: "item-2", value: "rev 5" }],
			},
			{
				label: "client2 crashes before its push",
				actions: [{ a: "crash", c: "client2" }],
			},
			{
				label: "client2 restarts from storage",
				actions: [{ a: "restart", c: "client2" }],
			},
			{
				label: "client2 pushes on connect",
				actions: [{ a: "push", c: "client2" }],
			},
			{ label: "Both clients pull", actions: both((c) => ({ a: "pull", c })) },
		],
		check: (w) => {
			const server = w.serverRecords()
			if (!("item-2" in server))
				return {
					pass: false,
					text: `client2 shows ${show(w.clientRecords("client2"))}, but the server never received item-2`,
				}
			return converged(w, "client1").pass && converged(w, "client2").pass
				? {
						pass: true,
						text: "item-2 reached the server after the restart, and both clients show it",
					}
				: converged(w, "client2")
		},
		rules: [
			"Client storage keeps the base, pending writes, client id, and mutation counter",
			"On restart, pending writes are replayed and pushed",
			"The server skips mutation ids it already applied",
		],
		diff: PHASE4,
	},
]

export function framesFor(
	issue: Issue,
	model: Model,
): { frames: Frame[]; verdict: Verdict } {
	const world = createWorld(model)
	const frames = issue.steps.map((step) => {
		const merged = {
			messages: [] as Snapshot["messages"],
			notes: [] as Snapshot["notes"],
		}
		for (const action of step.actions) {
			const result = world.apply(action)
			// Setup pulls are noise; only show messages for single-purpose steps.
			if (step !== issue.steps[0]) merged.messages.push(...result.messages)
			merged.notes.push(...result.notes)
		}
		if (step === issue.steps[0]) merged.notes = []
		const status: Frame["status"] = merged.notes.some((n) => n.kind === "bad")
			? "bad"
			: merged.notes.some((n) => n.kind === "good")
				? "good"
				: ""
		const actors = [...new Set(step.actions.map((a) => a.c))]
		return {
			label: step.label,
			snapshot: world.snapshot(merged),
			status,
			focus: actors.length === 1 ? actors[0] : undefined,
		}
	})
	return { frames, verdict: issue.check(world) }
}

export function videoProps(issue: Issue, mode: VideoProps["mode"]): VideoProps {
	const model = match<Model, VideoProps["mode"]>(mode, {
		failure: "current",
		success: "proposed",
	})
	const { frames, verdict } = framesFor(issue, model)
	return match<VideoProps, VideoProps["mode"]>(mode, {
		failure: () => ({
			issue: issue.num,
			title: issue.title,
			mode,
			subtitle: `Found by DST · ${issue.seed}`,
			terminal: {
				command: `pnpm dst:run --replay ${issue.artifact}`,
				output: issue.output,
				commit: "main @ e2ec755",
				steps: issue.recordedSteps,
			},
			frames,
			verdict,
			closing:
				"On main at e2ec755, the recorded run fails, and the simplified scenario shows why.",
		}),
		success: () => ({
			issue: issue.num,
			title: issue.title,
			mode,
			subtitle: "Proposed fix · Replicache-style sync",
			rules: issue.rules,
			diff: issue.diff,
			frames,
			verdict,
			closing: `Simulated with the proposed rules; not implemented yet. Once it is, the replay of ${issue.artifact.split("/").pop()} should report no violation.`,
		}),
	})
}

export const VIDEOS = ISSUES.flatMap((issue) =>
	(["failure", "success"] as const).map((mode) => ({
		id: `issue-${issue.num}-${mode}`,
		issue,
		mode,
		props: videoProps(issue, mode),
	})),
)
