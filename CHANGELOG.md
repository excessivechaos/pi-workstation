# Changelog

## 1.6.0

- **The default model is `commandcode/deepseek/deepseek-v4.1-flash`**, in one place: `DEFAULT_MODEL`
  in `lib/workstation.mjs`, used by both shell blocks, and `defaultProvider`/`defaultModel` in
  `settings.patch.json`. It also leads `enabledModels`, because pi's resolver takes `scopedModels[0]`
  before the saved default (`core/model-resolver.js:395`) — otherwise a session started without the
  wrapper would land on whichever model happened to be listed first. `router/orchestrator` stays
  scoped, so `pi -m router/orchestrator` is unchanged.


## 1.5.0

- **The scoped set and this station's defaults are in the config now.** `settings.patch.json` gained
  `defaultProvider` and the 11 `enabledModels` (three anthropic, three codex, two commandcode, three
  router), and `modelThinkingLevels` grew to the 9 the machine actually sets — `gpt-6.2-sol` at
  `xhigh`, `zai-org/GLM-5.3` at `max`. Sorted, so a diff reads as a model list.
- **`gpt-6.2-sol` gets a `models.patch.json` entry** like its siblings: `contextWindow` 500000 and
  `promptCache` 300/1800. The refreshed catalog already reports the window; the part that mattered
  is the TTL the compaction policy reads — 30 minutes, not the 1-hour default it would otherwise
  assume for this model alone.


## 1.4.0

- **Every PowerShell profile is written on Windows.** `shellProfilePath` asked `powershell` for
  `$PROFILE.CurrentUserAllHosts`, which is the 5.1 profile; a machine launching pi from `pwsh` 7 kept
  the block in `Documents\PowerShell\profile.ps1` unset and warned `PI_CACHE_RETENTION is not long`
  at every start. Both shells are now resolved and both profiles get the block (deduped, one line
  each in the report), and a Windows box running pi from Git Bash or MSYS2 (`SHELL` is exported) gets
  its rc with the bash block. `applyShellProfile` answers with one result per profile; the installer
  prints a line per file.


## 1.3.0

- **PowerShell passes subcommands through.** The bash block sent `install|remove|uninstall|update|
  list|config|auth|mcp|--help|--version` straight to pi; the PowerShell block did not, so
  `pi update --extensions` on a Windows install injected `--model router/orchestrator` and started a
  session whose first message was "update". Both blocks now render the same `PI_SUBCOMMANDS` list.
  The block now travels with the rest of the configs (below), so `pi update --extensions` fixes it.
- **The shell profile is a managed config.** `applyShellProfile` moved into `lib/workstation.mjs`:
  the extension writes the marked block at every start (bash/zsh: `~/.bashrc`/`~/.zshrc`; Windows:
  `$PROFILE.CurrentUserAllHosts`, resolved through PowerShell), and the installer runs the same
  function. Only a changed block is written, so a converged machine touches nothing.
- **`codemode` is on.** `defaultTools: ["+codemode"]` in `settings.patch.json` keeps `read`, `bash`,
  `edit` and `write` and adds the script sandbox, so one call can batch tool calls and run classifier
  and image models without the intermediate results entering the context.

- **Removals are explicit only.** `planPackages` no longer treats "ours, but not in my list" as a
  retirement: an in-process list older than the settings file would delete the packages newer than
  itself. On 2026-11-15 that silently uninstalled `pi-quota-peek` and `pi-quota-resume` from a
  long-running session. Only `REMOVED_PACKAGES` removes anything now; dropping a source from
  `PACKAGES` means "stop installing it", not "uninstall it".
- **`pi-workstation.log`.** Every package pass appends the plan, each action and any failure to
  `$PI_CODING_AGENT_DIR/pi-workstation.log` (rotated at 200 kB). The sync runs in the background,
  where a notification resolving against a stale context can vanish without a trace. Each line
  carries `[pid <n> <session-id>]`, so a disappearance can be attributed to a process, not just
  dated.

