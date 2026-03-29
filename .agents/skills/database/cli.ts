#!/usr/bin/env tsx

import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { AuthTypes, Connector } from "@google-cloud/cloud-sql-connector";
import { GoogleAuth, Impersonated } from "google-auth-library";
import { getSharedConfig } from "@repo/config/sharedConfig";

const config = getSharedConfig("development");

type Target = "local" | "production";

async function createPool(target: Target): Promise<{ pool: pg.Pool; cleanup: () => Promise<void> }> {
	if (target === "production") {
		// Use ADC (local user credentials) to impersonate the service account
		const sourceAuth = new GoogleAuth({
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
		});
		const sourceClient = await sourceAuth.getClient();
		const impersonatedClient = new Impersonated({
			sourceClient,
			targetPrincipal: config.applicationsServiceAccount,
			targetScopes: ["https://www.googleapis.com/auth/cloud-platform"],
			lifetime: 3600,
		});
		const auth = new GoogleAuth({ authClient: impersonatedClient });

		const connector = new Connector({ auth });
		const clientOpts = await connector.getOptions({
			instanceConnectionName: config.agentCloudSqlInstance,
			authType: AuthTypes.IAM,
		});
		const pool = new pg.Pool({
			...clientOpts,
			user: config.applicationsServiceAccount.replace(".gserviceaccount.com", ""),
			database: "halo_agent",
			max: 1,
		});
		return {
			pool,
			cleanup: async () => {
				connector.close();
				await pool.end();
			},
		};
	}

	const pool = new pg.Pool({
		connectionString: config.agentDatabaseUrl,
		max: 1,
	});
	return { pool, cleanup: () => pool.end() };
}

function formatRows(rows: Record<string, unknown>[]): string {
	if (rows.length === 0) {
		return "Query returned no rows.";
	}
	return rows
		.map((row) =>
			Object.entries(row)
				.map(([k, v]) => {
					const formattedValue =
						typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
					return `${k}: ${formattedValue}`;
				})
				.join(" | "),
		)
		.join("\n");
}

async function runQuery(target: Target, sqlQuery: string): Promise<string> {
	const { pool, cleanup } = await createPool(target);
	const db = drizzle({ client: pool });

	try {
		const accessMode = target === "production" ? "read only" as const : undefined;

		const result = await db.transaction(
			async (tx) => {
				return await tx.execute(sql.raw(sqlQuery));
			},
			{ accessMode },
		);

		return formatRows(result.rows as Record<string, unknown>[]);
	} catch (error) {
		if (error instanceof Error) {
			// Drizzle wraps pg errors in cause
			const cause = error.cause;
			if (cause instanceof Error) {
				const pgError = cause as Error & {
					code?: string;
					detail?: string;
					hint?: string;
					constraint?: string;
					table?: string;
				};
				const parts = [pgError.message];
				if (pgError.code) parts.push(`Code: ${pgError.code}`);
				if (pgError.detail) parts.push(`Detail: ${pgError.detail}`);
				if (pgError.hint) parts.push(`Hint: ${pgError.hint}`);
				if (pgError.constraint) parts.push(`Constraint: ${pgError.constraint}`);
				if (pgError.table) parts.push(`Table: ${pgError.table}`);
				return `Error: ${parts.join("\n")}`;
			}
			return `Error: ${error.message}`;
		}
		return `Error: ${String(error)}`;
	} finally {
		await cleanup();
	}
}

function printUsage() {
	console.log(`Usage: database query <sql> [--target local|production]

Commands:
  query <sql>   Execute a SQL query

Options:
  --target      Database target: "local" (default) or "production"
                Local has full read/write access.
                Production is always read-only.

Examples:
  database query "SELECT * FROM threads LIMIT 5"
  database query "SELECT tablename FROM pg_tables WHERE schemaname = 'public'" --target production`);
}

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printUsage();
		process.exit(0);
	}

	const command = args[0];
	if (command !== "query") {
		console.error(`Unknown command: ${command}`);
		printUsage();
		process.exit(1);
	}

	let target: Target = "local";
	let sqlQuery: string | undefined;

	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--target") {
			const t = args[i + 1];
			if (t !== "local" && t !== "production") {
				console.error(`Invalid target: ${t}. Must be "local" or "production".`);
				process.exit(1);
			}
			target = t;
			i++;
		} else if (!sqlQuery) {
			sqlQuery = args[i];
		}
	}

	if (!sqlQuery) {
		console.error("Error: SQL query is required.");
		console.error('Example: database query "SELECT * FROM threads LIMIT 5"');
		process.exit(1);
	}

	const result = await runQuery(target, sqlQuery);
	console.log(result);
}

main();
