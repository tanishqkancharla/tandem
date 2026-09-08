import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

describe("schema package export", () => {
	test("browser schema helper is a separate export from native adapters", () => {
		const pkg = JSON.parse(
			readFileSync(join(serverRoot, "package.json"), "utf8"),
		) as {
			exports: Record<string, unknown>
		}

		expect(pkg.exports["./schema"]).toEqual({
			types: "./dist/drizzle/schema.d.ts",
			import: "./dist/drizzle/schema.js",
			default: "./dist/drizzle/schema.js",
		})
		expect(pkg.exports["./drizzle/sqlite"]).toBeDefined()
		expect(pkg.exports["./schema"]).not.toEqual(pkg.exports["./drizzle/sqlite"])

		const schemaSource = readFileSync(
			join(serverRoot, "src/drizzle/schema.ts"),
			"utf8",
		)
		expect(schemaSource).not.toMatch(/@tursodatabase\/database/)
		expect(schemaSource).not.toMatch(/better-sqlite3/)
		expect(schemaSource).not.toMatch(/node:fs/)
		expect(schemaSource).not.toMatch(/drizzle-orm\/tursodatabase/)
	})
})
