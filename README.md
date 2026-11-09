# pi-workstation

One command turns a fresh machine into this pi setup: pi installed, the packages installed from
npm and GitHub, and the config files merged into place. Idempotent — running it again converges
rather than duplicating.

Run it without cloning anything — the script fetches itself and its `configs/` into a temp
directory, uses that, and deletes it afterwards. Nothing is written to the current directory.

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/excessivechaos/pi-workstation/main/install.ps1 | iex
```

```bash
# macOS / Linux / Git Bash
curl -fsSL https://raw.githubusercontent.com/excessivechaos/pi-workstation/main/install.sh | sh
```

Preview first, or pass any option from the table below:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/excessivechaos/pi-workstation/main/install.ps1))) -BootstrapArgs '--dry-run'
```

```bash
curl -fsSL https://raw.githubusercontent.com/excessivechaos/pi-workstation/main/install.sh | sh -s -- --dry-run
```

Cloning still works and is the way to pin a revision, work offline, or edit the configs locally:

```bash
git clone https://github.com/excessivechaos/pi-workstation && cd pi-workstation
./install.sh --dry-run      # see every action
./install.sh                # apply
```

```powershell
git clone https://github.com/excessivechaos/pi-workstation; cd pi-workstation
.\install.ps1 -BootstrapArgs '--dry-run'
.\install.ps1
```

On Windows the script resolves `pi` through `where.exe` and runs it via `cmd.exe` (a `.cmd` shim cannot
be executed directly) or PowerShell for a `.ps1` shim. If detection still fails, name it yourself:
`.\install.ps1 -BootstrapArgs '--pi "C:\Users\you\AppData\Roaming\npm\pi.cmd"'`.

## What it does

1. **pi** — runs the official installer (`pi.dev/install.sh` / `install.ps1`), which also installs
   Node when needed. Skipped when pi is already present, or with `--skip-pi-install`.
2. **packages** — `pi install` for each source, unpinned so `pi update --extensions` follows
   upstream:
   - `npm:pi-commandcode-provider`, `npm:pi-web-access`, `npm:@gotgenes/pi-anthropic-auth`,
     `npm:@juicesharp/rpiv-ask-user-question`
   - `git:github.com/excessivechaos/pi-subscription-router` — minimal fork of the npm router (window kick, cache-stable prompt, publishes the next model for compaction). Superseded and retired sources (the npm router, subagents, Magic Context, fallback chains, the prompt-cache warmer) are removed first.
   - `git:github.com/excessivechaos/pi-quota-statusline` (footer)
   - `git:github.com/excessivechaos/pi-compaction-percent` (soft 40% / hard 60% of the next model's window, pre-switch compaction). Summarisers are the ordered list in `configs/compaction-percent.json`: free 1M models first (`beam:free`, `crouton-alpha`), then `deepseek`, then `current` — paid models come last by that ordering.. Package order matters: it must follow the router, and the script enforces that.
   - `--with-cache-anchor` adds `pi-anthropic-cache-anchor`, which only earns its keep at 1-hour
     cache retention.
3. **configs** — `settings.json` and `models.json` are **merged**: only the keys in the patch are
   written, everything else is left exactly as it is (your values, or pi's defaults). Nothing is
   deleted from either file. Per-model startup thinking levels are set in `modelThinkingLevels`:
   opus medium, sonnet high, haiku xhigh, sol/terra xhigh, luna max, deepseek max. Note that pi
   applies these when a model is *selected*; inside a `router/*` session the router's own thinking
   level is used instead (your theme, keys, locale and any
   hand-added model override survive); `subscription-router.json` and
   `compaction-percent.json` are ours and are written whole. pi's own token-triggered compaction is
   switched off (`compaction.enabled: false`) because `compaction-percent` owns the trigger: one
   percentage instead of a per-model `reserveTokens` table. `keepRecentTokens` still applies. Values live in `configs/`, so changing a chain or a budget is a
   file edit in this repo, not a script edit.
4. **tmux** — a marked block in `~/.tmux.conf` setting `PI_CACHE_RETENTION=long` with
   `set-environment -g`, plus `tmux set-environment -g` against a server that is already running,
   so attached and detached sessions both see it. Skipped when tmux is absent.
5. **shell profile** — a marked block in `~/.bashrc` / `~/.zshrc` / `$PROFILE` that exports
   `PI_CACHE_RETENTION=long`, defaults new sessions to `--model router/orchestrator` (pi's
   default-model lookup rejects a virtual provider) and, on Linux, starts pi under the OOM
   protection if `/usr/local/sbin/protect-pi` exists. The block is replaced in place, never
   duplicated.

The 1-hour tier is the whole cache policy: a 5-minute entry expires across a long tool call or a
walk-away, and the next request then re-bills the entire prefix as a write — at a 400k-token
context, one such bust costs more than the 1-hour write premium for a whole session. Warming the
5-minute tier bought the same thing back for a comparable price, which is why the warmer is
retired rather than replaced.

## What it does not do

- **Credentials.** `auth.json` is never copied. Run `pi login` per provider, or copy the file by
  hand. Without it every model reports "not available".
- **Cache retention beyond the opt-in.** The shell and tmux blocks export
  `PI_CACHE_RETENTION=long`; nothing else is configured on the provider side.
- **Machine-specific extras** — the OOM-protection sudoers entry, `req-diff` diagnostics, a tmux
  server. None are required.

## Layout

```
install.sh            launcher: pi + Node, then bootstrap.mjs
install.ps1           the same for Windows
bootstrap.mjs         the actual work (Node 22.19+, no dependencies)
configs/
  settings.patch.json     merged into ~/.pi/agent/settings.json
  models.patch.json       merged into ~/.pi/agent/models.json
  subscription-router.json
  compaction-percent.json  soft 40% / hard 60% of the next model's window; summarisers listed here
```

## Options

| flag | effect |
|---|---|
| `--dry-run` | print every action, change nothing |
| `--agent-dir DIR` | target a non-default agent dir (`PI_CODING_AGENT_DIR`) |
| `--skip-pi-install` | assume pi is present |
| `--skip-packages` | config only |
| `--skip-shell` | leave the shell profile alone |
| `--skip-tmux` | leave `~/.tmux.conf` and the running tmux server alone |
| `--with-cache-anchor` | also install `pi-anthropic-cache-anchor` |

MIT.
