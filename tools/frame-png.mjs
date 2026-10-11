import { deflateSync } from "node:zlib";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const header = Buffer.alloc(4), trailer = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  trailer.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, trailer]);
}

export function framePng({ width, height, pixels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 4096 || height > 4096 || pixels.length !== width * height * 4) {
    throw new RangeError("Invalid RGBA frame");
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
