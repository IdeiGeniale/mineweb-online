// ══════════════════════════════════════════════
//  MineWeb Multiplayer Server
//  Node.js · ws library
//  Usage:   node index.js [port]
//  Install: npm install ws
// ══════════════════════════════════════════════

const { WebSocketServer } = require('ws');
const http = require('http');

// Render sets process.env.PORT — fall back to arg or 8080
const PORT = parseInt(process.env.PORT || process.argv[2]) || 8080;
const WRAD = 38;   // must match client WRAD
const SEED = Math.floor(Math.random() * 0xffffff);
const TICK = 50;   // ms between position broadcast

// ── World state ───────────────────────────────
// Stores only blocks that changed during this session
const blockChanges = new Map(); // "x,y,z" -> blockId (number)

// ── Players ───────────────────────────────────
let nextId = 1;
const players = new Map(); // id -> { ws, name, x, y, z, rx, ry, slot, color, id }

const COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#e91e63',
  '#00bcd4','#ff5722','#8bc34a','#ff9800',
];

// ── Helpers ───────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
  }
}

function broadcast(msg, excludeId = null) {
  const str = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id !== excludeId && p.ws.readyState === 1) {
      try { p.ws.send(str); } catch (e) { /* ignore */ }
    }
  }
}

// ── HTTP server ───────────────────────────────
// Serves a JSON status page and handles WebSocket upgrades.
// Also responds to / so Render's health check passes.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify({
    name:    'MineWeb Multiplayer Server',
    version: '1.0.0',
    seed:    SEED,
    wrad:    WRAD,
    players: players.size,
    changes: blockChanges.size,
    uptime:  Math.floor(process.uptime()),
  }, null, 2));
});

const wss = new WebSocketServer({ server: httpServer });

// ── Connection handler ────────────────────────
wss.on('connection', (ws, req) => {
  const id    = nextId++;
  const color = COLORS[(id - 1) % COLORS.length];
  const ip    = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';

  const player = {
    ws, id, color,
    name: `Player${id}`,
    x: 0.5, y: 50, z: 0.5,
    rx: 0,  ry: 0,
    slot: 0,
  };
  players.set(id, player);
  console.log(`[+] ${player.name} connected from ${ip}  (${players.size} online)`);

  // ── Send init to the new player ─────────────
  send(ws, {
    type:    'init',
    id,
    seed:    SEED,
    wrad:    WRAD,
    color,
    name:    player.name,
    // All block changes so the late joiner sees the same world
    changes: Object.fromEntries(blockChanges),
    // All other currently connected players
    players: [...players.values()]
      .filter(p => p.id !== id)
      .map(p => ({
        id:    p.id,
        name:  p.name,
        color: p.color,
        x: p.x, y: p.y, z: p.z,
        rx: p.rx, ry: p.ry,
        slot: p.slot,
      })),
  });

  // ── Tell everyone else about the new player ─
  broadcast({ type: 'playerJoin', id, name: player.name, color, x: player.x, y: player.y, z: player.z }, id);

  // ── Message handler ─────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // Player movement (stored, broadcast on tick)
      case 'move':
        if (typeof msg.x === 'number') player.x = msg.x;
        if (typeof msg.y === 'number') player.y = msg.y;
        if (typeof msg.z === 'number') player.z = msg.z;
        if (typeof msg.rx === 'number') player.rx = msg.rx;
        if (typeof msg.ry === 'number') player.ry = msg.ry;
        if (typeof msg.slot === 'number') player.slot = msg.slot;
        break;

      // Block place / break
      case 'setBlock': {
        const x = parseInt(msg.x), y = parseInt(msg.y), z = parseInt(msg.z);
        const bid = parseInt(msg.id);
        if (isNaN(x) || isNaN(y) || isNaN(z) || isNaN(bid)) break;
        // Bounds check
        if (Math.abs(x) > WRAD || y < 0 || y > 64 || Math.abs(z) > WRAD) break;
        const key = `${x},${y},${z}`;
        if (bid === 0) blockChanges.delete(key);
        else blockChanges.set(key, bid);
        broadcast({ type: 'setBlock', x, y, z, id: bid, by: id }, id);
        break;
      }

      // Chat message
      case 'chat': {
        const text = String(msg.text || '').slice(0, 200).trim();
        if (!text) break;
        const out = { type: 'chat', from: id, name: player.name, color, text };
        broadcast(out); // broadcast to everyone including sender
        console.log(`[chat] ${player.name}: ${text}`);
        break;
      }

      // Player sets their display name
      case 'setName': {
        const name = String(msg.name || '')
          .replace(/[^a-zA-Z0-9_ ]/g, '')
          .slice(0, 20)
          .trim() || player.name;
        const oldName = player.name;
        player.name = name;
        broadcast({ type: 'playerName', id, name }, id);
        if (name !== oldName)
          console.log(`[~] Player${id} is now "${name}"`);
        break;
      }
    }
  });

  // ── Disconnect ──────────────────────────────
  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'playerLeave', id });
    console.log(`[-] ${player.name} disconnected  (${players.size} online)`);
  });

  ws.on('error', (err) => {
    console.warn(`[!] ${player.name} socket error:`, err.message);
  });
});

// ── Position broadcast tick ───────────────────
setInterval(() => {
  if (players.size < 2) return;
  const list = [...players.values()].map(p => ({
    id: p.id, x: p.x, y: p.y, z: p.z, rx: p.rx, ry: p.ry, slot: p.slot,
  }));
  broadcast({ type: 'positions', list });
}, TICK);

// ── Start ─────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  const line = (label, val) => `║  ${label.padEnd(8)}: ${String(val).padEnd(25)}║`;
  console.log([
    '╔══════════════════════════════════════╗',
    '║     MineWeb Multiplayer Server       ║',
    '╠══════════════════════════════════════╣',
    line('Port',  PORT),
    line('Seed',  SEED),
    line('WRAD',  WRAD),
    '╚══════════════════════════════════════╝',
  ].join('\n'));
  console.log(`\nWebSocket : ws://localhost:${PORT}`);
  console.log(`Status    : http://localhost:${PORT}\n`);
});
