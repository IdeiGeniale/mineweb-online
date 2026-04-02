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
  // JSON API endpoint
  if (req.url === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      name: 'MineWeb Multiplayer Server', version: '1.0.0',
      seed: SEED, wrad: WRAD,
      players: players.size,
      playerList: [...players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) })),
      changes: blockChanges.size,
      uptime: Math.floor(process.uptime()),
      saveFile: SAVE_FILE,
    }, null, 2));
  }

  // HTML dashboard
  const uptimeSec = Math.floor(process.uptime());
  const h = Math.floor(uptimeSec / 3600), m = Math.floor((uptimeSec % 3600) / 60), s = uptimeSec % 60;
  const uptimeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

  const playerRows = [...players.values()].map(p => `
    <tr>
      <td><span class="dot" style="background:${p.color}"></span>${p.name}</td>
      <td>${p.id}</td>
      <td>${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}</td>
      <td><span class="badge online">Online</span></td>
    </tr>`).join('') || `<tr><td colspan="4" class="empty">No players online</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>MineWeb Server Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f0f12;color:#e8e4d8;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;padding:24px 16px}
  h1{font-size:22px;font-weight:800;color:#5cb85c;letter-spacing:1px;margin-bottom:2px}
  .sub{font-size:13px;color:#555;margin-bottom:28px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
  .card{background:#1a1a1e;border:1px solid #2a2a30;border-radius:10px;padding:18px 20px}
  .card-label{font-size:11px;font-weight:700;letter-spacing:2px;color:#555;text-transform:uppercase;margin-bottom:8px}
  .card-value{font-size:28px;font-weight:800;color:#fff}
  .card-value.green{color:#5cb85c}
  .card-value.amber{color:#f0a030}
  .card-value.mono{font-family:monospace;font-size:22px}
  .section{background:#1a1a1e;border:1px solid #2a2a30;border-radius:10px;overflow:hidden;margin-bottom:16px}
  .section-head{padding:14px 20px;border-bottom:1px solid #2a2a30;font-size:13px;font-weight:800;letter-spacing:1px;color:#aaa;text-transform:uppercase}
  table{width:100%;border-collapse:collapse}
  td,th{padding:11px 20px;text-align:left;font-size:14px;border-bottom:1px solid #1f1f24}
  th{font-size:11px;font-weight:700;letter-spacing:1px;color:#555;text-transform:uppercase;background:#141416}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#1f1f24}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle;flex-shrink:0}
  .badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:800;letter-spacing:1px}
  .badge.online{background:rgba(92,184,92,.15);color:#5cb85c;border:1px solid rgba(92,184,92,.3)}
  .empty{color:#444;text-align:center;padding:24px;font-size:13px}
  .footer{font-size:12px;color:#333;text-align:center;margin-top:20px}
  .refresh{font-size:11px;color:#333;text-align:right;margin-bottom:8px}
  @media(max-width:500px){td,th{padding:9px 12px}.card-value{font-size:22px}}
</style>
</head>
<body>
<h1>⛏ MineWeb Server</h1>
<div class="sub">Dashboard — auto-refreshes every 5 seconds</div>
<div class="refresh">Last updated: ${new Date().toUTCString()}</div>

<div class="grid">
  <div class="card">
    <div class="card-label">Players Online</div>
    <div class="card-value green">${players.size}</div>
  </div>
  <div class="card">
    <div class="card-label">Uptime</div>
    <div class="card-value mono">${uptimeStr}</div>
  </div>
  <div class="card">
    <div class="card-label">World Seed</div>
    <div class="card-value amber mono">${SEED}</div>
  </div>
  <div class="card">
    <div class="card-label">Block Changes</div>
    <div class="card-value">${blockChanges.size.toLocaleString()}</div>
  </div>
  <div class="card">
    <div class="card-label">World Radius</div>
    <div class="card-value">${WRAD}</div>
  </div>
  <div class="card">
    <div class="card-label">Save File</div>
    <div class="card-value mono" style="font-size:13px;padding-top:6px">${path.basename(SAVE_FILE)}</div>
  </div>
</div>

<div class="section">
  <div class="section-head">Connected Players</div>
  <table>
    <thead><tr><th>Name</th><th>ID</th><th>Position</th><th>Status</th></tr></thead>
    <tbody>${playerRows}</tbody>
  </table>
</div>

<div class="footer">MineWeb Multiplayer Server v1.0.0 &nbsp;·&nbsp; <a href="/api" style="color:#444">JSON API</a></div>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
  res.end(html);
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
