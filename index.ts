/**
 * pi-workstation — the config half of the install script, as an extension.
 *
 * `pi update --extensions` already reconciles package code. This package makes it reconcile the
 * machine's *membership and config* too: on every session start it converges `$PI_CODING_AGENT_DIR`
 * on the packages in `lib/workstation.mjs` and the files in this repo's `configs/`, so a new pi
 * install needs one command — `pi install git:github.com/excessivechaos/pi-workstation` — and every
 * later change lands with `pi update --extensions` plus the next start.
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
import { DefaultPackageManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyConfigs, configsDirFrom, describeResults, isConverged } from "./lib/workstation.mjs";
import { applyPackages, describePlan } from "./lib/packages.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = configsDirFrom(HERE);

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function apply(agentDirPath: string, dryRun: boolean) {
	return applyConfigs({ agentDir: agentDirPath, configsDir: CONFIGS_DIR, dryRun });
}

/** One package sync at a time per process; two sessions starting together must not race. */
let syncing: Promise<{ install: string[]; remove: string[]; failed: unknown[] }> | undefined;

/**
 * Converge package membership, then the configs that configure it. Installs are
 * network work, so the caller runs this off the hot path; a fresh package loads
 * on the next start or `/reload`, exactly like a manual `pi install`.
 */
function syncPackages(agentDirPath: string, cwd: string) {
	syncing ??= applyPackages({ api: { DefaultPackageManager, SettingsManager }, agentDir: agentDirPath, cwd })
		.then((result) => {
			// Re-apply after membership changes so a newly installed package's config
			// file exists before its own session_start reads it.
			apply(agentDirPath, false);
			return result;
		})
		.finally(() => {
			syncing = undefined;
		});
	return syncing;
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
		// Package membership is network work and never blocks the turn. A converged
		// machine resolves from settings with no network at all. The install can
		// outlive this session (print mode exits as soon as the answer is done), so
		// every notify goes through a wrapper that tolerates a stale context.
		const notify = (text: string, level: "info" | "warning" | "error") => {
			try {
				ctx.ui.notify(text, level);
			} catch {
				// The session ended while the sync was still running; nothing to say.
			}
		};
		void syncPackages(agentDir(), ctx.cwd)
			.then((result) => {
				if (result.failed.length > 0) {
					const first = result.failed[0] as { source: string; action: string; error: string };
					notify(`pi-workstation: ${first.action} of ${first.source} failed: ${first.error}`, "error");
				}
				if (result.install.length === 0 && result.remove.length === 0) return;
				notify(`pi-workstation: ${describePlan(result)} — restart or /reload to activate`, "info");
			})
			.catch((error: unknown) => {
				notify(`pi-workstation: could not sync packages: ${(error as Error).message}`, "error");
			});
	});

	const command = async (args: string, ctx: ExtensionContext) => {
		const verb = args.trim().split(/\s+/)[0] ?? "";
		if (verb === "path" || verb === "paths") {
			return ctx.ui.notify(`pi-workstation\nconfigs ${CONFIGS_DIR}\nagent   ${agentDir()}`, "info");
		}
		try {
			if (verb === "preview" || verb === "dry-run" || verb === "status") {
				const results = apply(agentDir(), true);
				const plan = await applyPackages({ api: { DefaultPackageManager, SettingsManager }, agentDir: agentDir(), cwd: ctx.cwd, dryRun: true });
				const changes = describeResults(results);
				return ctx.ui.notify(
					`pi-workstation: ${isConverged(results) && plan.install.length + plan.remove.length === 0 ? "converged — nothing to apply" : [changes, describePlan(plan)].filter(Boolean).join(" · ")}`,
					"info",
				);
			}
			const plan = await syncPackages(agentDir(), ctx.cwd);
			const results = apply(agentDir(), false);
			const membershipChanged = plan.install.length + plan.remove.length > 0;
			const parts = [
				isConverged(results) ? "" : describeResults(results),
				describePlan(plan),
				plan.failed.length > 0 ? `${plan.failed.length} package action(s) failed` : "",
			].filter(Boolean);
			ctx.ui.notify(`pi-workstation: ${parts.length === 0 ? "converged — nothing to apply" : parts.join(" · ")}`, "info");
			// Reload loads the newly installed extensions in this process; only a
			// command context can do it, and only while the session is idle.
			if (!membershipChanged) return;
			if (!ctx.isIdle()) {
				ctx.ui.notify("pi-workstation: run /reload when idle to activate the new packages", "info");
				return;
			}
			// After reload this ctx is stale: touch nothing past this point.
			return ctx.reload();
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
