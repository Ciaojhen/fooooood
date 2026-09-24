// 本機預覽用的靜態伺服器：npm start 後打開 http://localhost:3000
// App 本身的資料都存在瀏覽器（IndexedDB）裡，這個伺服器只負責提供網頁檔案
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return res.writeHead(403).end();
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`🍳 FooooooD 食譜本預覽：http://localhost:${PORT}`));
