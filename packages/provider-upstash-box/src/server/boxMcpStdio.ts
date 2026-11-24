export const boxMcpStdio = String.raw`
import { randomUUID as mcpRandomId } from 'node:crypto';
import { createConnection as mcpConnect, createServer as mcpListen } from 'node:net';

function mcpLines(stream, limit, onLine, onOverflow) {
  let pending = '';
  const onData = chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      if (end > limit) return onOverflow();
      onLine(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
    if (pending.length > limit) onOverflow();
  };
  stream.setEncoding('utf8');
  stream.on('data', onData);
  return () => stream.off('data', onData);
}

if (process.argv[2] === 'mcp') {
  const address = process.argv[3] ?? process.env.T3_BOX_MCP_SOCKET;
  if (!address) process.exit(1);
  const socket = mcpConnect('\0' + address);
  socket.on('error', () => { process.exitCode = 1; });
  socket.on('close', () => process.stdin.pause());
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise(resolve => socket.once('close', resolve));
  process.stdout.write('', () => process.exit());
}

async function startBoxMcp(emit) {
  // Linux abstract sockets leave no filesystem state after the session exits.
  const address = 'crate-' + mcpRandomId();
  const sockets = new Map();
  let next = 0;
  const server = mcpListen(socket => {
    if (sockets.size >= 8) {
      socket.destroy();
      return;
    }
    const client = ++next;
    sockets.set(client, socket);
    socket.on('error', () => socket.destroy());
    const stopReading = mcpLines(socket, 512 * 1024, line => {
      let request;
      try { request = JSON.parse(line); } catch { return; }
      emit('mcp_request', { client, request });
    }, () => socket.destroy());
    socket.once('close', () => {
      sockets.delete(client);
      stopReading();
      emit('mcp_disconnect', { client });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen('\0' + address, resolve);
  });
  const stopAnswers = mcpLines(process.stdin, 8 * 1024 * 1024, line => {
    let answer;
    try { answer = JSON.parse(line); } catch { return; }
    const socket = sockets.get(answer.client);
    if (socket && !socket.destroyed) socket.write(JSON.stringify(answer.response) + '\n');
  }, () => process.stdin.destroy());
  return {
    command: process.execPath,
    args: [process.argv[1], 'mcp', address],
    address,
    close: () => {
      stopAnswers();
      process.stdin.pause();
      for (const socket of sockets.values()) socket.destroy();
      server.close();
    },
  };
}
`;
