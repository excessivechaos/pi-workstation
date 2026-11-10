# Changelog

## 1.0.0

- The repo is now also a pi package (`index.ts`). Its extension applies `configs/` at every
  `session_start`, so `pi update --extensions` delivers config changes to machines that never rerun
  the installer. `/apply-config` applies on demand, `preview` shows the diff-to-be, `path` shows the
  directories.
- `lib/workstation.mjs` holds the package list, the merge and the apply step that `bootstrap.mjs`
  used to inline; the installer and the extension now run the same code.
- Writes are content-compared: a converged machine writes nothing. Config files are written
  atomically.
