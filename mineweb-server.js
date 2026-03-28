// ══════════════════════════════════════════════
//  MineWeb Multiplayer Server
//  Node.js · ws library
//  Usage: node mineweb-server.js [port]
//  Install: npm install ws
// ══════════════════════════════════════════════

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT   = parseInt(process.argv[2]) || 8080;
const WRAD   = 38;   // must match client WRAD
const SEED   = Math.floor(Math.random() * 0xffffff);
const TICK   = 50;   // ms between broadcast ticks

// ── World state ───────────────────────────────
// Only stores blocks that differ from the generated world
// (block changes made during the session)
const blockChanges = new Map(); // "x,y,z" -> id

// ── Players ───────────────────────────────────
let nextId = 1;
const players = new Map(); // id -> { ws, name, x, y, z, rx, ry, slot, color }

const COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#e91e63',
];

// ── HTTP server (serves a status page + CORS) ─
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({
    name: 'MineWeb Server',
    seed: SEED,
    players: players.size,
    wrad: WRAD,
    changes: blockChanges.size,
  }));
});

const wss = new WebSocketServer({ server: httpServer });

// ── Message helpers ───────────────────────────
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg, excludeId = null) {
  for (const [id, p] of players) {
    if (id !== excludeId) send(p.ws, msg);
  }
}

// ── On connection ─────────────────────────────
wss.on('connection', (ws) => {
  const id = nextId++;
  const color = COLORS[(id - 1) % COLORS.length];

  const player = { ws, name: `Player${id}`, x: 0.5, y: 50, z: 0.5, rx: 0, ry: 0, slot: 0, color, id };
  players.set(id, player);

  console.log(`[+] ${player.name} connected  (${players.size} online)`);

  // Send init packet: id, seed, all existing block changes, all current players
  send(ws, {
    type: 'init',
    id,
    seed: SEED,
    wrad: WRAD,
    color,
    name: player.name,
    changes: Object.fromEntries(blockChanges),
    players: [...players.values()]
      .filter(p => p.id !== id)
      .map(p => ({ id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, rx: p.rx, ry: p.ry, slot: p.slot })),
  });

  // Tell everyone else about this new player
  broadcast({ type: 'playerJoin', id, name: player.name, color, x: player.x, y: player.y, z: player.z }, id);

  // ── Incoming messages ───────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'move':
        player.x  = msg.x;  player.y  = msg.y;  player.z  = msg.z;
        player.rx = msg.rx; player.ry = msg.ry;
        player.slot = msg.slot ?? player.slot;
        // Will be broadcast in tick
        break;

      case 'setBlock': {
        const key = `${msg.x},${msg.y},${msg.z}`;
        if (msg.id === 0) blockChanges.delete(key);
        else blockChanges.set(key, msg.id);
        broadcast({ type: 'setBlock', x: msg.x, y: msg.y, z: msg.z, id: msg.id, by: id }, id);
        break;
      }

      case 'chat': {
        const text = String(msg.text || '').slice(0, 200);
        const out = { type: 'chat', from: id, name: player.name, color, text };
        broadcast(out);
        send(ws, out); // echo back to sender too
        console.log(`[chat] ${player.name}: ${text}`);
        break;
      }

      case 'setName': {
        const name = String(msg.name || '').replace(/[^a-zA-Z0-9_ ]/g,'').slice(0, 20) || player.name;
        player.name = name;
        broadcast({ type: 'playerName', id, name }, id);
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

  ws.on('error', () => {});
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
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║     MineWeb Multiplayer Server       ║
╠══════════════════════════════════════╣
║  Port   : ${String(PORT).padEnd(27)}║
║  Seed   : ${String(SEED).padEnd(27)}║
║  WRAD   : ${String(WRAD).padEnd(27)}║
╚══════════════════════════════════════╝
  `);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`Status:    http://localhost:${PORT}\n`);
});
