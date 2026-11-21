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
  cancels the stream. Deleting a thread deletes its Box best-effort after committing
  the thread deletion; failures log a warning and may require manual cleanup in Upstash.
  Archiving keeps the Box.
- **Workspace:** the server reads the project label's Git metadata (including worktree
  pointers) to find its origin, or first remote. A repository URL label also works.
  Bootstrap copies `.git-credentials` and `.gitconfig` from the template when present
  and clones the remote into `/workspace/home/repo`; Command Code starts there using
  `BOXJOB_CC_CWD`. GitHub SSH-style URLs become HTTPS so template credentials work.
  Embedded URL credentials are discarded. No host files or uncommitted changes are
  uploaded. Without a remote, the agent starts in `/workspace/home`. Existing Boxes
  are not recloned. The project picker still uses existing folders; URL import retains
  upstream's project creation flow rather than adding a new cloud project UI.
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
  Cloud thread titles retain their prompt-derived names without calling a separate
  text-generation provider; automatic AI title generation is disabled for Box threads.

## License

MIT. See [LICENSE](./LICENSE). Not affiliated with T3 Code or Upstash.
