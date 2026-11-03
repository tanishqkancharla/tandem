import crypto from "node:crypto"
import pg from "pg"
import { test as baseTest } from "vitest"
import { tandemPostgresTuplesSql } from "../src/index.js"

const serverUrl = process.env.TANDEM_POSTGRES_TEST_URL

if (!serverUrl) {
	console.warn(
		"Skipping Postgres storage tests: set TANDEM_POSTGRES_TEST_URL to a Postgres URL whose user can create databases.",
	)
}

/**
 * Gives each test its own database with the Tandem table, so tests and their
 * notifications stay apart. Skips when no Postgres server is configured.
 */
export const test = baseTest
	.extend<{ databaseUrl: string }>({
		databaseUrl: async ({}, use) => {
			const name = `tandem_test_${crypto.randomUUID().replaceAll("-", "")}`
			const admin = new pg.Client({ connectionString: serverUrl })
			await admin.connect()
			await admin.query(`CREATE DATABASE ${name}`)
			const url = new URL(serverUrl!)
			url.pathname = `/${name}`
			const setup = new pg.Client({ connectionString: url.toString() })
			await setup.connect()
			await setup.query(tandemPostgresTuplesSql)
			await setup.end()

			await use(url.toString())

			await admin.query(`DROP DATABASE ${name} WITH (FORCE)`)
			await admin.end()
		},
	})
	.skipIf(!serverUrl)
