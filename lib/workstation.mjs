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
 *   - `subscription-router.json`, `compaction-percent.json`, `cache-keepalive.json` and
 *     `quota-resume.json` are wholly
 *     ours and are replaced.
 *   - Files are written only when their content would change, so a converged machine writes nothing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
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
	"git:github.com/excessivechaos/pi-quota-peek",
	"git:github.com/excessivechaos/pi-quota-statusline",
	"git:github.com/excessivechaos/pi-cache-keepalive",
	"git:github.com/excessivechaos/pi-quota-resume",
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
/**
 * Words that must reach pi untouched: injecting `--model` in front of a subcommand turns
 * `pi update` into a session whose first message is "update".
 */
export const PI_SUBCOMMANDS = [
	"install", "remove", "uninstall", "update", "list", "config", "auth", "mcp",
	"help", "--help", "-h", "--version", "-v",
];

const SHELL_MARKER = "# >>> pi-workstation bootstrap >>>";
const SHELL_END = "# <<< pi-workstation bootstrap <<<";

/** The bash/zsh block: cache retention, the subcommand passthrough, and the router default. */
export function shellBlockBash({ linux = process.platform === "linux" } = {}) {
	const oom = linux
		? `  # Keep the kernel from OOM-killing pi (needs the sudoers entry; silently skipped otherwise).
  if [ -x /usr/local/sbin/protect-pi ]; then
    ( sleep 2; command sudo -n /usr/local/sbin/protect-pi >/dev/null 2>&1; \\
      sleep 8; command sudo -n /usr/local/sbin/protect-pi >/dev/null 2>&1 ) &
  fi\n`
		: "";
	return `${SHELL_MARKER}
# One-hour prompt caches. The 5-minute tier expires across a long tool call or a walk-away, and
# the next request then re-bills the whole prefix as a write; at this context size one bust costs
# more than the 1-hour write premium for an entire session. Warming bought the same thing back for
# a price, so the warmer is retired and this replaces it.
export PI_CACHE_RETENTION=long
# Default a new session to the router. pi's default-model lookup rejects a virtual provider, so it
# is passed explicitly unless the caller already named a model or is resuming a session.
pi() {
  # Subcommands and self-query flags belong to pi, not to a prompt: injecting --model here would
  # make \`pi update\` a session whose first message is "update" (use \`pi -- update\` for that prompt).
  case "\${1-}" in
    ${PI_SUBCOMMANDS.join("|")})
      command pi "$@"; return ;;
  esac
${oom}  local _args=("$@") _named=0
  for _a in "\${_args[@]}"; do
    case "$_a" in
      -m|--model|-c|--continue|-r|--resume|--session|--fork|--model=*|-m=*) _named=1 ;;
    esac
  done
  if [ "$_named" -eq 0 ]; then command pi --model router/orchestrator "$@"; else command pi "$@"; fi
}
${SHELL_END}
`;
}

/** The PowerShell block: the same policy, in the dialect that has no `case`. */
export function shellBlockPowerShell() {
	// Resolve the real pi at call time: the installed shim may be pi.cmd, pi.exe, pi.ps1 or an
	// extensionless launcher, and a function calling a fixed name shadows the one that exists.
	return `${SHELL_MARKER}
# One-hour prompt caches (see the bash block for why).
$env:PI_CACHE_RETENTION = "long"
# Default a new session to the router; pi's default-model lookup rejects a virtual provider.
function pi {
  $exe = (Get-Command pi -CommandType Application -All -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $exe) { Write-Error "pi is not on PATH"; return }
  # Subcommands and self-query flags belong to pi, not to a prompt: injecting --model here would
  # make \`pi update\` a session whose first message is "update" (use \`pi -- update\` for that prompt).
  if ($args.Count -gt 0 -and @('${PI_SUBCOMMANDS.join("','")}') -contains $args[0]) { & $exe @args; return }
  $named = $false
  foreach ($a in $args) {
    if ($a -in @('-m','--model','-c','--continue','-r','--resume','--session','--fork')) { $named = $true }
    if ($a -like '--model=*' -or $a -like '-m=*') { $named = $true }
  }
  if ($named) { & $exe @args } else { & $exe --model router/orchestrator @args }
}
${SHELL_END}
`;
}

/** Our marked block replaced in place; surrounding lines are left alone. */
export function upsertMarkedBlock(current, block, marker = SHELL_MARKER, endMarker = SHELL_END) {
	const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`${escape(marker)}[\\s\\S]*?${escape(endMarker)}\\n?`, "m");
	if (pattern.test(current)) {
		const next = current.replace(pattern, block);
		return next === current ? undefined : next;
	}
	const separator = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
	return `${current}${separator}${block}`;
}

/** Where this machine's shell profile lives; `undefined` when it cannot be resolved. */
export function shellProfilePath({ platform = process.platform, env = process.env, home = homedir() } = {}) {
	if (platform === "win32") {
		try {
			return execFileSync("powershell", ["-NoProfile", "-Command", "$PROFILE.CurrentUserAllHosts"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch {
			return undefined;
		}
	}
	const shell = env.SHELL ?? "/bin/bash";
	return join(home, shell.endsWith("zsh") ? ".zshrc" : ".bashrc");
}

/**
 * Converge the shell profile. Returns `{ path, action }` like the config files, or `undefined`
 * when this machine has no resolvable profile. `action` is `skipped` when the platform is
 * Windows and PowerShell cannot be spawned.
 */
export function applyShellProfile({ platform = process.platform, env = process.env, home = homedir(), dryRun = false } = {}) {
	const path = shellProfilePath({ platform, env, home });
	if (!path) return undefined;
	const block = platform === "win32" ? shellBlockPowerShell() : shellBlockBash({ linux: platform === "linux" });
	let current;
	try {
		current = readFileSync(path, "utf8");
	} catch {
		current = "";
	}
	const next = upsertMarkedBlock(current, block);
	if (next === undefined) return { path, action: "unchanged" };
	if (dryRun) return { path, action: current === "" ? "would-create" : "would-update" };
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, next);
		renameSync(tmp, path);
	} catch (error) {
		return { path, action: "failed", error: error instanceof Error ? error.message : String(error) };
	}
	return { path, action: current === "" ? "created" : "updated" };
}

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
	for (const name of ["subscription-router.json", "compaction-percent.json", "cache-keepalive.json", "quota-resume.json"]) {
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
