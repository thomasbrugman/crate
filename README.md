<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/t3stash/wordmark-white.png" />
    <source media="(prefers-color-scheme: light)" srcset="assets/t3stash/wordmark-black.png" />
    <img src="assets/t3stash/wordmark-black.png" alt="t3stash" width="360" />
  </picture>
</h1>

[T3 Code](https://github.com/pingdotgg/t3code), except your coding agents run in the cloud.

Every thread gets its own [Upstash Box](https://upstash.com/box): a small Linux machine with your
repository cloned into it and your agent (Command Code, Claude Code or Codex) installed. The agent
works there, not on your laptop. Your Mac runs the app and keeps track of the threads. You can check
in from your phone.

This is a fork of T3 Code v0.1.11. It's experimental, and it is not affiliated with T3 Code or Upstash.

## Why

Local agents are great until you have four of them going. They fight over the same checkout, they
install things globally, and every `rm -rf` is a little scary. Worktrees help, but the agents still
share your disk, your ports and your shell history.

A Box per thread fixes that. Each agent gets a clean machine with full internet access, so it can
install packages and reach its model API. Nothing it does touches your files. When you're done, the
work lives in Git, where it would have ended up anyway.

## Install

### Mac

1. Download the universal ZIP only from a successful [build pushed to `main`](https://github.com/thomasbrugman/t3stash/actions/workflows/t3stash-macos.yml?query=branch%3Amain+event%3Apush).
   Do not install artifacts from pull request builds. The same ZIP works on Apple Silicon and Intel Macs.
2. Unzip it and drag **t3stash.app** to Applications.
3. The app isn't Developer ID-signed or notarized. To open this trusted copy, remove quarantine
   from just the installed app in Terminal, then open it:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/t3stash.app"
   ```

   Alternatively, try opening it once, then choose **Open Anyway** in **System Settings → Privacy
   & Security**.

To make your own universal ZIP, use a Mac with Xcode command-line tools, Rust, and the repo's
Node.js and Vite+ versions:

```sh
vp i
rustup target add aarch64-apple-darwin x86_64-apple-darwin
T3CODE_DESKTOP_SIGNED=false vp run dist:desktop:artifact --platform mac --target zip --arch universal
```

The `t3stash-*-universal.zip` is written to `release/`. The app stores its server state in
`~/.t3stash` and its Electron profile in `~/Library/Application Support/t3stash`, separate from T3 Code.

### Phone (iPhone and Android)

There's no app store build. Your phone uses the web app served by the Mac:

1. On the Mac, open **Settings → Sharing & access** and turn on **Network access**. The app restarts.
2. Create a pairing link and scan its QR code with your phone, or open the link in the phone's
   browser. The phone needs to reach the Mac, so use the same Wi-Fi or [Tailscale](https://tailscale.com).
3. Add it to your home screen if you want it to feel like an app.

Each pairing link works once. Make a new one for each device.

The Mac has to stay awake with the app open. It's the control plane: if it goes to sleep, your
phone loses the connection, even though the Boxes themselves are in the cloud.

## First run

1. Paste your Upstash Box API key. You can get one from the [Upstash console](https://console.upstash.com).
2. Connect at least one agent. Paste an API key or token, or sign in through the temporary Box
   terminal the app opens for you:
   - **Command Code:** an API key, or the contents of `~/.commandcode/auth.json`
   - **Claude Code:** an Anthropic API key, or a token from `claude setup-token`
   - **Codex:** an OpenAI API key, or the contents of `~/.codex/auth.json`
3. To clone private GitHub repositories or push from a Box, save your github.com token in
   **Settings → Source control & issues**.
4. Add a project. t3stash reads the project's Git remote and clones it into each new Box.
   Uncommitted changes on your Mac are not uploaded, so push first.

Agent credentials are encrypted on your Mac and injected into each Box when it starts. They never
end up in a snapshot. New and restored Boxes use your saved GitHub token and GitHub profile
for Git. The token is kept in memory-backed storage. The **Template Box** setting is only
used for legacy Command Code setup, not for Git.

## How it works

- **One Box per thread.** The Box belongs to the thread, not to the agent. You can switch from Claude
  Code to Codex halfway through and keep the same checkout.
- **Subagents share the parent's Box.** Claude Code's subagents show up as child threads, but they
  run in the parent's Box. All three Box harnesses can also delegate through Orchestration V2.
  Delegated Box tasks appear as linked child threads and, in Git projects, get a worktree from the
  parent's commit when the task was delegated. Commit work you want the child to see first.
- **Sizes and snapshots.** Pick small, medium or large per thread. Start a large setup thread from
  the project's **Environment setup** settings, prepare the environment, then choose **Save as
  project snapshot** in the thread menu. New threads use it in their own size. Harness and Git
  credentials use memory-backed storage; known legacy credential paths are excluded during capture.
- **Boxes stick around.** Archiving a thread keeps its Box. Deleting the thread deletes it.
- **Live terminal.** Once the first agent turn creates the Box, open the terminal drawer or a
  terminal tab. Each terminal runs its own shell in the Box, not on your Mac. If the Box connection
  drops and reconnects, the terminal marks the start of a fresh shell; the old process does not
  survive.

## What's missing

Some T3 Code features don't make sense when the agent isn't on your machine, and some just
aren't built yet:

- No diff view, file browser, preview or device panel for cloud threads. Ask the agent to inspect
  files or show you a diff.
- No rollback, approvals, steering an agent mid-turn, file attachments or reasoning streams.
- Project setup scripts don't run in Boxes. Use a snapshot instead.
- Box threads cannot hand off to a host worktree. Files saved by the MCP secret tool stay on the
  server, not in the Box.
- The phone flow hasn't been tested much yet.

If something breaks, [open an issue](https://github.com/thomasbrugman/t3stash/issues).

## Run from source

You need Node 24 and [Vite+](https://viteplus.dev) (`vp`).

```sh
vp i
vp run dev --no-seed
```

Open the pairing URL it prints. You can also give the server your key with `UPSTASH_BOX_API_KEY`
instead of pasting it during setup.

The original T3 Code docs are in [UPSTREAM.md](./UPSTREAM.md) and [docs/](./docs).

## License

MIT. See [LICENSE](./LICENSE).
