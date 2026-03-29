#!/usr/bin/env tsx

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");
const logsDir = resolve(rootDir, "tmp/logs");

function getServerUrl(): string {
	const stateFile = findStateFile();
	if (stateFile) {
		try {
			const state = JSON.parse(readFileSync(stateFile, "utf-8")) as { serverUrl?: string };
			if (typeof state.serverUrl === "string" && state.serverUrl.length > 0) {
				return state.serverUrl;
			}
		} catch {
			// fall through
		}
	}
	return "http://localhost:3000";
}

function findStateFile(): string | undefined {
	// Replicate the branch-based state key logic from dev-cli
	const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
		encoding: "utf-8",
		cwd: rootDir,
	});
	let branchKey = "default";
	if (branchResult.status === 0) {
		const branch = branchResult.stdout.trim();
		if (branch.length > 0) {
			branchKey = branch.replace(/[\s/]+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-");
		}
	}
	if (branchKey === "HEAD") {
		const gitDirResult = spawnSync("git", ["rev-parse", "--git-dir"], {
			encoding: "utf-8",
			cwd: rootDir,
		});
		let workspaceKey = "workspace";
		if (gitDirResult.status === 0) {
			const gitDir = gitDirResult.stdout.trim();
			const gitDirName = basename(gitDir).replace(/[\s/]+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-");
			if (gitDirName !== ".git" && gitDirName !== "default") {
				workspaceKey = gitDirName;
			}
		}
		branchKey = `${branchKey}-${workspaceKey}`;
	}
	const stateFile = resolve(logsDir, `dev-${branchKey}.state.json`);
	if (existsSync(stateFile)) {
		return stateFile;
	}
	return undefined;
}

const CACHE_DIR = join(__dirname, ".cache");
const API_KEY_FILE = join(CACHE_DIR, "api-key.json");

type CachedAuth = {
	apiKey: string;
	userId: string;
	email: string;
};

function loadCachedAuth(): CachedAuth | undefined {
	try {
		const data = JSON.parse(readFileSync(API_KEY_FILE, "utf-8")) as CachedAuth;
		if (typeof data.apiKey === "string" && data.apiKey.length > 0) {
			return data;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function saveCachedAuth(auth: CachedAuth): void {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(API_KEY_FILE, JSON.stringify(auth, null, 2));
}

async function authenticate(): Promise<CachedAuth> {
	const cached = loadCachedAuth();
	if (cached) {
		return cached;
	}

	const idToken = execSync("gcloud auth print-identity-token", {
		encoding: "utf-8",
	}).trim();

	const serverUrl = getServerUrl();
	const response = await fetch(`${serverUrl}/api/auth/cli-login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ idToken }),
	});

	if (!response.ok) {
		const text = await response.text();
		let message = text;
		try {
			const body = JSON.parse(text) as { error?: string };
			if (body.error) {
				message = body.error;
			}
		} catch {
			// use raw text
		}
		throw new Error(`CLI login failed (${response.status}): ${message}`);
	}

	const data = (await response.json()) as {
		apiKey: string;
		user: { id: string; email: string };
	};

	const auth: CachedAuth = {
		apiKey: data.apiKey,
		userId: data.user.id,
		email: data.user.email,
	};

	saveCachedAuth(auth);
	return auth;
}

async function rpcCall(
	apiKey: string,
	procedure: string,
	input: unknown,
): Promise<unknown> {
	const serverUrl = getServerUrl();
	const url = `${serverUrl}/rpc/${procedure.replace(/\./g, "/")}`;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify({ json: input }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`RPC call failed (${response.status}): ${text}`);
	}

	const contentType = response.headers.get("content-type");
	if (contentType?.includes("application/json")) {
		return response.json();
	}

	return response.text();
}

function printUsage() {
	console.log(`Usage: server <command> [options]

Commands:
  call <procedure> [json]   Call an RPC procedure on the local dev server
  login                     Authenticate and cache an API key
  logout                    Clear cached authentication

Options:
  --help, -h                Show this help message

Examples:
  server call threads.list
  server call threads.get '{"id": "abc-123"}'
  server call threads.create '{"title": "My Thread"}'
  server call dev.usersList
  server login
  server logout`);
}

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printUsage();
		process.exit(0);
	}

	const command = args[0];

	if (command === "login") {
		const auth = await authenticate();
		console.log(`Authenticated as ${auth.email} (${auth.userId})`);
		return;
	}

	if (command === "logout") {
		try {
			const { unlinkSync } = await import("node:fs");
			unlinkSync(API_KEY_FILE);
			console.log("Logged out (cached API key removed).");
		} catch {
			console.log("No cached authentication to clear.");
		}
		return;
	}

	if (command === "call") {
		const procedure = args[1];
		if (!procedure) {
			console.error("Error: procedure name is required.");
			console.error('Example: server call threads.list');
			process.exit(1);
		}

		let input: unknown = {};
		const jsonArg = args[2];
		if (typeof jsonArg === "string" && jsonArg.length > 0) {
			try {
				input = JSON.parse(jsonArg);
			} catch (error) {
				console.error(
					`Error: invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
				);
				process.exit(1);
			}
		}

		const auth = await authenticate();
		const result = await rpcCall(auth.apiKey, procedure, input);
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.error(`Unknown command: ${command}`);
	printUsage();
	process.exit(1);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
