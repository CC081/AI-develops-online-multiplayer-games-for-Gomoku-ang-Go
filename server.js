/* 五子棋 · 围棋 · 局域网/公网联机服务端（零依赖，只需要 Node.js）
 * 启动：node server.js         默认端口 8080
 * 换端口：node server.js 9000
 * 管理后台：http://本机IP:端口/admin   默认密码 admin888（可用环境变量 ADMIN_PWD 改）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const ADMIN_PWD = process.env.ADMIN_PWD || 'admin888';
const ROOT = __dirname;
const HTML_FILE = '五子棋围棋.html';

const clients = new Map();   // token -> { token, name, game, size, rule, queue: [], rid, side, lastSeen, joinedAt }
const waiting = new Map();   // key -> [token]
const rooms = new Map();     // rid -> { id, key, game, size, black, white, moves, createdAt, over }
const logs = [];
const startedAt = Date.now();

function log(msg) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN') + '] ' + msg;
  logs.push(line);
  if (logs.length > 300) logs.shift();
  console.log(line);
}
function gameName(g) { return g === 'go' ? '围棋' : '五子棋'; }

/* ---------------- 工具 ---------------- */
function CORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}
function json(res, obj, code) {
  CORS(res);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise(function (resolve) {
    let raw = '';
    req.on('data', function (c) { raw += c; if (raw.length > 2e5) req.destroy(); });
    req.on('end', function () {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}
function push(token, evt) {
  const c = clients.get(token);
  if (!c) return;
  c.queue.push(evt);
  if (c.queue.length > 200) c.queue.shift();
}
function queueOf(key) {
  if (!waiting.has(key)) waiting.set(key, []);
  return waiting.get(key);
}
function removeFromQueues(token) {
  waiting.forEach(function (arr) {
    const i = arr.indexOf(token);
    if (i >= 0) arr.splice(i, 1);
  });
}
function roomKey(game, size, rule) {
  return game + '|' + size + '|' + (game === 'gomoku' ? rule : '-');
}

/* ---------------- 匹配 ---------------- */
function tryMatch() {
  // 清理掉线等待者
  waiting.forEach(function (arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const c = clients.get(arr[i]);
      if (!c || c.rid || Date.now() - c.lastSeen > 15000) arr.splice(i, 1);
    }
  });
  waiting.forEach(function (arr, key) {
    while (arr.length >= 2) {
      const t1 = arr.shift();
      const t2 = arr.shift();
      if (t1 === t2) continue;
      const c1 = clients.get(t1), c2 = clients.get(t2);
      if (!c1 || !c2) continue;
      const rid = 'R' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const firstIsBlack = Math.random() < 0.5;
      rooms.set(rid, {
        id: rid, key: key, game: c1.game, size: c1.size, rule: c1.rule,
        black: firstIsBlack ? t1 : t2,
        white: firstIsBlack ? t2 : t1,
        moves: [], createdAt: Date.now(), over: false,
        ready: { b: false, w: false }
      });
      c1.rid = rid; c1.side = firstIsBlack ? 'b' : 'w';
      c2.rid = rid; c2.side = firstIsBlack ? 'w' : 'b';
      push(t1, { t: 'matched', rid: rid, side: c1.side, opp: c2.name || '对手', size: c1.size });
      push(t2, { t: 'matched', rid: rid, side: c2.side, opp: c1.name || '对手', size: c1.size });
      log('匹配成功 ' + rid + '：' + gameName(c1.game) + ' · ' + c1.size + ' 路 · ' +
        (c1.name || t1.slice(0, 6)) + '(' + c1.side + ') vs ' + (c2.name || t2.slice(0, 6)) + '(' + c2.side + ')');
    }
  });
}

function leaveRoom(token, reason) {
  const c = clients.get(token);
  if (!c || !c.rid) return;
  const room = rooms.get(c.rid);
  if (room) {
    const other = room.black === token ? room.white : room.black;
    if (other) push(other, { t: 'opponent_left', reason: reason || 'left' });
    room.over = true;
    rooms.delete(c.rid);
    const oc = clients.get(other);
    if (oc && oc.rid === c.rid) { oc.rid = null; oc.side = null; }
  }
  c.rid = null; c.side = null;
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  if (req.method === 'OPTIONS') { CORS(res); res.writeHead(204); res.end(); return; }

  // 首页
  if (p === '/' || p === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(ROOT, HTML_FILE), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('没找到 ' + HTML_FILE + '，请把它和 server.js 放在同一个文件夹。');
    }
    return;
  }

  // 加入匹配
  if (p === '/api/join' && req.method === 'POST') {
    const d = await body(req);
    const game = d.game === 'go' ? 'go' : 'gomoku';
    let size = parseInt(d.size, 10);
    if (game === 'gomoku') size = 15;
    else if (![9, 13, 19].includes(size)) size = 19;
    const rule = d.rule === 'renju' ? 'renju' : 'free';
    const token = crypto.randomBytes(12).toString('hex');
    clients.set(token, {
      token: token, name: String(d.name || '').slice(0, 12), game: game, size: size, rule: rule,
      queue: [], rid: null, side: null, lastSeen: Date.now(), joinedAt: Date.now()
    });
    const key = roomKey(game, size, rule);
    queueOf(key).push(token);
    log('玩家进入匹配 ' + token.slice(0, 6) + '：' + gameName(game) + ' ' + size + ' 路' +
      (game === 'gomoku' ? ' / ' + (rule === 'renju' ? '禁手' : '无禁手') : '') +
      '，当前等待 ' + queueOf(key).length + ' 人');
    tryMatch();
    json(res, { ok: true, token: token, size: size });
    return;
  }

  // 轮询事件
  if (p === '/api/poll') {
    const token = u.searchParams.get('token') || '';
    const after = parseInt(u.searchParams.get('after') || '0', 10);
    const c = clients.get(token);
    if (!c) { json(res, { ok: false, gone: true }); return; }
    c.lastSeen = Date.now();
    const events = c.queue.slice(after);
    json(res, { ok: true, events: events, next: c.queue.length });
    return;
  }

  // 双方进入确认（必须两人都 ready 才允许落子）
  if (p === '/api/ready' && req.method === 'POST') {
    const d = await body(req);
    const c = clients.get(d.token || '');
    if (!c || !c.rid) { json(res, { ok: false, why: 'no-room' }); return; }
    const room = rooms.get(c.rid);
    if (!room) { json(res, { ok: false, why: 'no-room' }); return; }
    if (c.side === 'b' || c.side === 'w') room.ready[c.side] = true;
    const otherSide = c.side === 'b' ? 'w' : 'b';
    const other = room.black === c.token ? room.white : room.black;
    push(other, { t: 'oppReady', side: c.side });
    const both = !!(room.ready.b && room.ready.w);
    if (both) {
      push(room.black, { t: 'bothReady' });
      push(room.white, { t: 'bothReady' });
      log('双方就位 ' + room.id + '：可以开始落子');
    }
    c.lastSeen = Date.now();
    json(res, { ok: true, both: both, oppReady: !!room.ready[otherSide] });
    return;
  }

  // 落子转发
  if (p === '/api/move' && req.method === 'POST') {
    const d = await body(req);
    const c = clients.get(d.token || '');
    if (!c || !c.rid) { json(res, { ok: false, why: 'no-room' }); return; }
    const room = rooms.get(c.rid);
    if (!room) { json(res, { ok: false, why: 'no-room' }); return; }
    if (!room.ready.b || !room.ready.w) { json(res, { ok: false, why: 'not-ready' }); return; }
    const isPass = !!d.pass;
    const mv = { x: isPass ? -1 : (d.x | 0), y: isPass ? -1 : (d.y | 0), pass: isPass };
    if (!isPass && (mv.x < 0 || mv.y < 0 || mv.x >= room.size || mv.y >= room.size)) {
      json(res, { ok: false, why: 'bad-point' }); return;
    }
    room.moves.push(mv);
    const other = room.black === c.token ? room.white : room.black;
    push(other, { t: 'move', x: mv.x, y: mv.y, pass: isPass });
    c.lastSeen = Date.now();
    json(res, { ok: true, n: room.moves.length });
    return;
  }

  // 悔棋 / 认输等对局信号转发
  if (p === '/api/sig' && req.method === 'POST') {
    const d = await body(req);
    const c = clients.get(d.token || '');
    if (!c || !c.rid) { json(res, { ok: false, why: 'no-room' }); return; }
    const room = rooms.get(c.rid);
    if (!room) { json(res, { ok: false, why: 'no-room' }); return; }
    const t = String(d.t || '').slice(0, 16);
    if (!['undoReq', 'undoAcc', 'undoRej', 'resign'].includes(t)) { json(res, { ok: false, why: 'bad-type' }); return; }
    const other = room.black === c.token ? room.white : room.black;
    const ev = { t: t };
    if (t !== 'undoRej' && t !== 'resign') ev.n = Math.max(1, Math.min(2, d.n | 0)) || 1;
    push(other, ev);
    if (t === 'resign' || t === 'undoAcc') room.over = true;
    c.lastSeen = Date.now();
    json(res, { ok: true });
    return;
  }

  // 离开
  if (p === '/api/leave' && req.method === 'POST') {
    const d = await body(req);
    const token = d.token || '';
    const c = clients.get(token);
    if (c) {
      c.lastSeen = Date.now();
      if (!c.rid) removeFromQueues(token);
    }
    leaveRoom(token, d.reason || 'left');
    json(res, { ok: true });
    return;
  }

  // 管理后台页面
  if (p === '/admin') {
    if ((u.searchParams.get('pwd') || '') !== ADMIN_PWD) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>管理后台</title><body style="font-family:system-ui;padding:40px;background:#f6f2e8"><h2>五子棋 · 围棋 · 管理后台</h2><form method="get"><input name="pwd" type="password" placeholder="管理密码" style="padding:8px"><button style="padding:8px 14px">进入</button></form><p style="color:#999;font-size:13px">默认密码 admin888</p></body>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(adminPage());
    return;
  }

  // 管理数据
  if (p === '/api/admin/state') {
    if ((u.searchParams.get('pwd') || '') !== ADMIN_PWD) { json(res, { ok: false, why: 'auth' }, 403); return; }
    const now = Date.now();
    const roomList = [];
    rooms.forEach(function (r) {
      const a = clients.get(r.black), b = clients.get(r.white);
      roomList.push({
        id: r.id, game: gameName(r.game), size: r.size, moves: r.moves.length,
        black: a ? (a.name || a.token.slice(0, 6)) : '(离线)',
        white: b ? (b.name || b.token.slice(0, 6)) : '(离线)',
        mins: Math.floor((now - r.createdAt) / 60000)
      });
    });
    let waitingN = 0;
    waiting.forEach(function (arr) { waitingN += arr.length; });
    json(res, {
      ok: true,
      online: clients.size,
      waiting: waitingN,
      rooms: roomList,
      uptimeMin: Math.floor((now - startedAt) / 60000),
      memMB: Math.round(process.memoryUsage().rss / 1048576),
      logs: logs.slice(-40)
    });
    return;
  }

  // 管理操作
  if (p === '/api/admin/kick' && req.method === 'POST') {
    const d = await body(req);
    if ((d.pwd || '') !== ADMIN_PWD) { json(res, { ok: false, why: 'auth' }, 403); return; }
    const room = rooms.get(d.rid);
    if (room) {
      push(room.black, { t: 'kicked' });
      push(room.white, { t: 'kicked' });
      room.over = true;
      rooms.delete(room.id);
      log('管理员强制解散房间 ' + d.rid);
    }
    json(res, { ok: true });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

/* ---------------- 管理后台页面 ---------------- */
function adminPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>五子棋 · 围棋 · 管理后台</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f6f2e8;color:#2a2118}
.wrap{max-width:960px;margin:0 auto;padding:22px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8b8377;font-size:12px;margin-bottom:18px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.card{background:#fff;border:1px solid #e2d9c6;border-radius:8px;padding:12px}
.card .k{font-size:11px;color:#8b8377}
.card .v{font-size:22px;font-weight:700;margin-top:4px}
.sec{background:#fff;border:1px solid #e2d9c6;border-radius:8px;padding:14px;margin-bottom:14px}
.sec h2{font-size:14px;margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #f0ebe0}
th{color:#8b8377;font-weight:600;font-size:11.5px}
button{padding:5px 11px;border:1px solid #c9b58e;background:#fff;border-radius:5px;cursor:pointer;font-family:inherit;font-size:12px}
button:hover{background:#f3ecdd}
.log{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.7;max-height:240px;overflow:auto;color:#514a3f;background:#fbf8f1;border-radius:6px;padding:10px}
.empty{color:#b4ada1;font-size:12.5px;padding:10px 0}
</style>
<div class="wrap">
  <h1>五子棋 · 围棋 · 管理后台</h1>
  <div class="sub">服务状态每 2 秒自动刷新 · 端口 <span id="port"></span></div>
  <div class="cards">
    <div class="card"><div class="k">在线连接</div><div class="v" id="cOnline">-</div></div>
    <div class="card"><div class="k">等待匹配</div><div class="v" id="cWait">-</div></div>
    <div class="card"><div class="k">进行中对局</div><div class="v" id="cRooms">-</div></div>
    <div class="card"><div class="k">内存占用</div><div class="v" id="cMem">-</div></div>
  </div>
  <div class="sec">
    <h2>对局列表</h2>
    <div id="roomBox"><div class="empty">暂无对局</div></div>
  </div>
  <div class="sec">
    <h2>服务日志</h2>
    <div class="log" id="logBox">-</div>
  </div>
</div>
<script>
const PWD=new URLSearchParams(location.search).get('pwd')||'';
document.getElementById('port').textContent=location.host;
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function tick(){
  try{
    const r=await fetch('/api/admin/state?pwd='+encodeURIComponent(PWD));
    const d=await r.json();
    if(!d.ok){document.body.innerHTML='<p style="padding:40px">会话失效，请重新进入。</p>';return;}
    document.getElementById('cOnline').textContent=d.online;
    document.getElementById('cWait').textContent=d.waiting;
    document.getElementById('cRooms').textContent=d.rooms.length;
    document.getElementById('cMem').textContent=d.memMB+' MB';
    const box=document.getElementById('roomBox');
    if(!d.rooms.length){box.innerHTML='<div class="empty">暂无进行中的对局</div>';}
    else{
      box.innerHTML='<table><tr><th>房间</th><th>棋种</th><th>盘</th><th>黑方</th><th>白方</th><th>手数</th><th>已进行</th><th></th></tr>'+
        d.rooms.map(x=>'<tr><td>'+esc(x.id)+'</td><td>'+esc(x.game)+'</td><td>'+x.size+' 路</td><td>'+esc(x.black)+'</td><td>'+esc(x.white)+'</td><td>'+x.moves+'</td><td>'+x.mins+' 分钟</td><td><button data-rid="'+esc(x.id)+'" class="kick">解散</button></td></tr>').join('')+'</table>';
      box.querySelectorAll('.kick').forEach(b=>b.onclick=async()=>{
        if(!confirm('确定解散房间 '+b.dataset.rid+'？双方都会收到提示。'))return;
        await fetch('/api/admin/kick',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pwd:PWD,rid:b.dataset.rid})});
        tick();
      });
    }
    document.getElementById('logBox').innerHTML=d.logs.map(esc).join('<br>')||'（暂无日志）';
    const lb=document.getElementById('logBox');lb.scrollTop=lb.scrollHeight;
  }catch(e){}
}
tick();setInterval(tick,2000);
</script></html>`;
}

server.listen(PORT, '0.0.0.0', function () {
  const ifs = os.networkInterfaces();
  const ips = [];
  Object.keys(ifs).forEach(function (k) {
    (ifs[k] || []).forEach(function (i) { if (i.family === 'IPv4' && !i.internal) ips.push(i.address); });
  });
  log('服务已启动，端口 ' + PORT);
  console.log('');
  console.log('  五子棋 · 围棋 联机服务已启动');
  console.log('  ────────────────────────────');
  console.log('  本机访问：   http://localhost:' + PORT);
  ips.forEach(function (ip) { console.log('  同机房访问： http://' + ip + ':' + PORT + '   ← 让别人打开这个'); });
  console.log('  管理后台：   http://' + (ips[0] || 'localhost') + ':' + PORT + '/admin');
  console.log('  管理密码：   ' + ADMIN_PWD);
  console.log('');
});

// 每 5 秒清扫：等待队列里掉线的人、5 分钟没动静的连接
setInterval(function () {
  const now = Date.now();
  waiting.forEach(function (arr, key) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const c = clients.get(arr[i]);
      if (!c || c.rid || now - c.lastSeen > 15000) {
        if (c) log('清理等待队列中的掉线玩家 ' + arr[i].slice(0, 6));
        arr.splice(i, 1);
      }
    }
  });
  clients.forEach(function (c, token) {
    if (now - c.lastSeen > 5 * 60000) {
      leaveRoom(token, 'timeout');
      removeFromQueues(token);
      clients.delete(token);
      log('回收超时连接 ' + token.slice(0, 6));
    }
  });
}, 5000);
