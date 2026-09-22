import { execFileSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const allowedPackageFiles = new Set([
	"package.json",
	"README.md",
	"LICENSE",
	"LICENSE.md",
	"CHANGELOG.md",
])

main()

function main() {
	const packages = buildOrder(publishablePackages())
	const packed = []

	for (const pkg of packages) {
		const sentinel = join(pkg.dir, "dist", "stale-publish-sentinel.js")
		mkdirSync(dirname(sentinel), { recursive: true })
		writeFileSync(sentinel, "stale\n")
		run("pnpm", ["run", "build"], pkg.dir)
		if (existsSync(sentinel)) {
			throw new Error(`${pkg.manifest.name} build kept a stale dist file`)
		}

		const packDir = join(repoRoot, "tmp", "publish-smoke-pack")
		mkdirSync(packDir, { recursive: true })
		const output = run("pnpm", ["pack", "--pack-destination", packDir], pkg.dir)
		const tarballName = output.trim().split("\n").at(-1).trim()
		const tarball = tarballName.startsWith("/")
			? tarballName
			: join(packDir, tarballName)
		assertTarball(pkg, tarball)
		packed.push({ ...pkg, tarball })
		console.log(`${pkg.manifest.name} packed ${tarballName}`)
	}

	const smokeRoot = join(tmpdir(), "tandem-publish-smoke")
	rmSync(smokeRoot, { recursive: true, force: true })
	mkdirSync(smokeRoot, { recursive: true })
	const installed = installPackedPackages(smokeRoot, packed)

	for (const pkg of installed) {
		for (const specifier of importSpecifiers(pkg.manifest)) {
			const resolved = resolveInstalled(smokeRoot, specifier)
			if (!resolved.startsWith(`${smokeRoot}/`)) {
				throw new Error(
					`${specifier} resolved outside the packed install: ${resolved}`,
				)
			}
			run(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`await import(${JSON.stringify(specifier)})`,
				],
				smokeRoot,
			)
			console.log(`imported ${specifier}`)
		}
	}

	rmSync(smokeRoot, { recursive: true, force: true })
	rmSync(join(repoRoot, "tmp", "publish-smoke-pack"), {
		recursive: true,
		force: true,
	})
}

function publishablePackages() {
	return readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const dir = join(repoRoot, "packages", entry.name)
			return {
				dir,
				manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
			}
		})
		.filter((pkg) => pkg.manifest.private !== true && pkg.manifest.name)
}

function buildOrder(packages) {
	const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]))
	const ordered = []
	const visiting = new Set()
	const visited = new Set()

	function visit(pkg) {
		if (visited.has(pkg.manifest.name)) return
		if (visiting.has(pkg.manifest.name)) {
			throw new Error(`Package dependency cycle at ${pkg.manifest.name}`)
		}
		visiting.add(pkg.manifest.name)
		for (const [name, version] of Object.entries({
			...pkg.manifest.dependencies,
			...pkg.manifest.peerDependencies,
		})) {
			if (
				typeof version === "string" &&
				version.startsWith("workspace:") &&
				byName.has(name)
			) {
				visit(byName.get(name))
			}
		}
		visiting.delete(pkg.manifest.name)
		visited.add(pkg.manifest.name)
		ordered.push(pkg)
	}

	for (const pkg of packages) visit(pkg)
	return ordered
}

function assertTarball(pkg, tarball) {
	const listing = run("tar", ["-tzf", tarball], repoRoot)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.endsWith("/"))
		.map((line) => line.replace(/^package\//, ""))

	for (const file of listing) {
		if (isForbiddenPackageFile(file)) {
			throw new Error(`${pkg.manifest.name} tarball includes ${file}`)
		}
	}

	const packedManifest = JSON.parse(
		run("tar", ["-xOf", tarball, "package/package.json"], repoRoot),
	)
	for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
		for (const [name, version] of Object.entries(packedManifest[field] ?? {})) {
			if (String(version).startsWith("workspace:")) {
				throw new Error(
					`${pkg.manifest.name} packed ${field}.${name} is still ${version}`,
				)
			}
		}
	}

	for (const target of exportTargets(pkg.manifest.exports)) {
		const relative = target.replace(/^\.\//, "")
		if (!listing.includes(relative)) {
			throw new Error(`${pkg.manifest.name} tarball is missing ${relative}`)
		}
	}
}

function isForbiddenPackageFile(file) {
	if (allowedPackageFiles.has(file)) return false
	if (!file.startsWith("dist/")) return true
	if (file.endsWith(".map")) return true
	if (file.split("/").includes("src") || file.split("/").includes("test")) {
		return true
	}
	if (/(^|\/)(AGENTS|AGENT|CLAUDE)\.md$/.test(file)) return true
	if (file.includes("/.agents/") || file.startsWith(".agents/")) return true
	if (file.endsWith("SKILL.md")) return true
	if (/\.(spec|test)\./.test(file)) return true
	if (file.endsWith(".js") || file.endsWith(".d.ts")) return false
	return true
}

function exportTargets(exportsField) {
	const targets = []
	function visit(value) {
		if (typeof value === "string") {
			if (value.startsWith("./")) targets.push(value)
			return
		}
		if (value && typeof value === "object") {
			for (const child of Object.values(value)) visit(child)
		}
	}
	visit(exportsField)
	return [...new Set(targets)]
}

function importSpecifiers(manifest) {
	if (!manifest.exports || typeof manifest.exports !== "object") {
		throw new Error(`${manifest.name} is missing an exports map`)
	}
	return Object.keys(manifest.exports).map((key) => {
		if (key === ".") return manifest.name
		if (key.startsWith("./")) return `${manifest.name}/${key.slice(2)}`
		throw new Error(`${manifest.name} has unsupported export ${key}`)
	})
}

function installPackedPackages(smokeRoot, packages) {
	const dependencies = {}
	const overrides = {}
	for (const pkg of packages) {
		const filename = pkg.tarball.split("/").at(-1)
		const destination = join(smokeRoot, filename)
		writeFileSync(destination, readFileSync(pkg.tarball))
		dependencies[pkg.manifest.name] = `file:./${filename}`
		overrides[pkg.manifest.name] = `file:./${filename}`
	}
	for (const [name, version] of Object.entries(peerDependencies(packages))) {
		dependencies[name] = version
	}

	writeFileSync(
		join(smokeRoot, "package.json"),
		JSON.stringify(
			{
				name: "tandem-publish-smoke",
				private: true,
				type: "module",
				dependencies,
				overrides,
			},
			null,
			2,
		),
	)
	run("npm", ["install", "--no-fund", "--no-audit"], smokeRoot)
	return packages
}

function peerDependencies(packages) {
	const published = new Set(packages.map((pkg) => pkg.manifest.name))
	const peers = {}
	for (const pkg of packages) {
		for (const [name, range] of Object.entries(
			pkg.manifest.peerDependencies ?? {},
		)) {
			if (published.has(name)) continue
			peers[name] = pkg.manifest.devDependencies?.[name] ?? range
		}
	}
	return peers
}

function resolveInstalled(smokeRoot, specifier) {
	const resolved = run(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`console.log(import.meta.resolve(${JSON.stringify(specifier)}))`,
		],
		smokeRoot,
	).trim()
	return fileURLToPath(resolved)
}

function run(command, args, cwd) {
	return execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	})
}
