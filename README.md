# pi-workstation

One command turns a fresh machine into this pi setup: pi installed, the packages installed from
npm and GitHub, and the config files merged into place. Idempotent — running it again converges
rather than duplicating.

```bash
# macOS / Linux / Git Bash
git clone https://github.com/excessivechaos/pi-workstation && cd pi-workstation
./install.sh --dry-run      # see every action
./install.sh                # apply
```

```powershell
# Windows PowerShell
git clone https://github.com/excessivechaos/pi-workstation; cd pi-workstation
.\install.ps1 -BootstrapArgs '--dry-run'
.\install.ps1
```

## What it does

1. **pi** — runs the official installer (`pi.dev/install.sh` / `install.ps1`), which also installs
   Node when needed. Skipped when pi is already present, or with `--skip-pi-install`.
2. **packages** — `pi install` for each source, unpinned so `pi update --extensions` follows
   upstream:
   - `npm:pi-commandcode-provider`, `npm:pi-web-access`, `npm:@gotgenes/pi-anthropic-auth`,
     `npm:@juicesharp/rpiv-ask-user-question`
   - `git:github.com/excessivechaos/pi-subscription-router` — minimal fork of the npm router (window kick, cache-stable prompt, publishes the next model for compaction). Superseded sources (the npm router, subagents, Magic Context, fallback chains) are removed first.
   - `git:github.com/excessivechaos/pi-quota-statusline` (footer)
   - `git:github.com/excessivechaos/pi-cache-keepalive` (prompt-cache warmer)
   - `git:github.com/excessivechaos/pi-compaction-percent` (soft 40% / hard 60% of the next model's window, pre-switch compaction, summaries by `router/compact`). Package order matters: it must follow the router, and the script enforces that.
   - `--with-cache-anchor` adds `pi-anthropic-cache-anchor`, which only earns its keep at 1-hour
     cache retention.
3. **configs** — `settings.json` and `models.json` are **merged** (your theme, keys, locale and any
   hand-added model override survive); `subscription-router.json`, `cache-keepalive.json` and
   `compaction-percent.json` are ours and are written whole. pi's own token-triggered compaction is
   switched off (`compaction.enabled: false`) because `compaction-percent` owns the trigger: one
   percentage instead of a per-model `reserveTokens` table. `keepRecentTokens` still applies. Values live in `configs/`, so changing a chain or a budget is a
   file edit in this repo, not a script edit.
4. **shell profile** — a marked block in `~/.bashrc` / `~/.zshrc` / `$PROFILE` that defaults new
   sessions to `--model router/orchestrator` (pi's default-model lookup rejects a virtual
   provider) and, on Linux, starts pi under the OOM protection if `/usr/local/sbin/protect-pi`
   exists. The block is replaced in place, never duplicated.

## What it does not do

- **Credentials.** `auth.json` is never copied. Run `pi login` per provider, or copy the file by
  hand. Without it every model reports "not available".
- **Cache retention.** pi's default is the 5-minute tier, which is what this setup wants; there is
  no environment variable to set. `PI_CACHE_RETENTION=long` is the opt-in for the 1-hour tier.
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
  cache-keepalive.json
  compaction-percent.json  compaction at 40% of the serving model's window
```

## Options

| flag | effect |
|---|---|
| `--dry-run` | print every action, change nothing |
| `--agent-dir DIR` | target a non-default agent dir (`PI_CODING_AGENT_DIR`) |
| `--skip-pi-install` | assume pi is present |
| `--skip-packages` | config only |
| `--skip-shell` | leave the shell profile alone |
| `--with-cache-anchor` | also install `pi-anthropic-cache-anchor` |

MIT.
