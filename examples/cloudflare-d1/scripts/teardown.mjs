#!/usr/bin/env node
// Delete the demo Workers (including the Durable Object namespace) and D1 databases.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dirname, "..")
const statePath = path.join(root, ".deploy", "state.json")
const state = JSON.parse(fs.readFileSync(statePath, "utf8"))
const wrangler = path.join(
	root,
	"apps",
	"app",
	"node_modules",
	".bin",
	"wrangler",
)
const run = (args) =>
	execFileSync(wrangler, args, {
		input: "y\n",
		stdio: ["pipe", "inherit", "inherit"],
		cwd: path.join(root, "apps", "app"),
	})

for (const worker of [
	state.coordinator?.worker,
	state.first?.worker,
	state.second?.worker,
]) {
	if (worker) run(["delete", worker])
}
for (const app of [state.first, state.second]) {
	if (app?.worker) run(["d1", "delete", app.worker, "--skip-confirmation"])
}
fs.rmSync(path.join(root, ".deploy"), { recursive: true, force: true })
console.log(
	"Deleted the demo Workers, Durable Object namespace, and D1 databases.",
)
