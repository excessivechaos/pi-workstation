/**
 * pi-workstation — the config half of the install script, as an extension.
 *
 * `pi update --extensions` already reconciles package code. This package makes it reconcile the
 * machine's config too: on every session start it converges `$PI_CODING_AGENT_DIR` on the files in
 * this repo's `configs/`, so a change lands with the same command that lands the code.
 *
 *   settings.json            merged (never replaced): packages order, compaction off, cache warming
 *                            off, thinking levels. Keys are never deleted.
 *   models.json              merged: context windows and prompt-cache TTLs per model.
 *   subscription-router.json replaced: wholly ours.
 *   compaction-percent.json  replaced: wholly ours.
 *   cache-keepalive.json     removed: the package it configured is retired.
 *
 * Only files whose content would change are written, so a converged machine is silent and cheap.
 * Runs at `session_start`, before the handlers of the packages listed after this one: config that
 * pi-compaction-percent reloads at its own `session_start` is this run's config, not last run's.
 *
 * The install script (`bootstrap.mjs`) imports `lib/workstation.mjs` and applies the same code, so
 * a fresh machine and an updated one converge on the same result.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyConfigs, configsDirFrom, describeResults, isConverged } from "./lib/workstation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = configsDirFrom(HERE);

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function apply(agentDirPath: string, dryRun: boolean) {
	return applyConfigs({ agentDir: agentDirPath, configsDir: CONFIGS_DIR, dryRun });
}

export default function workstation(pi: ExtensionAPI): void {
	let announced = false;

	pi.on("session_start", async (_event, ctx) => {
		// The cold-cache rule only pays off at the long TTL; say so once rather than silently
		// compacting on a 5-minute cache.
		if (!announced && process.env.PI_CACHE_RETENTION !== "long") {
			announced = true;
			ctx.ui.notify("pi-workstation: PI_CACHE_RETENTION is not long — compaction triggers assume a 1h cache", "warning");
		}
		try {
			const results = apply(agentDir(), false);
			if (!isConverged(results)) ctx.ui.notify(`pi-workstation: ${describeResults(results)}`, "info");
		} catch (error) {
			ctx.ui.notify(`pi-workstation: could not apply configs: ${(error as Error).message}`, "error");
		}
	});

	const command = async (args: string, ctx: ExtensionContext) => {
		const verb = args.trim().split(/\s+/)[0] ?? "";
		if (verb === "path" || verb === "paths") {
			return ctx.ui.notify(`pi-workstation\nconfigs ${CONFIGS_DIR}\nagent   ${agentDir()}`, "info");
		}
		try {
			if (verb === "preview" || verb === "dry-run" || verb === "status") {
				const results = apply(agentDir(), true);
				return ctx.ui.notify(`pi-workstation: ${isConverged(results) ? "converged — nothing to apply" : describeResults(results)}`, "info");
			}
			const results = apply(agentDir(), false);
			return ctx.ui.notify(
				`pi-workstation: ${isConverged(results) ? "converged — nothing to apply" : describeResults(results)}`,
				"info",
			);
		} catch (error) {
			return ctx.ui.notify(`pi-workstation: ${(error as Error).message}`, "error");
		}
	};

	pi.registerCommand("apply-config", {
		description: "Apply this repo's configs to the agent dir: /apply-config [status|preview|path]",
		handler: command,
	});
	pi.registerCommand("apply-workstation", { description: "Alias for /apply-config", handler: command });
}
