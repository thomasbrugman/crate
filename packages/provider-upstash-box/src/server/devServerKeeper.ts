export const DEV_SERVER_KEEPER_PATH = `/home/boxuser/.local/bin/crate-dev-servers.mjs`;
export const DEV_SERVER_KEEPER_INIT = `test ! -f ${DEV_SERVER_KEEPER_PATH} || node ${DEV_SERVER_KEEPER_PATH} boot >/dev/null 2>&1`;

/**
 * Runs inside the Box. `list` prints the user's listening servers, `watch` keeps a record of
 * them, and `boot` (the Box init command) restarts recorded servers after the Box wakes.
 */
export const devServerKeeper = String.raw`import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';

const self = process.argv[1];
const stateDir = '/home/boxuser/.local/state/crate';
const statePath = stateDir + '/dev-servers.json';
const lockPath = stateDir + '/dev-servers.pid';
const uid = String(process.getuid());

const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const isLoopback = (hex) => hex.length === 8
  ? hex.endsWith('7F')
  : hex === '00000000000000000000000001000000' || (hex.startsWith('0000000000000000FFFF0000') && hex.endsWith('7F'));

const base = (path) => path.split('/').pop() || null;
const runtimes = new Set(['node', 'bun', 'deno', 'python', 'python3']);
const processName = (argv) =>
  runtimes.has(base(argv[0])) && argv[1] && !argv[1].startsWith('-') ? base(argv[1]) : base(argv[0]);

function listeners() {
  const sockets = new Map();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of (read(file) ?? '').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '0A' || fields[7] !== uid) continue;
      const [address, portHex] = fields[1].split(':');
      sockets.set(fields[9], { port: parseInt(portHex, 16), loopback: isLoopback(address) });
    }
  }
  const servers = new Map();
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    if (pid === String(process.pid)) continue;
    let fds;
    try { fds = readdirSync('/proc/' + pid + '/fd'); } catch { continue; }
    for (const fd of fds) {
      let target;
      try { target = readlinkSync('/proc/' + pid + '/fd/' + fd); } catch { continue; }
      const socket = sockets.get(target.slice(8, -1));
      if (!target.startsWith('socket:[') || !socket) continue;
      const argv = (read('/proc/' + pid + '/cmdline') ?? '').split('\0').filter(Boolean);
      if (argv.length === 0 || argv.includes(self)) continue;
      const known = servers.get(socket.port);
      if (known && !known.loopback) continue;
      let cwd = null;
      try { cwd = readlinkSync('/proc/' + pid + '/cwd'); } catch {}
      servers.set(socket.port, {
        port: socket.port, loopback: socket.loopback, pid: Number(pid),
        name: processName(argv), cwd, argv,
      });
    }
  }
  return [...servers.values()].sort((a, b) => a.port - b.port);
}

// Harness credentials reach agent-started servers through the environment; they must not be
// persisted where they outlive the harness or end up in a snapshot.
// Client-bundled prefixes are public by definition, so they are kept.
const secretName = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;
const publicName = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_|REACT_APP_|NUXT_PUBLIC_)/;
const parseEnv = (raw) => Object.fromEntries(raw.split('\0').filter(Boolean)
  .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
  .filter(([name]) => publicName.test(name) || !secretName.test(name)));

function loadState() {
  try { return JSON.parse(read(statePath) ?? '[]'); } catch { return []; }
}

// A server must be missing twice before it is forgotten, so a pause that stops everything at
// once does not erase the record the next boot restarts from.
function record(current) {
  const previous = loadState();
  const next = current.map((server) => {
    const old = previous.find((entry) => entry.port === server.port);
    const same = old && old.pid === server.pid;
    let env = same ? old.env : null;
    if (!same) {
      const raw = read('/proc/' + server.pid + '/environ');
      env = raw ? parseEnv(raw) : null;
    }
    return { port: server.port, pid: server.pid, cwd: server.cwd, argv: server.argv, env, missing: 0 };
  });
  for (const old of previous) {
    if (!next.some((entry) => entry.port === old.port) && (old.missing ?? 0) < 1)
      next.push({ ...old, missing: (old.missing ?? 0) + 1 });
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temp = statePath + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
  renameSync(temp, statePath);
}

function detach(argv, cwd, env, log) {
  const out = openSync(log, 'a', 0o600);
  try {
    spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', out, out] }).unref();
  } finally {
    closeSync(out);
  }
}

function watching() {
  const pid = Number(read(lockPath));
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  return (read('/proc/' + pid + '/cmdline') ?? '').includes(self);
}

const command = process.argv[2];
if (command === 'list') {
  const current = listeners();
  record(current);
  process.stdout.write(JSON.stringify(current.map(({ port, loopback, pid, name }) => ({ port, loopback, pid, name }))));
} else if (command === 'watch') {
  if (watching()) process.exit(0);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(lockPath, String(process.pid));
  const tick = () => { try { record(listeners()); } catch {} };
  tick();
  setInterval(tick, 10_000);
} else if (command === 'boot') {
  mkdirSync(stateDir + '/logs', { recursive: true, mode: 0o700 });
  const running = new Set(listeners().map((server) => server.port));
  const state = loadState();
  const launched = new Set();
  for (const entry of state) {
    if (!entry.argv?.length || launched.has(entry.pid)) continue;
    // A server listening on several ports is one process and is started once.
    launched.add(entry.pid);
    if (state.some((other) => other.pid === entry.pid && running.has(other.port))) continue;
    try {
      detach(entry.argv, entry.cwd ?? '/workspace/home', entry.env ?? process.env, stateDir + '/logs/' + entry.port + '.log');
    } catch {}
  }
  if (!watching()) detach([process.execPath, self, 'watch'], '/workspace/home', process.env, '/dev/null');
} else {
  process.exit(2);
}
`;
