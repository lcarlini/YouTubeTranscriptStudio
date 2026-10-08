import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
mkdirSync(root, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(root, `icon${size}.png`), png(size, draw(size)));
}

function draw(size) {
  const pixels = new Uint8Array(size * size * 4);
  const radius = size * 0.22;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = rounded(x, y, size, radius);
      const offset = (y * size + x) * 4;
      if (!inside) continue;
      let [r, g, b] = [13, 92, 66];
      if (line(x, y, size, 0.34) || line(x, y, size, 0.5) || line(x, y, size, 0.66)) [r, g, b] = [246, 226, 184];
      const dotX = size * 0.74;
      const dotY = size * 0.28;
      if ((x - dotX) ** 2 + (y - dotY) ** 2 < (size * 0.08) ** 2) [r, g, b] = [154, 52, 18];
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function rounded(x, y, size, radius) {
  const inset = (value) => Math.min(Math.max(value, radius), size - radius);
  const dx = x < radius || x > size - radius ? x - inset(x) : 0;
  const dy = y < radius || y > size - radius ? y - inset(y) : 0;
  return dx * dx + dy * dy <= radius * radius && x >= 0 && y >= 0 && x < size && y < size;
}

function line(x, y, size, row) {
  const y0 = Math.round(size * row);
  const thickness = Math.max(1, Math.round(size * 0.055));
  const start = Math.round(size * 0.22);
  const end = Math.round(size * (row === 0.5 ? 0.78 : row === 0.66 ? 0.52 : 0.62));
  return y >= y0 && y < y0 + thickness && x >= start && x <= end;
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, row + 1);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer) {
  let crc = ~0;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc;
}
