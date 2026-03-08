# Tauri Shell

This shell starts the local Sthyra stack and opens the managed dashboard URL in a native Mac window for NyraQ.

## Dev

```bash
cd apps/desktop
npm run tauri:dev
```

The shell bootstraps the repository-level launcher when it can locate the repo root automatically or via `STHYRA_REPO_ROOT`.

- `../../scripts/stack.sh start`
- Dashboard URL: `http://localhost:4174`
- Release build: `cd apps/desktop && npm run tauri:build`

If the dashboard is not ready in time, the shell falls back to a local loading page.

Current limitation: the packaged app still expects the local Sthyra repository layout so it can bootstrap `scripts/stack.sh` and the existing desktop stack.
