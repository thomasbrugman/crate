# t3stash

Run T3 Code threads on [Upstash Box](https://upstash.com/pricing/box) instead of your laptop.

## The idea

T3 Code gives each thread its own workspace. t3stash would give each thread its own box.

A box is a disposable Linux machine that pauses when nothing is using it. Paused boxes cost
nothing, and waking one takes a request, not a boot. A coding agent is idle most of the time —
writing files, waiting on a model, waiting on you — so the bill tracks the few seconds it
actually computes.

## Why it's cheap

PAYG is billed per active CPU hour, not per wall-clock hour.

| Size   | vCPU | RAM  | Disk | All cores busy | Idle |
| ------ | ---- | ---- | ---- | -------------- | ---- |
| Small  | 2    | 4 GB | 10 GB | $0.10/hr      | $0   |
| Medium | 4    | 8 GB | 30 GB | $0.20/hr      | $0   |
| Large  | 8    | 16 GB | 30 GB | $0.40/hr      | $0   |

A medium box burning one percent of one core costs $0.002/hr, about $1.50 a month if it never
stopped. An equivalent always-on box is $16/month, and a laptop is "free" until you count the
electricity and the fan noise. The free tier includes 10 concurrent boxes and 5 CPU hours a
month, which is enough to try this without a card.

The trade is latency, not correctness: boxes live in AWS `us-east-1`, so a cold wake is a
network round trip away from you.

## How it would work

1. New thread starts a box, or restores one from a snapshot.
2. Provision: clone the repo, install the toolchain, write model keys into box env vars.
3. The agent server runs on the box; the UI attaches over SSH or a tunnel.
4. No activity for a while, the box freezes. Next message wakes it and the thread continues.
5. When the environment is good, snapshot it. New threads start from the snapshot.

## Status

Nothing is built. There is no code in this repo yet — it exists to hold the idea and the
license. The Box CLI and the provisioning scripts in my own fleet setup work today, so the
pieces below are known to exist, but nobody has wired them into T3 Code.

Open questions worth answering before writing anything:

- Cold start latency on wake, measured end to end from "send a message" to "agent responds".
- What happens to an agent run that is mid-tool-call when the box freezes.
- Whether the UI should stay local and tunnel in, or be served from the box.
- Snapshot staleness: a snapshot freezes old tool versions and old credentials.
- Secrets. Model keys belong in box env, not on the box filesystem.

## License

MIT. See [LICENSE](./LICENSE).
