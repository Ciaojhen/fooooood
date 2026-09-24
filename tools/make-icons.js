// 產生 App 圖示（純 Node，不需要任何套件）：node tools/make-icons.js
// 圖案：橘色底 + 平底鍋 + 荷包蛋
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const COLORS = {
  bg: [217, 98, 43],
  pan: [43, 36, 32],
  white: [255, 250, 240],
  yolk: [246, 185, 59],
};

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
function inCapsule(x, y, x1, y1, x2, y2, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return inCircle(x, y, x1 + t * dx, y1 + t * dy, r);
}

// 回傳 (x, y) 位置的顏色，座標 0~1；scale < 1 會把圖案往中心縮（給 maskable 圖示留安全邊界）
function colorAt(x, y, scale) {
  x = (x - 0.5) / scale + 0.5;
  y = (y - 0.5) / scale + 0.5;
  if (inCircle(x, y, 0.45, 0.44, 0.075)) return COLORS.yolk;
  if (inCircle(x, y, 0.44, 0.46, 0.15) || inCircle(x, y, 0.52, 0.40, 0.1) || inCircle(x, y, 0.37, 0.38, 0.09))
    return COLORS.white;
  if (inCircle(x, y, 0.44, 0.44, 0.28) || inCapsule(x, y, 0.62, 0.62, 0.83, 0.83, 0.055)) return COLORS.pan;
  return COLORS.bg;
}

function render(size, scale) {
  const SS = 4; // 4x4 超取樣做抗鋸齒
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3); // 每列開頭 1 byte 為 filter type (0)
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, scale);
          sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        }
      for (let i = 0; i < 3; i++) row[1 + px * 3 + i] = Math.round(sum[i] / (SS * SS));
    }
    rows.push(row);
  }
  return encodePng(size, size, Buffer.concat(rows));
}

function encodePng(w, h, raw) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, scale] of [
  ['icon-180.png', 180, 1],
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.78],
]) {
  fs.writeFileSync(path.join(OUT, name), render(size, scale));
  console.log('✓', name);
}
