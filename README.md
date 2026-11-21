# t3stash

T3 Code with its agent runtime in [Upstash Box](https://upstash.com/box).
Upstream documentation is retained in [UPSTREAM.md](./UPSTREAM.md).

## Status

An experimental cloud-only fork of T3 Code v0.1.11. Upstash Box is the only registered
provider on the server and clients. The web settings form supports an API key, template
Box name, optional model, and Box size. Agent replies and tool activity stream through
T3's existing orchestration and chat UI.

Use Node 24, run `vp i`, then `vp run dev --no-seed`. Worktree development uses its own
gitignored `.t3` state; read the printed web/server ports and pairing URL. Configure
Upstash Box in Settings → Providers, or supply `UPSTASH_BOX_API_KEY` to the server.
The default template is `cc-harness`; it must contain the verified Command Code auth,
configuration, and streaming harness. Credentials stay in the template/Box and local
secret settings, never in this repository.

## Choices

- **Stack:** keep upstream's TypeScript, Effect, React, WebSocket contracts, SQLite
  persistence, and event-sourced orchestration. The app server remains the control plane;
  a Box does not run another T3 server.
- **Provider:** `@upstash/box@0.8.1`, with Command Code installed inside the Box. No local
  agent CLI, Replay provider, or local model probing is registered.
- **Lifecycle:** one deterministically named Box per T3 thread. First use creates it,
  installs Command Code, and copies auth/config/harness from the configured template.
  Persisted Box IDs resume via `Box.get`; a missing Box is recreated. The Command Code
  session ID from `finish` preserves follow-up conversation continuity. Interruption
  cancels the stream. Archiving/deleting a T3 thread does **not** delete its Box yet;
  remove unwanted Boxes in Upstash to reclaim storage.
- **Workspace:** every agent runs in `/workspace/home`. The existing project directory
  is retained as a local organizational label, not mounted or uploaded. Add an existing
  folder in the project picker; ask the agent to clone a repository inside its Box.
  Project Git URL import is not a cloud clone workflow in this version.
- **Worktrees and setup:** cloud launches force the root workspace strategy with no host
  branch checkout, worktree creation, or project setup scripts. Worktree restoration and
  checkpoint capture are skipped; checkpoint records are explicitly missing rather
  than pretending a local snapshot exists.
- **Terminal and diff:** disabled, not proxied. Server-side terminal and host process/Git
  boundaries reject execution; web terminal/diff/file/preview/device surfaces show
  “Not available in cloud threads.” Use the agent's Box tools to run commands, inspect
  files, or produce a diff. This avoids exposing a host PTY or accidentally reviewing
  unrelated local files. The vendored local-provider packages remain unregistered.
  The host sleep inhibitor is also unregistered; cloud work does not need to keep the
  host's agent process awake.
- **Other limits:** no rollback, fork, active steering, approvals, MCP callbacks, file
  attachments, application context, or reasoning stream support yet. Desktop shares
  the web UI; mobile uses the shared provider registry but has not been visually tested.
  The control-plane server must stay running for orchestration; laptop-off operation
  needs a separately hosted server.

## License

MIT. See [LICENSE](./LICENSE). Not affiliated with T3 Code or Upstash.
