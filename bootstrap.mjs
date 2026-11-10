#!/usr/bin/env node
/**
 * pi-workstation bootstrap
 *
 * Makes a fresh machine behave like the reference setup: install pi, install the packages
 * (npm and git), and merge the config files. Idempotent — run it again to converge.
 *
 *   node bootstrap.mjs                     install / converge
 *   node bootstrap.mjs --dry-run           print every action, change nothing
 *   node bootstrap.mjs --agent-dir DIR     target a non-default agent dir
 *   node bootstrap.mjs --skip-pi-install   assume pi is present (offline or pre-installed)
 *   node bootstrap.mjs --skip-packages     config only
 *   node bootstrap.mjs --skip-shell        do not touch the shell profile
 *   node bootstrap.mjs --skip-tmux         do not touch ~/.tmux.conf
 *
 * Node is required because pi is a Node program; install.sh / install.ps1 install pi (and Node,
 * if the official installer needs to) and then call this file.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

/** Packages this workstation runs, unpinned so `pi update --extensions` follows upstream. */
const PACKAGES = [
	"npm:pi-commandcode-provider",
	"npm:pi-web-access",
	"npm:@gotgenes/pi-anthropic-auth",
	"npm:@juicesharp/rpiv-ask-user-question",
	// A fork that publishes the next model for compaction; it must stay listed BEFORE pi-compaction-percent.
	"git:github.com/excessivechaos/pi-subscription-router",
	"git:github.com/excessivechaos/pi-quota-statusline",
	"git:github.com/excessivechaos/pi-compaction-percent",
];
/** Retired sources: removed before anything is installed, because two routers would register the same virtual models. */
const REMOVED_PACKAGES = [
	"npm:@nredd/pi-subscription-router",
	"npm:pi-subagents",
	"npm:@cortexkit/pi-magic-context",
	"npm:@timmyjl12/pi-fallback-chains",
	// Retired with the move to 1-hour cache retention: warming only ever bought back the 5-minute
	// tier, and 1h keeps the entry alive across idle gaps without spending a warm on each one.
	"git:github.com/excessivechaos/pi-cache-keepalive",
];
/** Installed only on request (see README): useful at 1h cache retention, inert at 5m. */
const OPTIONAL_PACKAGES = ["git:github.com/excessivechaos/pi-anthropic-cache-anchor"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const DRY = flag("dry-run");
const AGENT_DIR = resolve(value("agent-dir", process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")));
const SKIP_PI = flag("skip-pi-install");
const SKIP_PACKAGES = flag("skip-packages");
const SKIP_SHELL = flag("skip-shell");
const SKIP_TMUX = flag("skip-tmux");
const WITH_ANCHOR = flag("with-cache-anchor");

const log = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n${msg}`);

/** Run a command, or print it under --dry-run. Throws with the command on failure. */
function run(command, argv, options = {}) {
	const printable = [command, ...argv].join(" ");
	if (DRY) {
		log(`would run: ${printable}`);
		return "";
	}
	log(printable);
	try {
		const common = {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
			...options,
		};
		// Windows: a .cmd shim cannot be exec'd directly, and bare `pi` is resolved through PATHEXT,
		// which only cmd.exe does. Quote locally and hand cmd.exe one command line.
		if (IS_WINDOWS && /\.ps1$/i.test(command)) {
			return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...argv], common);
		}
		if (IS_WINDOWS) return execSync([command, ...argv].map(quoteWindows).join(" "), common);
		return execFileSync(command, argv, common);
	} catch (error) {
		const stderr = String(error?.stderr ?? "").trim();
		const stdout = String(error?.stdout ?? "").trim();
		throw new Error(`${printable} failed${stderr || stdout ? `:\n${stderr || stdout}` : ""}`);
	}
}

/** Quote one argv entry for cmd.exe. Our own arguments never contain quotes or metacharacters. */
function quoteWindows(value) {
	const text = String(value);
	return /[\s"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** `where.exe pi` lists every shim on PATH; the first line wins, but all are tried. */
function whereCandidates() {
	if (!IS_WINDOWS) return [];
	try {
		return execSync("where.exe pi", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** Which pi invocation works here; the installer puts it on PATH, npm-global may need shell env. */
function piCommand() {
	// Under --dry-run nothing is executed, so assume the binary this platform expects.
	const override = value("pi", undefined);
	if (override) return override;
	if (DRY) return IS_WINDOWS ? "pi.cmd" : "pi";
	const tried = [];
	const candidates = [...new Set([
		...(IS_WINDOWS ? whereCandidates() : []),
		...(IS_WINDOWS ? ["pi.cmd", "pi.exe", "pi"] : ["pi"]),
	])];
	for (const candidate of candidates) {
		try {
			run(candidate, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
			return candidate;
		} catch (error) {
			tried.push(`${candidate}: ${String(error?.message ?? error).split("\n")[0]}`);
		}
	}
	log(`could not run pi. tried:\n  ${tried.join("\n  ")}`);
	log('pass --pi "<path to pi.cmd>" (or pi.exe / pi.ps1) to skip detection');
	return undefined;
}

/** Deep-merge plain objects; arrays and scalars from `patch` win. */
function merge(base, patch) {
	if (Array.isArray(patch) || patch === null || typeof patch !== "object") return patch;
	if (Array.isArray(base) || base === null || typeof base !== "object") return { ...patch };
	const out = { ...base };
	for (const [key, val] of Object.entries(patch)) out[key] = key in out ? merge(out[key], val) : val;
	return out;
}

function readJson(path, fallback) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${error.message}`);
	}
}

