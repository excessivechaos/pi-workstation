/**
 * Package membership, applied from inside a running session.
 *
 * `pi update --extensions` reconciles package *code* for what is already
 * installed; it never adds or drops a package. This module closes that gap so a
 * machine converges on the list in `lib/workstation.mjs` without anyone running
 * `pi install` by hand: a fresh pi install needs one command
 * (`pi install git:github.com/excessivechaos/pi-workstation`), and every later
 * change to the list arrives with `pi update --extensions` plus the next start.
 *
 * It drives pi's own `DefaultPackageManager` — the same code `pi install` and
 * `pi remove` use — so npm and git sources resolve identically, and settings are
 * persisted the same way. Installing is network work, so callers run this off
 * the hot path and the session keeps working meanwhile. New packages load on the
 * next start (or `/reload`), exactly like a fresh `pi install`.
 *
 * Removals are deliberately bounded: `REMOVED_PACKAGES` by name, and any source
 * under this repo's own org that is no longer in `PACKAGES` — retired packages
 * clean themselves up. `OPTIONAL_PACKAGES` are never removed and never installed
 * here; they stay a deliberate choice.
 */

import { OPTIONAL_PACKAGES, PACKAGES, REMOVED_PACKAGES } from "./workstation.mjs";

/** Git sources under our own org, e.g. `git:github.com/excessivechaos/pi-quota-peek`. */
const OUR_ORG = "git:github.com/excessivechaos/";

/**
 * What to do about `configured` (the sources in settings.json), pure so the
 * policy is testable: install what is listed and missing, remove what is retired
 * or no longer listed, leave everything else alone.
 */
export function planPackages(configured) {
	const present = new Set(configured);
	const install = PACKAGES.filter((source) => !present.has(source));
	// Anything ours that is no longer listed is retired, unless it is optional.
	const keep = new Set([...PACKAGES, ...OPTIONAL_PACKAGES]);
	const remove = configured.filter(
		(source) => REMOVED_PACKAGES.includes(source) || (typeof source === "string" && source.startsWith(OUR_ORG) && !keep.has(source)),
	);
	return { install, remove };
}

/** `installed pi-quota-peek` / `removed pi-x`, for the notify line. */
export function describePlan({ install, remove }) {
	const parts = [];
	if (install.length > 0) parts.push(`install ${install.map(shortName).join(", ")}`);
	if (remove.length > 0) parts.push(`remove ${remove.map(shortName).join(", ")}`);
	return parts.join(" · ");
}

/** `git:github.com/excessivechaos/pi-quota-peek` -> `pi-quota-peek`; npm names pass through. */
export function shortName(source) {
	const base = String(source).replace(/\/+$/, "");
	const slash = base.lastIndexOf("/");
	return slash >= 0 ? base.slice(slash + 1).replace(/\.git$/, "") : base.replace(/^npm:/, "");
}

/**
 * Converge settings' package list on the repo's. Returns
 * `{ install, remove, failed, skipped }`; `skipped` is true for a dry run.
 *
 * The manager is created fresh for this run so it reads the settings file as it
 * is now; config writes happen afterwards and re-read the file themselves.
 */
export async function applyPackages({ api, agentDir, cwd, dryRun = false, log = () => {} }) {
	// The host package is injected rather than imported: the extension is loaded
	// through pi's own resolver, while a plain dynamic import here would use
	// Node's and fail to find it.
	const { DefaultPackageManager, SettingsManager } = api;
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const configured = manager
		.listConfiguredPackages()
		.filter((entry) => entry.scope === "user")
		.map((entry) => entry.source);
	const plan = planPackages(configured);
	if (dryRun) return { ...plan, failed: [], skipped: true };

	const failed = [];
	for (const source of plan.remove) {
		try {
			await manager.removeAndPersist(source);
			log(`removed ${source}`);
		} catch (error) {
			failed.push({ source, action: "remove", error: error instanceof Error ? error.message : String(error) });
		}
	}
	for (const source of plan.install) {
		try {
			await manager.installAndPersist(source);
			log(`installed ${source}`);
		} catch (error) {
			failed.push({ source, action: "install", error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { ...plan, failed, skipped: false };
}
