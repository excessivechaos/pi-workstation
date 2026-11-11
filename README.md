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
   - `git:github.com/excessivechaos/pi-workstation` — this repo is also a package: its extension
     re-applies the configs on every start (see below), so other machines converge with
     `pi update --extensions` instead of a rerun of the installer.
   - `npm:pi-commandcode-provider`, `npm:pi-web-access`, `npm:@gotgenes/pi-anthropic-auth`,
     `npm:@juicesharp/rpiv-ask-user-question`
   - `git:github.com/excessivechaos/pi-subscription-router` — minimal fork of the npm router (window kick, cache-stable prompt, publishes the next model for compaction). Superseded and retired sources (the npm router, subagents, Magic Context, fallback chains, the prompt-cache warmer) are removed first.
   - `git:github.com/excessivechaos/pi-quota-statusline` (footer)
   - `git:github.com/excessivechaos/pi-compaction-percent` (absolute token lines: 250k soft / 300k hard, capped at 90% of the model's window, pre-switch compaction). Summarisers are the ordered list in `configs/compaction-percent.json`: free 1M models first (`beam:free`, `crouton-alpha`), then `deepseek`, then `current` — paid models come last by that ordering.. Package order matters: it must follow the router, and the script enforces that.
   - `--with-cache-anchor` adds `pi-anthropic-cache-anchor`, which only earns its keep at 1-hour
     cache retention.
3. **configs** — the same code the extension runs (`lib/workstation.mjs`), so a fresh machine and
   an updated one converge on the same result. `settings.json` and `models.json` are **merged**: only the keys in the patch are
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
   protection if `/usr/local/sbin/protect-pi` exists. The `pi` function passes subcommands
   (`install`, `remove`, `update`, `list`, `config`, `auth`, `mcp`, `--help`, `--version`) straight
   through — without that, `pi update` would become a session whose first message is "update". The
   block is replaced in place, never duplicated.

The 1-hour tier is the base of the cache policy: a 5-minute entry expires across a long tool call or
a walk-away, and the next request then re-bills the entire prefix as a write — at a 400k-token
context, one such bust costs more than the 1-hour write premium for a whole session. The separate
`pi-cache-keepalive` package is retired because pi's own warmer covers the one gap the tier leaves,
and covers it better: `cacheWarming: "streaming"` schedules a `max_tokens: 1` replay at 90% of the
TTL (54 minutes at 1h), it is not gated on the agent being idle, and it stops at 60 minutes from the
request — so a run blocked on a tool or an unanswered question gets **one** warm, for about
`tokens × $0.2/M` (~$0.05 at 250k), and the request that resumes reads the cache instead of paying a
$2 cold write. Measured: four warms during a 45-second `sleep`, every one `cacheWrite=0`, and the
resuming request wrote 87 tokens. It stays quiet below the ~10k tokens where a bust is worth less
than the $0.05 it charges to avoid it, and `idle` mode would be inert at 1h (its 30-minute ceiling
is under the 54-minute delay).

## Configs travel with the code

The repo is a pi package as well as an installer. Its extension
(`index.ts` → `lib/workstation.mjs`) re-applies `configs/` at every `session_start`, so on a machine
that already ran the installer once:

```bash
# edit configs/ here, commit, push, then on the other machine:
pi update --extensions      # pulls the code, and the configs with it
```

The next start applies them. Nothing is written when nothing changed (start is silent and does no
I/O beyond four reads), `/apply-config preview` shows what a start would do, `/apply-config` does it
now, and `/apply-config path` prints where the files come from and go.

`settings.json` and `models.json` are still merged, never replaced, so a machine's theme, keys,
locale and hand-added model overrides survive an update. The two wholly-owned files
(`subscription-router.json`, `compaction-percent.json`) are replaced: edit them in `configs/`, not
in `~/.pi/agent`, or the next start will put the repo's version back.

`pi update --extensions` itself does not start pi, so a machine that is already running keeps its
loaded config until the next session; only `compaction-percent` re-reads its file at start, which is
why this package is ordered before it.

## What it does not do

- **Credentials.** `auth.json` is never copied. Run `pi auth login <provider>` per provider, or copy the file by
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
index.ts              the extension: /apply-config, and the same apply run at session start
lib/workstation.mjs   the package list and the merge/apply logic both of them share
configs/
  settings.patch.json     merged into ~/.pi/agent/settings.json
  models.patch.json       merged into ~/.pi/agent/models.json
  subscription-router.json
  compaction-percent.json  250k soft / 300k hard token lines, 90% of the window as the ceiling; summarisers listed here
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