/** Delete a file this workstation no longer owns, without failing when it is already gone. */
function removeIfPresent(path) {
	if (!existsSync(path)) return;
	if (DRY) return log(`would remove ${path}`);
	rmSync(path);
	log(`removed ${path}`);
}

/** Write atomically so an interrupted run never leaves a half-written config. */
function writeJson(path, data) {
	const text = `${JSON.stringify(data, null, 2)}\n`;
	if (DRY) {
		log(`would write ${path} (${Buffer.byteLength(text)} bytes)`);
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
	log(`wrote ${path}`);
}

// ---------------------------------------------------------------- 1. pi itself
function installPi() {
	step("1/5  pi");
	if (SKIP_PI) return log("skipped (--skip-pi-install)");
	const found = piCommand();
	if (found !== undefined) return log(DRY ? "present (assumed under --dry-run)" : `present: ${run(found, ["--version"]).trim() || "ok"}`);
	if (IS_WINDOWS) return run("powershell", ["-NoProfile", "-Command", "irm https://pi.dev/install.ps1 | iex"]);
	return run("sh", ["-c", "curl -fsSL https://pi.dev/install.sh | sh"]);
}

// ---------------------------------------------------------------- 2. packages
function installPackages() {
	step("2/5  packages");
	if (SKIP_PACKAGES) return log("skipped (--skip-packages)");
	const pi = piCommand();
	if (pi === undefined) throw new Error("pi is not on PATH; run without --skip-pi-install, or open a new shell");
	for (const source of REMOVED_PACKAGES) {
		try {
			run(pi, ["remove", source]);
		} catch {
			// not installed: nothing to remove
		}
	}
	for (const source of [...PACKAGES, ...(WITH_ANCHOR ? OPTIONAL_PACKAGES : [])]) {
		// `pi install` is idempotent for an already-listed source: it refreshes it.
		run(pi, ["install", source]);
	}
}

/**
 * Handler order follows package order, and pi-compaction-percent must run after the router that
 * publishes the next model. Our packages keep PACKAGES order; anything else stays ahead of them.
 */
function orderPackages(list) {
	if (!Array.isArray(list)) return list;
	const source = (entry) => (typeof entry === "string" ? entry : entry?.source);
	const ours = PACKAGES.flatMap((wanted) => list.filter((entry) => source(entry) === wanted));
	const others = list.filter((entry) => !PACKAGES.includes(source(entry)));
	return [...others, ...ours];
}

// ---------------------------------------------------------------- 3. configs
function installConfigs() {
	step("3/5  configs");
	const configs = join(HERE, "configs");

	// settings.json — merge, never replace: locale, theme, keys and anything else stay.
	const settingsPatch = readJson(join(configs, "settings.patch.json"), {});
	const settings = merge(readJson(join(AGENT_DIR, "settings.json"), {}), settingsPatch);
	settings.packages = orderPackages(settings.packages);
	writeJson(join(AGENT_DIR, "settings.json"), settings);

	// models.json — same merge, so a model override added by hand survives.
	const modelsPatch = readJson(join(configs, "models.patch.json"), {});
	writeJson(join(AGENT_DIR, "models.json"), merge(readJson(join(AGENT_DIR, "models.json"), {}), modelsPatch));

	// These two are wholly ours; replacing them is the point.
	writeJson(join(AGENT_DIR, "subscription-router.json"), readJson(join(configs, "subscription-router.json"), {}));
	writeJson(join(AGENT_DIR, "compaction-percent.json"), readJson(join(configs, "compaction-percent.json"), {}));

	// The warmer is no longer installed; a leftover config would only suggest that it still runs.
	removeIfPresent(join(AGENT_DIR, "cache-keepalive.json"));
}

// ---------------------------------------------------------------- 4. shell wrapper
const BASH_MARKER = "# >>> pi-workstation bootstrap >>>";
const PS_MARKER = "# >>> pi-workstation bootstrap >>>";

function shellBlockBash() {
	const oom = IS_LINUX
		? `  # Keep the kernel from OOM-killing pi (needs the sudoers entry; silently skipped otherwise).
  if [ -x /usr/local/sbin/protect-pi ]; then
    ( sleep 2; command sudo -n /usr/local/sbin/protect-pi >/dev/null 2>&1; \\
      sleep 8; command sudo -n /usr/local/sbin/protect-pi >/dev/null 2>&1 ) &
  fi\n`
		: "";
	return `${BASH_MARKER}
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
    install|remove|uninstall|update|list|config|auth|mcp|help|--help|-h|--version|-v)
      command pi "$@"; return ;;
  esac
${oom}  local _args=("$@") _named=0
  for _a in "\${_args[@]}"; do
    case "\$_a" in
      -m|--model|-c|--continue|-r|--resume|--session|--fork|--model=*|-m=*) _named=1 ;;
    esac
  done
  if [ "\$_named" -eq 0 ]; then command pi --model router/orchestrator "\$@"; else command pi "\$@"; fi
}
# <<< pi-workstation bootstrap <<<
`;
}

function shellBlockPowerShell() {
	// Resolve the real pi at call time: the installed shim may be pi.cmd, pi.exe, pi.ps1 or an
	// extensionless launcher, and a function calling a fixed name shadows the one that exists.
	return `${PS_MARKER}
# One-hour prompt caches (see the bash block for why).
$env:PI_CACHE_RETENTION = "long"
# Default a new session to the router; pi's default-model lookup rejects a virtual provider.
function pi {
  $exe = (Get-Command pi -CommandType Application -All -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $exe) { Write-Error "pi is not on PATH"; return }
  $named = $false
  foreach ($a in $args) {
    if ($a -in @('-m','--model','-c','--continue','-r','--resume','--session','--fork')) { $named = $true }
    if ($a -like '--model=*' -or $a -like '-m=*') { $named = $true }
  }
  if ($named) { & $exe @args } else { & $exe --model router/orchestrator @args }
}
# <<< pi-workstation bootstrap <<<
`;
}

/** Replace our marked block in `path`, leaving everything else alone. */
function upsertBlock(path, block, marker, endMarker = "# <<< pi-workstation bootstrap <<<") {
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`${escape(marker)}[\\s\\S]*?${escape(endMarker)}\\n?`, "m");
	const next = pattern.test(current) ? current.replace(pattern, block) : `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${current === "" ? "" : "\n"}${block}`;
	if (next === current) return log(`${path} already current`);
	if (DRY) return log(`would update ${path}`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, next);
	log(`updated ${path}`);
}

