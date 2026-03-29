// ══════════════════════════════════════════════
//  MineWeb Multiplayer Server
//  Node.js · ws library
//  Usage:   node index.js [port]
//  Install: npm install ws
// ══════════════════════════════════════════════

const { WebSocketServer } = require('ws');
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = parseInt(process.env.PORT || process.argv[2]) || 8080;
const WRAD      = 38;
const TICK      = 50;
const SAVE_FILE = path.resolve('world.json');
const SAVE_DEBOUNCE = 2000;

// ── World persistence ─────────────────────────
let SEED;
let _saveTimer = null;
const blockChanges = new Map();

function loadWorld() {
  if (fs.existsSync(SAVE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
      SEED = typeof data.seed === 'number' ? data.seed : Math.floor(Math.random() * 0xffffff);
      for (const [k, v] of Object.entries(data.changes || {}))
        blockChanges.set(k, parseInt(v));
      console.log(`[world] Loaded "${SAVE_FILE}"  seed=${SEED}  changes=${blockChanges.size}`);
      return;
    } catch (e) {
      console.warn(`[world] Failed to load save file: ${e.message} — starting fresh`);
    }
  }
  SEED = Math.floor(Math.random() * 0xffffff);
  console.log(`[world] No save file found — new world  seed=${SEED}`);
}

function saveWorld() {
  try {
    fs.writeFileSync(SAVE_FILE, JSON.stringify({
      seed:    SEED,
      wrad:    WRAD,
      changes: Object.fromEntries(blockChanges),
      savedAt: new Date().toISOString(),
    }));
    console.log(`[world] Saved  changes=${blockChanges.size}`);
  } catch (e) {
    console.error(`[world] Save failed: ${e.message}`);
  }
}

function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveWorld, SAVE_DEBOUNCE);
}

function onShutdown(signal) {
  console.log(`\n[server] ${signal} — saving world…`);
  clearTimeout(_saveTimer);
  saveWorld();
  process.exit(0);
}
process.on('SIGINT',  () => onShutdown('SIGINT'));
process.on('SIGTERM', () => onShutdown('SIGTERM'));

loadWorld();

// ── Players ───────────────────────────────────
let nextId = 1;
const players = new Map();
const COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12',
  '#9b59b6','#1abc9c','#e67e22','#e91e63',
  '#00bcd4','#ff5722','#8bc34a','#ff9800',
];

// ── Helpers ───────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === 1)
    try { ws.send(JSON.stringify(msg)); } catch (e) {}
}
function broadcast(msg, excludeId = null) {
  const str = JSON.stringify(msg);
  for (const [id, p] of players)
    if (id !== excludeId && p.ws.readyState === 1)
      try { p.ws.send(str); } catch (e) {}
}

// ── HTTP status page ──────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    name: 'MineWeb Multiplayer Server', version: '1.0.0',
    seed: SEED, wrad: WRAD, players: players.size,
    changes: blockChanges.size, uptime: Math.floor(process.uptime()),
    saveFile: SAVE_FILE,
  }, null, 2));
});

const wss = new WebSocketServer({ server: httpServer });

// ── Connection handler ────────────────────────
wss.on('connection', (ws, req) => {
  const id    = nextId++;
  const color = COLORS[(id - 1) % COLORS.length];
  const ip    = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  const player = { ws, id, color, name: `Player${id}`, x: 0.5, y: 50, z: 0.5, rx: 0, ry: 0, slot: 0 };
  players.set(id, player);
  console.log(`[+] ${player.name} connected from ${ip}  (${players.size} online)`);

  send(ws, {
    type: 'init', id, seed: SEED, wrad: WRAD, color, name: player.name,
    changes: Object.fromEntries(blockChanges),
    players: [...players.values()].filter(p => p.id !== id)
      .map(p => ({ id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, rx: p.rx, ry: p.ry, slot: p.slot })),
  });
  broadcast({ type: 'playerJoin', id, name: player.name, color, x: player.x, y: player.y, z: player.z }, id);

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'move':
        if (typeof msg.x  === 'number') player.x  = msg.x;
        if (typeof msg.y  === 'number') player.y  = msg.y;
        if (typeof msg.z  === 'number') player.z  = msg.z;
        if (typeof msg.rx === 'number') player.rx = msg.rx;
        if (typeof msg.ry === 'number') player.ry = msg.ry;
        if (typeof msg.slot === 'number') player.slot = msg.slot;
        break;
      case 'setBlock': {
        const x = parseInt(msg.x), y = parseInt(msg.y), z = parseInt(msg.z), bid = parseInt(msg.id);
        if (isNaN(x)||isNaN(y)||isNaN(z)||isNaN(bid)) break;
        if (Math.abs(x) > WRAD || y < 0 || y > 64 || Math.abs(z) > WRAD) break;
        const key = `${x},${y},${z}`;
        if (bid === 0) blockChanges.delete(key); else blockChanges.set(key, bid);
        broadcast({ type: 'setBlock', x, y, z, id: bid, by: id }, id);
        scheduleSave();
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 200).trim();
        if (!text) break;
        const out = { type: 'chat', from: id, name: player.name, color, text };
        broadcast(out);
        console.log(`[chat] ${player.name}: ${text}`);
        break;
      }
      case 'setName': {
        const name = String(msg.name || '').replace(/[^a-zA-Z0-9_ ]/g,'').slice(0,20).trim() || player.name;
        const old = player.name; player.name = name;
        broadcast({ type: 'playerName', id, name }, id);
        if (name !== old) console.log(`[~] Player${id} is now "${name}"`);
        break;
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'playerLeave', id });
    console.log(`[-] ${player.name} disconnected  (${players.size} online)`);
  });
  ws.on('error', (err) => console.warn(`[!] ${player.name}:`, err.message));
});

// ── Position tick ─────────────────────────────
setInterval(() => {
  if (players.size < 2) return;
  broadcast({ type: 'positions', list: [...players.values()].map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, rx: p.rx, ry: p.ry, slot: p.slot })) });
}, TICK);

// ── Start ─────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  const ln = (l, v) => `║  ${l.padEnd(8)}: ${String(v).padEnd(25)}║`;
  console.log(['╔══════════════════════════════════════╗','║     MineWeb Multiplayer Server       ║','╠══════════════════════════════════════╣',
    ln('Port',PORT), ln('Seed',SEED), ln('WRAD',WRAD), ln('Save',SAVE_FILE),
    '╚══════════════════════════════════════╝'].join('\n'));
  console.log(`\nWebSocket : ws://localhost:${PORT}\nStatus    : http://localhost:${PORT}\n`);
});
