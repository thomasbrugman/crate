# t3stash

Run your T3 Code agents on [Upstash Box](https://upstash.com/pricing/box).

t3stash would create boxes on your own Upstash account and add them to [T3 Code](https://t3.codes)
as environments. A box freezes when nothing is using it and wakes on the next request. You pay for
the CPU seconds your agent uses and nothing while it waits.

The idea comes from [t3boat](https://t3boat.paukraft.com). t3boat creates machines on Boat and adds
them to T3 Code. t3stash would create boxes on Upstash and do the same.

## Why Box

Box bills per active CPU second, not per wall-clock hour or per box that exists.

| Size   | vCPU | RAM  | Disk  | All cores busy | Idle |
| ------ | ---- | ---- | ----- | -------------- | ---- |
| Small  | 2    | 4 GB | 10 GB | $0.10/hr       | $0   |
| Medium | 4    | 8 GB | 30 GB | $0.20/hr       | $0   |
| Large  | 8    | 16 GB | 30 GB | $0.40/hr       | $0   |

An agent spends most of a thread waiting: on the model, on you, on a build it started. A medium box
that uses one percent of one core costs $0.002/hr, which is about $1.50 a month at that rate. The
same box on a fixed always-on plan costs $16 a month. Storage is $0.10 per GB per month. The free
tier gives you 5 CPU hours and 10 concurrent boxes, so an experiment costs nothing.

Boxes run in AWS us-east-1 only. A wake is a network round trip from anywhere else, and that
latency is the main cost of running this way.

## What you'd get

- Create, resize and delete boxes without a terminal.
- Pick a box in T3 Code and work there as usual. A message to a frozen box wakes it.
- A box that freezes mid-day and comes back with the same workspace, because it snapshots its disk
  before it stops.
- Cost per box for today and for the month, taken from Upstash usage.
- Work that finishes with your laptop closed.

## How it would work

```
T3 Code  --websocket-->  proxy on localhost  --https-->  T3 server on a box
                              |
                              +-- box CLI: create, resume, exec, snapshot
```

- The box runs a T3 server on loopback, pinned to your desktop app's version.
- The proxy gives each box a stable `http://localhost:<port>` for T3 Code to pair with, so a new
  address after a resume never matters.
- While the box is frozen the proxy answers reads from what it captured on the way down. Opening a
  chat does not wake the box.
- A message or a tool call wakes the box, and the socket reconnects.
- A watchdog stops the box when no agent run is in flight and nobody has touched it for a while. It
  snapshots the disk first, so the workspace outlives Upstash's disk retention.
- Box freezes itself after 6 hours idle. That covers the case where the watchdog fails.

Each piece works on its own today: `box create`, `box exec`, `box files write`, `box snapshot`,
`box --box <id> resume`, SSH through the box gateway, and auto-pause. Nobody has connected them to
T3 Code yet.

## Status

The repo is the T3 Code v0.1.10 tree with this README in front of it. Nothing of t3stash is built
yet. Upstream's README is in [UPSTREAM.md](./UPSTREAM.md).

Questions to answer before writing any of it:

- How long a wake takes, from "send" to "agent responds". If it runs past T3 Code's slow-request
  window, the proxy has to accept the message first and reconcile after the box wakes.
- Box cannot resume a box on a timer. Scheduled work and automations would need the proxy awake, or
  they miss their run.
- Box pauses on its own clock. A watchdog is still needed to snapshot and to let in-flight work
  finish.
- What to do with a run that is mid-tool-call when the box freezes.
- Whether the proxy lives in the desktop app or on one always-on box. With the desktop app, closing
  your laptop leaves the boxes unreachable.
- Where model credentials live. Box environment variables are the obvious place. The box
  filesystem is not.

## License

MIT. See [LICENSE](./LICENSE).

Not affiliated with T3 Code, Upstash or Boat.
