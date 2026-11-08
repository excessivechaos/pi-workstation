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
 *
 * Node is required because pi is a Node program; install.sh / install.ps1 install pi (and Node,
 * if the official installer needs to) and then call this file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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
	"git:github.com/excessivechaos/pi-cache-keepalive",
	"git:github.com/excessivechaos/pi-compaction-percent",
];
/** Superseded sources: removed first, because two routers would register the same virtual models. */
const REMOVED_PACKAGES = ["npm:@nredd/pi-subscription-router", "npm:pi-subagents", "npm:@cortexkit/pi-magic-context", "npm:@timmyjl12/pi-fallback-chains"];
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
		return execFileSync(command, argv, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
			...options,
		});
	} catch (error) {
		const stderr = String(error?.stderr ?? "").trim();
		const stdout = String(error?.stdout ?? "").trim();
		throw new Error(`${printable} failed${stderr || stdout ? `:\n${stderr || stdout}` : ""}`);
	}
}

/** Which pi invocation works here; the installer puts it on PATH, npm-global may need shell env. */
function piCommand() {
	// Under --dry-run nothing is executed, so assume the binary this platform expects.
	if (DRY) return IS_WINDOWS ? "pi.cmd" : "pi";
	for (const candidate of IS_WINDOWS ? ["pi.cmd", "pi.exe", "pi"] : ["pi"]) {
		try {
			run(candidate, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
			return candidate;
		} catch {
			/* try the next one */
		}
	}
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

/** Delete a dotted path (`compaction.reserveTokens`) so a merge cannot keep an obsolete value. */
function removePath(object, path) {
	const parts = String(path).split(".");
	let node = object;
	for (const part of parts.slice(0, -1)) {
		if (node === null || typeof node !== "object") return;
		node = node[part];
	}
	if (node && typeof node === "object") delete node[parts[parts.length - 1]];
}

function readJson(path, fallback) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${error.message}`);
	}
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
	step("1/4  pi");
	if (SKIP_PI) return log("skipped (--skip-pi-install)");
	const found = piCommand();
	if (found !== undefined) return log(DRY ? "present (assumed under --dry-run)" : `present: ${run(found, ["--version"]).trim() || "ok"}`);
	if (IS_WINDOWS) return run("powershell", ["-NoProfile", "-Command", "irm https://pi.dev/install.ps1 | iex"]);
	return run("sh", ["-c", "curl -fsSL https://pi.dev/install.sh | sh"]);
}

// ---------------------------------------------------------------- 2. packages
function installPackages() {
	step("2/4  packages");
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
	step("3/4  configs");
	const configs = join(HERE, "configs");

	// settings.json — merge, never replace: locale, theme, keys and anything else stay.
	const settingsPatch = readJson(join(configs, "settings.patch.json"), {});
	const settings = merge(readJson(join(AGENT_DIR, "settings.json"), {}), settingsPatch);
	// A merge cannot delete a key, and a stale enabledModels or reserveTokens would outlive the patch.
	for (const path of readJson(join(configs, "settings.remove.json"), [])) removePath(settings, path);
	settings.packages = orderPackages(settings.packages);
	writeJson(join(AGENT_DIR, "settings.json"), settings);

	// models.json — same merge, so a model override added by hand survives.
	const modelsPatch = readJson(join(configs, "models.patch.json"), {});
	writeJson(join(AGENT_DIR, "models.json"), merge(readJson(join(AGENT_DIR, "models.json"), {}), modelsPatch));

	// These two are wholly ours; replacing them is the point.
	writeJson(join(AGENT_DIR, "subscription-router.json"), readJson(join(configs, "subscription-router.json"), {}));
	writeJson(join(AGENT_DIR, "cache-keepalive.json"), readJson(join(configs, "cache-keepalive.json"), {}));
	writeJson(join(AGENT_DIR, "compaction-percent.json"), readJson(join(configs, "compaction-percent.json"), {}));
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
# Default a new session to the router. pi's default-model lookup rejects a virtual provider, so it
# is passed explicitly unless the caller already named a model or is resuming a session.
pi() {
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
	return `${PS_MARKER}
# Default a new session to the router; pi's default-model lookup rejects a virtual provider.
function pi {
  $named = $false
  foreach ($a in $args) {
    if ($a -in @('-m','--model','-c','--continue','-r','--resume','--session','--fork')) { $named = $true }
    if ($a -like '--model=*' -or $a -like '-m=*') { $named = $true }
  }
  if ($named) { pi.exe @args } else { pi.exe --model router/orchestrator @args }
}
# <<< pi-workstation bootstrap <<<
`;
}

/** Replace our marked block in `path`, leaving everything else alone. */
function upsertBlock(path, block, marker) {
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const pattern = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?# <<< pi-workstation bootstrap <<<\\n?`, "m");
	const next = pattern.test(current) ? current.replace(pattern, block) : `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}${current === "" ? "" : "\n"}${block}`;
	if (next === current) return log(`${path} already current`);
	if (DRY) return log(`would update ${path}`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, next);
	log(`updated ${path}`);
}

function installShell() {
	step("4/4  shell profile");
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
	installShell();
	console.log("\ndone.");
	if (DRY) console.log("(dry run — rerun without --dry-run to apply)");
	else console.log("Open a new shell, then authenticate providers with `pi login` (or copy auth.json).");
} catch (error) {
	console.error(`\nbootstrap failed: ${error.message}`);
	process.exitCode = 1;
}
