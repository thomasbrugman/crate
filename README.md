# t3stash

Run your T3 Code agents on [Upstash Box](https://upstash.com/pricing/box).

t3stash would create boxes on your own Upstash account and add them to [T3 Code](https://t3.codes)
as environments. A box freezes when nothing is using it and wakes on the next request, so you pay
for the second your agent computes and nothing while it waits.

Same idea as [t3boat](https://t3boat.paukraft.com), different substrate: t3boat puts machines on
Boat, this would put them on Box.

## Why Box

Box bills per active CPU second. Not per wall-clock hour, not per box that exists.

| Size   | vCPU | RAM  | Disk  | All cores busy | Idle |
| ------ | ---- | ---- | ----- | -------------- | ---- |
| Small  | 2    | 4 GB | 10 GB | $0.10/hr       | $0   |
| Medium | 4    | 8 GB | 30 GB | $0.20/hr       | $0   |
| Large  | 8    | 16 GB | 30 GB | $0.40/hr       | $0   |

An agent spends most of a thread waiting — on the model, on you, on a build it started. A medium
box using one percent of one core costs $0.002/hr, about $1.50 a month at that rate. The same box
on a fixed always-on plan is $16/month. Storage is $0.10/GB/month and the free tier gives you 5
CPU hours and 10 concurrent boxes, so an experiment costs nothing.

Boxes run in AWS `us-east-1` only, for now. That is a network round trip from anywhere else, which
is the whole cost of this idea: the wake is the product.

## What you'd get

- Create, resize and delete boxes without touching a terminal
- Pick a box in T3 Code and work there as usual; a message to a frozen box wakes it
- Boxes that freeze mid-day and come back with the same workspace, because the disk was
  snapshotted on the way down
- Cost per box, today and this month, measured rather than estimated
- An hour of work that finishes with your laptop closed

## How it would work

```
T3 Code ──ws──> local proxy (t3stash) ──https──> T3 server on a Box
                    │                              └─ watchdog: stop the box when idle
                    └─ box CLI: create / resume / exec / snapshot
```

- The box runs a T3 server on loopback, pinned to your desktop app's version.
- The proxy gives each box a stable `http://localhost:<port>` for T3 Code to pair with, so a new
  address after a resume never matters. It holds reads while the box sleeps and serves what it
  captured on the way down, so opening a chat does not wake anything.
- A real request — a message, a tool call — wakes the box and the socket resyncs.
- A watchdog on the box stops it when no agent run is in flight and nobody has touched it for a
  while; a snapshot is taken first so the disk survives past Upstash's retention.
- Box freezes itself after 6 hours idle, which is a second, independent safety net.

The pieces are individually known to work: `box create`, `box exec`, `box files write`,
`box snapshot`, `box --box <id> resume`, SSH through the box gateway, and auto-pause on idle. No
one has wired them into T3 Code yet.

## Status

Nothing is built. No code, no installer, no builds. This repo holds the idea and the license.

Open questions worth answering before writing anything:

- How long a wake actually takes, end to end, from "send" to "agent responds". If it exceeds T3
  Code's slow-request window, the proxy has to accept the message first and reconcile later.
- Box has no client-side API to resume on a timer. Scheduled work and automations would need the
  proxy running and awake, or they silently miss.
- Box auto-pauses on its own clock; a watchdog that stops cleanly is still needed to snapshot and
  to drain in-flight work.
- What to do with a run that is mid-tool-call when the box freezes.
- Whether the desktop app should host the proxy, or a single always-on box should, so a closed
  laptop doesn't leave the fleet unreachable.
- Where model credentials live. Box env is the obvious place; the box filesystem is not.

## License

MIT. See [LICENSE](./LICENSE).

Inspired by [t3boat](https://github.com/paukraft/t3boat). Not affiliated with T3 Code, Upstash, or
Boat.