/** tmux daemons keep their own environment; a detached session must not miss what the shell exports. */
const TMUX_MARKER = "# >>> pi-workstation cache retention >>>";
const TMUX_END = "# <<< pi-workstation cache retention <<<";

function tmuxBlock() {
	return `${TMUX_MARKER}
# One-hour prompt caches must reach every pi started inside tmux, attached or detached.
set-environment -g PI_CACHE_RETENTION long
${TMUX_END}
`;
}

function installTmux() {
	step("4/5  tmux");
	if (SKIP_TMUX) return log("skipped (--skip-tmux)");
	if (IS_WINDOWS) return log("skipped (no tmux on Windows)");
	upsertBlock(join(homedir(), ".tmux.conf"), tmuxBlock(), TMUX_MARKER, TMUX_END);
	// A server already running keeps the environment it started with; refresh it in place.
	if (DRY) return log("would run: tmux set-environment -g PI_CACHE_RETENTION long");
	try {
		run("tmux", ["set-environment", "-g", "PI_CACHE_RETENTION", "long"]);
	} catch {
		log("no tmux server running; the config applies to the next one");
	}
}

function installShell() {
	step("5/5  shell profile");
	if (SKIP_SHELL) return log("skipped (--skip-shell)");
	if (IS_WINDOWS) {
		const profile = execFileSync("powershell", ["-NoProfile", "-Command", "$PROFILE.CurrentUserAllHosts"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		return upsertBlock(profile, shellBlockPowerShell(), PS_MARKER);
	}
	const shell = process.env.SHELL ?? "/bin/bash";
	const profile = shell.endsWith("zsh") ? join(homedir(), ".zshrc") : join(homedir(), ".bashrc");
	upsertBlock(profile, shellBlockBash(), BASH_MARKER);
}

// ---------------------------------------------------------------- main
console.log(`pi-workstation bootstrap\n  platform ${process.platform} ${process.arch}\n  agent dir ${AGENT_DIR}${DRY ? "\n  DRY RUN: nothing will change" : ""}`);
try {
	installPi();
	installPackages();
	installConfigs();
	installTmux();
	installShell();
	console.log("\ndone.");
	if (DRY) console.log("(dry run — rerun without --dry-run to apply)");
	else console.log("Open a new shell, then authenticate providers with `pi auth login <provider>` (or copy auth.json).");
} catch (error) {
	console.error(`\nbootstrap failed: ${error.message}`);
	process.exitCode = 1;
}
