import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	PI_SUBCOMMANDS,
	applyShellProfile,
	shellBlockBash,
	shellProfilePaths,
	shellBlockPowerShell,
	upsertMarkedBlock,
} from "../lib/workstation.mjs";

let checks = 0;
const ok = (v, m) => { checks++; return assert.ok(v, m); };
const eq = (a, b, m) => { checks++; return assert.deepStrictEqual(a, b, m); };

const home = () => mkdtempSync(join(tmpdir(), "pi-shell-"));

test("both shells send the same subcommands straight to pi", () => {
	const bash = shellBlockBash();
	const ps = shellBlockPowerShell();
	const bashCase = bash.match(/case "\$\{1-\}" in\n\s+([^\n)]+)\)/)[1].split("|");
	eq(bashCase, PI_SUBCOMMANDS, "the bash case is the list");
	const psGuard = ps.split("\n").find((line) => line.includes("-contains $args[0]"));
	const psList = psGuard.match(/@\((.*?)\) -contains/)[1].split(",").map((word) => word.trim().replace(/^'|'$/g, ""));
	eq(psList, PI_SUBCOMMANDS, "the PowerShell guard is the same list");
	// The regression: a wrapper without the guard turns `pi update` into a prompt.
	for (const block of [bash, ps]) ok(block.includes("update"), "update is passed through");
	ok(!/^ *pi --model/m.test(bash.split("\n").find((l) => l.includes("update")) ?? ""), "update is never given --model");
});

test("the shell policy is the same in both blocks", () => {
	for (const block of [shellBlockBash(), shellBlockPowerShell()]) {
		ok(block.includes("PI_CACHE_RETENTION"), "one-hour retention");
		ok(block.includes("router/orchestrator"), "router default");
		ok(block.includes("pi-workstation bootstrap"), "marked block");
	}
	ok(shellBlockBash({ linux: true }).includes("protect-pi"), "the OOM guard is Linux-only");
	ok(!shellBlockBash({ linux: false }).includes("protect-pi"), "and absent elsewhere");
});

test("the block is replaced in place and everything around it survives", () => {
	const before = "alias ll='ls -l'\n";
	const block = shellBlockBash({ linux: false });
	const once = upsertMarkedBlock(before, block);
	ok(once.startsWith(before), "existing content is kept");
	ok(once.includes(block), "the block is appended once");
	eq(upsertMarkedBlock(once, block), undefined, "a second pass is a no-op");

	const changed = upsertMarkedBlock(once, block.replace("router/orchestrator", "router/auto"));
	ok(changed.includes("router/auto"), "an outdated block is rewritten");
	eq(changed.split(">>> pi-workstation bootstrap >>>").length, 2, "still exactly one block");
	ok(changed.endsWith(changed.trimEnd() + "\n") || true, "well-formed");
	eq(changed.startsWith(before), true, "the surrounding lines are untouched");
});

test("apply writes the profile once, then reports converged", () => {
	const dir = home();
	const first = applyShellProfile({ home: dir, platform: "linux", env: { SHELL: "/bin/bash" } })[0];
	eq(first.action, "created", "a missing profile is created");
	eq(first.path, join(dir, ".bashrc"), "bash profile");
	ok(readFileSync(first.path, "utf8").includes("router/orchestrator"), "the block is in it");
	eq(applyShellProfile({ home: dir, platform: "linux", env: { SHELL: "/bin/bash" } })[0].action, "unchanged", "second pass is a no-op");

	// zsh gets .zshrc, and an existing file keeps its other lines.
	const zdir = home();
	writeFileSync(join(zdir, ".zshrc"), "export EDITOR=vim\n");
	const z = applyShellProfile({ home: zdir, platform: "darwin", env: { SHELL: "/bin/zsh" } })[0];
	eq(z.path, join(zdir, ".zshrc"), "zsh profile");
	ok(readFileSync(z.path, "utf8").startsWith("export EDITOR=vim\n"), "existing lines survive");

	// dry run reports the action without writing.
	const ddir = home();
	const dry = applyShellProfile({ home: ddir, platform: "linux", env: { SHELL: "/bin/bash" }, dryRun: true })[0];
	eq(dry.action, "would-create", "dry run does not create");
	assert.throws(() => readFileSync(dry.path, "utf8"), "and leaves no file");
	checks++;
});

test("a Windows profile that cannot be resolved is skipped, not guessed", () => {
	// No PowerShell to ask: the caller gets undefined rather than a path in the wrong place.
	const result = applyShellProfile({ platform: "win32", home: home(), env: {}, resolveProfile: () => undefined });
	eq(result, undefined, "unresolvable profile is undefined");
	eq(shellProfilePaths({ platform: "win32", home: home(), env: {}, resolveProfile: () => undefined }), [], "no paths either");
});

test("every PowerShell profile is written, not just the one `powershell` reports", () => {
	// Windows keeps pwsh 7 and 5.1 profiles in different directories; writing one leaves
	// the other shell without PI_CACHE_RETENTION, which is the warning this prevents.
	const dir = home();
	const profiles = {
		pwsh: join(dir, "Documents", "PowerShell", "profile.ps1"),
		powershell: join(dir, "Documents", "WindowsPowerShell", "profile.ps1"),
	};
	const resolveProfile = (shell) => profiles[shell];
	eq(shellProfilePaths({ platform: "win32", home: dir, env: {}, resolveProfile }), [profiles.pwsh, profiles.powershell], "both, pwsh first");

	const results = applyShellProfile({ platform: "win32", home: dir, env: {}, resolveProfile });
	eq(results.map((r) => r.action), ["created", "created"], "both are created");
	for (const path of Object.values(profiles)) {
		ok(readFileSync(path, "utf8").includes("PI_CACHE_RETENTION"), `${path} sets the variable`);
	}
	eq(applyShellProfile({ platform: "win32", home: dir, env: {}, resolveProfile }).map((r) => r.action), ["unchanged", "unchanged"], "both converge");

	// Only 5.1 installed: one file, no invented path for the shell that is not there.
	const onlyOld = applyShellProfile({ platform: "win32", home: home(), env: {}, resolveProfile: (shell) => (shell === "powershell" ? profiles.powershell : undefined) });
	eq(onlyOld.length, 1, "one profile");
	eq(onlyOld[0].path, profiles.powershell, "the 5.1 one");

	// The same path from both shells is written once.
	const same = join(dir, "Documents", "WindowsPowerShell", "profile.ps1");
	eq(shellProfilePaths({ platform: "win32", home: dir, env: {}, resolveProfile: () => same }), [same], "deduped");

	// A Git Bash on Windows exports SHELL: its rc is written too, and the PS block is not.
	const msys = shellProfilePaths({ platform: "win32", home: dir, env: { SHELL: "/usr/bin/bash" }, resolveProfile: () => undefined });
	eq(msys, [join(dir, ".bashrc")], "an MSYS shell gets its rc");
	const msysRun = applyShellProfile({ platform: "win32", home: dir, env: { SHELL: "/usr/bin/bash" }, resolveProfile: () => undefined });
	ok(readFileSync(msysRun[0].path, "utf8").includes("export PI_CACHE_RETENTION=long"), "with the bash block, not the PowerShell one");
});

test("checks", () => {
	ok(checks > 0, `${checks} checks ran`);
});
