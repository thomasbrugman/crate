---
name: devin-testing-caveats
description: Record the known verification limits for T3 Code work when no Upstash Box credential is available. Use when planning, scoping, or reporting agent verification of Box-backed turns, checkpoint restore, in-Box git operations, or provider logins.
---

# Devin testing caveats

Guidance for coding-agent sessions (Devin, CI agents, local agents) verifying
T3 Code changes. Complements
[test-t3-app](../test-t3-app/SKILL.md), which covers UI verification through
the Browser panel.

## Box-backed flows need a live Box credential

Without an Upstash Box credential, an agent cannot verify:

- real Box-backed agent turns (only recorded replay through the dev provider,
  such as `Replay (dev)`);
- checkpoint file restore;
- git operations executed inside a Box.

Never claim these paths as tested when no credential was present. Report the
gap explicitly: name what was verified (build, typecheck, test shards, agent
context budget) and what was not. A green CI run is not full verification when
a review lane was skipped, as in #81 (T3 Code v0.1.12 sync, Nov 2026), where
Devin Review reported "skipped" and Box-backed flows went untested.

## Distinguish tested from reasoned

Mark conclusions drawn from source reading or local installs as reasoned, not
proven. The Nov 2026 shared-login snapshot spike judged the snapshot design a
conditional no-go from fx's and pi's client code (single-use refresh-token
copies with no cross-Box coordination). Per-issuer token rotation and reuse
detection stay unproven until a live test with real provider accounts runs in
real Boxes.

## Headless login limits

When a test needs provider auth:

- Device-code OAuth and API-key logins (`fx login --api-key`, pi per-provider
  API keys) work headless.
- Localhost-redirect logins with a paste-back fallback (`fx login grok`,
  `pi /login`) need an interactive relay of the URL out and the code back.
- Localhost-redirect-only logins without a fallback (`fx login codex`, the
  ChatGPT subscription) cannot work headless at all.

Do not spend session time on subscription logins in a headless Box. Use the
API-key paths and treat subscription login support as a separate product
decision.
