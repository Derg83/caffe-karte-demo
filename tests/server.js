// Test-Server: liefert die Seiten aus und spielt den Vermittler (wie ntfy.sh) unter /relay nach.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

function start(port = 0) {
  const topics = new Map();   // topic -> { msgs: [], subs: Set<res> }
  const T = name => { if (!topics.has(name)) topics.set(name, { msgs: [], subs: new Set() }); return topics.get(name); };
  let seq = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
    const m = url.pathname.match(/^\/relay\/([A-Za-z0-9_-]+)(\/sse)?$/);
    if (m) {
      const topic = T(m[1]);
      if (req.method === 'POST') {
        let body = ''; req.on('data', d => body += d);
        req.on('end', () => {
          const msg = { id: String(++seq), time: Math.floor(Date.now() / 1000), event: 'message', topic: m[1], message: body };
          topic.msgs.push(msg);
          topic.subs.forEach(s => s.write(`data: ${JSON.stringify(msg)}\n\n`));
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(msg));
        });
        return;
      }
      if (m[2]) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`event: open\ndata: {"event":"open"}\n\n`);
        if (url.searchParams.get('since')) topic.msgs.forEach(msg => res.write(`data: ${JSON.stringify(msg)}\n\n`));
        topic.subs.add(res); req.on('close', () => topic.subs.delete(res));
        return;
      }
    }
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${server.address().port}`,
    // Simuliert einen Ausfall des Vermittlers
    dropAll: () => topics.forEach(t => { t.subs.forEach(s => s.destroy()); t.subs.clear(); }),
    stop: () => { topics.forEach(t => t.subs.forEach(s => s.destroy())); server.close(); }
  })));
}
module.exports = { start };
if (require.main === module) start(+process.argv[2] || 8080).then(s => console.log('Läuft auf', s.url));
