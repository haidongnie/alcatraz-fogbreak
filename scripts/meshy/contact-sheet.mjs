import sharp from 'sharp';
import { readdirSync, existsSync } from 'node:fs';
const dir = process.argv[2], out = process.argv[3];
const ids = readdirSync(dir).filter((d) => existsSync(`${dir}/${d}/thumb.png`)).sort();
const S = 200, cols = 7, rows = Math.ceil(ids.length / cols);
const comps = [];
for (let i = 0; i < ids.length; i++) {
  const img = await sharp(`${dir}/${ids[i]}/thumb.png`).resize(S, S).flatten({ background: '#888' }).toBuffer();
  const label = Buffer.from(`<svg width="${S}" height="22"><rect width="100%" height="100%" fill="#000"/><text x="4" y="16" font-size="14" fill="#fff" font-family="sans-serif">${ids[i]}</text></svg>`);
  comps.push({ input: img, left: (i % cols) * S, top: Math.floor(i / cols) * (S + 22) + 22 });
  comps.push({ input: label, left: (i % cols) * S, top: Math.floor(i / cols) * (S + 22) });
}
await sharp({ create: { width: cols * S, height: rows * (S + 22), channels: 3, background: '#222' } }).composite(comps).jpeg({ quality: 80 }).toFile(out);
console.log(ids.length, 'thumbs');
