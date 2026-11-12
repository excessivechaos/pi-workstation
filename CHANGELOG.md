# Changelog

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
