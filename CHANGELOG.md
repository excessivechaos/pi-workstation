# Changelog

## Unreleased

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

## Unreleased

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