- `configs/compaction-percent.json`: `bustTokens: 150000`. Compaction-percent 2.4.0 compacts before a
  prefix rewrite it can see coming — an expired cache or a changed system prompt — once the context is
  past that line. Covers the case where an edited `AGENTS.md` under a warm cache cost a whole-prefix
  write ($1.61 measured on a 240k session).
  A user model switch is the third bust reason (2.5.0): the newly selected model has never seen the
  prefix, so above `bustTokens` it compacts at the next run. Any selected model counts, including
  `router/*`; the router's own per-request choices never emit `model_select` and are ignored.

- **Package membership converges at session start.** `lib/packages.mjs` drives pi's own
  `DefaultPackageManager`: a fresh machine needs only
  `pi install git:github.com/excessivechaos/pi-workstation`, and every later start installs what
  `PACKAGES` lists, removes `REMOVED_PACKAGES`, and retires any `git:.../excessivechaos/*` source
  that dropped off the list. `OPTIONAL_PACKAGES` and foreign sources are never touched. Installs
  run in the background after the config pass (never blocking a turn, no network when converged)
  and announce themselves with "restart or /reload to activate"; `/apply-config preview` shows the
  package plan, `/apply-config` applies it.
- `/apply-config` reloads the session itself after installing or removing packages, so the change is
  live without a restart. Only a command context can reload (`ctx.reload()`); the `session_start`
  sync still asks for `/reload` because an event handler has no reload in pi's API.

- Two new packages, both quota-aware, both explicit-model-first:
  - **pi-quota-peek** is the single source of truth for subscription quota windows: it owns the
    Anthropic and Codex usage collectors and publishes snapshots and per-model reset times through
    `globalThis` symbols, so consumers never import it and never fetch the same endpoint twice.
    The router keeps its own internal copy on purpose; removing either never breaks the other.
  - **pi-quota-resume** resumes a session that settled on a quota error: it resolves the reset
    instant (error text, then peek, then a 15-to-60-minute poll ladder), and sends `continue` at the
    reset with no distance cap — 5-hour or weekly. Model changes never cancel by themselves (the
    schedule is pinned to the stopped model and checked at fire time), any user run does, and the
    give-up guard counts whole resumes, not pi's four retries inside one.
  - **pi-quota-statusline 1.3.0** reads its quota segments from peek instead of fetching the usage
    endpoints itself.

- `configs/compaction-percent.json`: summaries come from `deepseek-v4.1-flash` alone. The two
  CommandCode free models ahead of it in the list no longer resolve in the model registry, so every
  compaction was already falling through to DeepSeek — silently, since the extension only warns when
  *no* summariser is available. Measured over nine compactions: 1.0 M input / 43.7 k output, $0.196
  ($0.017-0.038 each, one peak-window compaction at 2x). `current` is dropped with them; if DeepSeek
  fails, the boundary writes nothing and pi's overflow recovery still covers the wall.

## 1.1.0

- `pi-cache-keepalive` is a package again, at 1.1.0, which warms while a run is *blocked* (a long
  tool, or an unanswered question) instead of only when the agent was idle. It owns prompt-cache
  warming: `cacheWarming` is back to `off` so pi's built-in warmer (one refresh at 54 minutes, then
  a hard stop at 60) does not warm the same entry three minutes earlier.
- `configs/cache-keepalive.json`: warm at 85% of the TTL, budget 25% of one cold start, 8 h cap.
  About ten warms — roughly nine hours of cover at 250k, $0.49, against a $1.98 cold write.

## 1.0.0

- The repo is now also a pi package (`index.ts`). Its extension applies `configs/` at every
  `session_start`, so `pi update --extensions` delivers config changes to machines that never rerun
  the installer. `/apply-config` applies on demand, `preview` shows the diff-to-be, `path` shows the
  directories.
- `lib/workstation.mjs` holds the package list, the merge and the apply step that `bootstrap.mjs`
  used to inline; the installer and the extension now run the same code.
- Writes are content-compared: a converged machine writes nothing. Config files are written
  atomically.
