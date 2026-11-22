# t3stash

T3 Code with its agent runtime in [Upstash Box](https://upstash.com/box).
Upstream documentation is retained in [UPSTREAM.md](./UPSTREAM.md).

## Status

An experimental cloud-only fork of T3 Code v0.1.11. Upstash Box is the only registered
environment for coding agents. Agent replies and tool activity stream through T3's
existing orchestration and chat UI.

Run `vp i`, then `vp run dev --no-seed`. Worktree development uses its own
gitignored `.t3` state; read the printed web/server ports and pairing URL. Configure
Upstash Box during onboarding or in Settings → Providers, or supply
`UPSTASH_BOX_API_KEY` to the server. Connect Command Code, Claude Code, or Codex by
pasting a credential or signing in from the temporary Box terminal. Harness credentials
are encrypted on the server. To clone private GitHub repositories or push from a Box,
save your github.com token in Settings → Source control & issues.

New threads can start from an Upstash snapshot configured in project defaults. Use
snapshots of setup Boxes, not active thread Boxes. The app installs the currently
connected harnesses and injects their credentials and the GitHub login after restoring
the snapshot.

## Choices

- **Stack:** keep upstream's TypeScript, Effect, React, WebSocket contracts, SQLite
  persistence, and event-sourced orchestration. The app server remains the control plane;
  a Box does not run another T3 server.
- **Provider:** `@upstash/box@0.8.1`, with the connected harnesses installed inside the Box. No local
  agent CLI, Replay provider, or local model probing is registered.
- **Lifecycle:** a Box belongs to its thread, not to its selected harness. Switching
  harnesses keeps the checkout and hands off conversation context. Claude's native
  subagents appear in linked child threads and use the parent Box. A missing Box is
  recreated. Deleting the owning thread deletes its Box best-effort; deleting a
  provider-created child does not. Archiving keeps the Box.
- **Workspace:** the server reads the project label's Git metadata (including worktree
  pointers) to find its origin, or first remote. A repository URL label also works.
  Bootstrap configures Git from the saved github.com token and GitHub profile before
  cloning into `/workspace/home/repo`. The GitHub login is kept in memory-backed storage,
  not in the template or snapshot. GitHub SSH-style URLs become HTTPS.
  Embedded URL credentials are discarded. No host files or uncommitted changes are
  uploaded. Without a remote, the agent starts in `/workspace/home`. Existing Boxes
  are not recloned. The project picker still uses existing folders; URL import retains
  upstream's project creation flow rather than adding a new cloud project UI.
- **Worktrees and setup:** cloud launches do not create host worktrees or run project
  setup scripts. App-started subagent turns get a worktree inside the parent Box when
  it contains a Git repository. Local checkpoint capture and restoration are skipped.
- **Terminal and diff:** disabled, not proxied. Server-side terminal and host process/Git
  boundaries reject execution; web terminal/diff/file/preview/device surfaces show
  “Not available in cloud threads.” Use the agent's Box tools to run commands, inspect
  files, or produce a diff. This avoids exposing a host PTY or accidentally reviewing
  unrelated local files. The vendored local-provider packages remain unregistered.
  The host sleep inhibitor is also unregistered; cloud work does not need to keep the
  host's agent process awake.
- **Other limits:** no rollback, active steering, approvals, cross-harness agent
  delegation, MCP callbacks, file attachments, or reasoning stream support yet. Desktop shares
  the web UI; mobile uses the shared provider registry but has not been visually tested.
  The control-plane server must stay running for orchestration; laptop-off operation
  needs a separately hosted server.
  Cloud thread titles retain their prompt-derived names without calling a separate
  text-generation provider; automatic AI title generation is disabled for Box threads.

## License

MIT. See [LICENSE](./LICENSE). Not affiliated with T3 Code or Upstash.
