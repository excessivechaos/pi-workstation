/**
 * The workstation config, as code.
 *
 * One implementation shared by the install script (`bootstrap.mjs`, on a fresh machine) and the
 * extension (`index.ts`, on every session start after `pi update --extensions`). Keeping it in one
 * place is the point: a config that only the installer knows about drifts from the machines that
 * never run the installer again.
 *
 * Rules:
 *   - `settings.json` and `models.json` are MERGED. They hold machine state (locale, theme, keys,
 *     hand-added overrides), so the patch adds and overwrites its own keys and nothing else. Keys
 *     are never deleted: a removed patch key leaves whatever the machine already had.
 *   - `subscription-router.json`, `compaction-percent.json` and `cache-keepalive.json` are wholly
 *     ours and are replaced.
 *   - Files are written only when their content would change, so a converged machine writes nothing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Packages this workstation runs, unpinned so `pi update --extensions` follows upstream.
 * Order is significant: pi loads extensions in this order, and pi-compaction-percent must register
 * after pi-subscription-router (which publishes the next model) and after this package (which
 * writes its config before compaction-percent reloads it at session start).
 */
export const PACKAGES = [
	"git:github.com/excessivechaos/pi-workstation",
	"git:github.com/excessivechaos/pi-subscription-router",
	"git:github.com/excessivechaos/pi-quota-statusline",
	"git:github.com/excessivechaos/pi-cache-keepalive",
	"git:github.com/excessivechaos/pi-compaction-percent",
	"npm:pi-commandcode-provider",
	"npm:pi-web-access",
	"npm:@gotgenes/pi-anthropic-auth",
	"npm:@juicesharp/rpiv-ask-user-question",
];
/** Retired sources: removed before anything is installed, because two routers would register the same virtual models. */
export const REMOVED_PACKAGES = [
	"npm:@nredd/pi-subscription-router",
	"npm:pi-subagents",
	"npm:@cortexkit/pi-magic-context",
	"npm:@timmyjl12/pi-fallback-chains",
];
/** Installed only on request (see README): useful at 1h cache retention, inert at 5m. */
export const OPTIONAL_PACKAGES = ["git:github.com/excessivechaos/pi-anthropic-cache-anchor"];

/** Deep-merge plain objects; arrays and scalars from `patch` win. */
export function merge(base, patch) {
	if (Array.isArray(patch) || patch === null || typeof patch !== "object") return patch;
	if (Array.isArray(base) || base === null || typeof base !== "object") return { ...patch };
	const out = { ...base };
	for (const [key, val] of Object.entries(patch)) out[key] = key in out ? merge(out[key], val) : val;
	return out;
}

/** Keys in a stable order, so "same content" does not depend on how the file was written. */
function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sameJson(a, b) {
	if (a === undefined || b === undefined) return false;
	try {
		return stable(JSON.parse(a)) === stable(b);
	} catch {
		return false;
	}
}

export function readJson(path, fallback) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${error.message}`);
	}
}

/** Write atomically, and only when the parsed content actually differs. */
function writeIfChanged(path, data, dryRun) {
	let previous;
	try {
		previous = readFileSync(path, "utf8");
	} catch {
		previous = undefined;
	}
	if (sameJson(previous, data)) return { path, action: "unchanged" };
	if (dryRun) return { path, action: previous === undefined ? "would-create" : "would-update" };
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmp, path);
	return { path, action: previous === undefined ? "created" : "updated" };
}

/**
 * Handler order follows package order, and pi-compaction-percent must run after the router that
 * publishes the next model. Our packages keep PACKAGES order; anything else stays ahead of them.
 */
export function orderPackages(list) {
	if (!Array.isArray(list)) return list;
	const source = (entry) => (typeof entry === "string" ? entry : entry?.source);
	const ours = PACKAGES.flatMap((wanted) => list.filter((entry) => source(entry) === wanted));
	const others = list.filter((entry) => !PACKAGES.includes(source(entry)));
	return [...others, ...ours];
}

/** `configs/` sitting next to this file's parent: the repo root, wherever it was cloned. */
export function configsDirFrom(repoDir) {
	return join(repoDir, "configs");
}

/**
 * Converge `agentDir` on the configs in `configsDir`.
 * Returns one `{ path, action }` per managed file; `action` is `unchanged` when nothing was written.
 */
export function applyConfigs({ agentDir, configsDir, dryRun = false }) {
	if (!existsSync(join(configsDir, "settings.patch.json"))) {
		throw new Error(`no configs at ${configsDir}`);
	}
	const results = [];

	// settings.json — merge, never replace: locale, theme, keys and anything else stay.
	const settingsPath = join(agentDir, "settings.json");
	const settings = merge(readJson(settingsPath, {}), readJson(join(configsDir, "settings.patch.json"), {}));
	settings.packages = orderPackages(settings.packages);
	results.push(writeIfChanged(settingsPath, settings, dryRun));

	// models.json — same merge, so a model override added by hand survives.
	const modelsPath = join(agentDir, "models.json");
	results.push(
		writeIfChanged(
			modelsPath,
			merge(readJson(modelsPath, {}), readJson(join(configsDir, "models.patch.json"), {})),
			dryRun,
		),
	);

	// These are wholly ours; replacing them is the point.
	for (const name of ["subscription-router.json", "compaction-percent.json", "cache-keepalive.json"]) {
		const repoFile = join(configsDir, name);
		if (!existsSync(repoFile)) continue;
		results.push(writeIfChanged(join(agentDir, name), readJson(repoFile, {}), dryRun));
	}

	return results;
}

/** True when every managed file is already what it should be. */
export function isConverged(results) {
	return results.every((result) => result.action === "unchanged");
}

/** Short human summary: `configs: settings.json updated · compaction-percent.json unchanged`. */
export function describeResults(results) {
	return results.map((result) => `${basename(result.path)} ${result.action}`).join(" · ");
}

/** mtime guard: has the file changed since `before`? Used to avoid clobbering a concurrent write. */
export function modifiedSince(path, before) {
	try {
		return statSync(path).mtimeMs > before;
	} catch {
		return false;
	}
}
