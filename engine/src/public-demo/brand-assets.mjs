import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { deflateSync, inflateSync } from 'zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const COLOR_RGBA = 6;
const COLOR_RGB = 2;
const COLOR_GRAYSCALE_ALPHA = 4;
const COLOR_GRAYSCALE = 0;
const OFFICIAL_WHITE_SOURCE_SHA256 = 'ef1d734f8b8c68d277f3b80d638ee4cd82fe7e3e747e8c11b82987b879d0420a';

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function bytesPerPixel(colorType) {
  if (colorType === COLOR_RGBA) return 4;
  if (colorType === COLOR_RGB) return 3;
  if (colorType === COLOR_GRAYSCALE_ALPHA) return 2;
  if (colorType === COLOR_GRAYSCALE) return 1;
  throw new Error(`unsupported PNG color type: ${colorType}`);
}

function channelsToRgba(scanline, x, colorType) {
  if (colorType === COLOR_RGBA) {
    const i = x * 4;
    return [scanline[i], scanline[i + 1], scanline[i + 2], scanline[i + 3]];
  }
  if (colorType === COLOR_RGB) {
    const i = x * 3;
    return [scanline[i], scanline[i + 1], scanline[i + 2], 255];
  }
  if (colorType === COLOR_GRAYSCALE_ALPHA) {
    const i = x * 2;
    return [scanline[i], scanline[i], scanline[i], scanline[i + 1]];
  }
  const value = scanline[x];
  return [value, value, value, 255];
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth: ${bitDepth}`);
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('unsupported PNG compression/filter/interlace');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }

  const bpp = bytesPerPixel(colorType);
  const rowBytes = width * bpp;
  const inflated = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  let previous = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const raw = Buffer.from(inflated.subarray(inputOffset, inputOffset + rowBytes));
    inputOffset += rowBytes;
    const row = Buffer.alloc(rowBytes);
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = previous[x] || 0;
      const upLeft = x >= bpp ? previous[x - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unsupported PNG filter: ${filter}`);
      row[x] = (raw[x] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = channelsToRgba(row, x, colorType);
      const out = (y * width + x) * 4;
      rgba[out] = r;
      rgba[out + 1] = g;
      rgba[out + 2] = b;
      rgba[out + 3] = a;
    }
    previous = row;
  }

  return { width, height, data: rgba };
}

export function encodePng(image) {
  const { width, height, data } = image;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = COLOR_RGBA;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    data.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND'),
  ]);
}

function colorDistance(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

function pixelAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

function isBackgroundPixel(image, x, y, bg, tolerance) {
  const px = pixelAt(image, x, y);
  return px[3] === 0 || colorDistance(px, bg) <= tolerance;
}

export function cropUniformBackground(image, options = {}) {
  const tolerance = options.tolerance ?? 10;
  const bg = pixelAt(image, 0, 0);
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!isBackgroundPixel(image, x, y, bg, tolerance)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) throw new Error('logo crop found no foreground pixels');
  const padding = Math.max(0, options.padding ?? 0);
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(image.width - 1, maxX + padding);
  maxY = Math.min(image.height - 1, maxY + padding);

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((minY + y) * image.width + (minX + x)) * 4;
      const target = (y * width + x) * 4;
      image.data.copy(data, target, source, source + 4);
    }
  }
  return { width, height, data, crop: { x: minX, y: minY, width, height } };
}

export function removeUniformBackground(image, options = {}) {
  const tolerance = options.tolerance ?? 10;
  const bg = pixelAt(image, 0, 0);
  const data = Buffer.from(image.data);
  let removed = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (isBackgroundPixel(image, x, y, bg, tolerance)) {
        data[(y * image.width + x) * 4 + 3] = 0;
        removed += 1;
      }
    }
  }
  return { width: image.width, height: image.height, data, removed };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function samplePremultiplied(image, x, y) {
  const source = (y * image.width + x) * 4;
  const alpha = image.data[source + 3] / 255;
  return {
    r: image.data[source] * alpha,
    g: image.data[source + 1] * alpha,
    b: image.data[source + 2] * alpha,
    a: image.data[source + 3],
  };
}

export function resizeBilinearPremultiplied(image, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  if (width === image.width && height === image.height) return { width, height, data: Buffer.from(image.data) };

  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = height === 1 ? 0 : (y * (image.height - 1)) / (height - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const wy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = width === 1 ? 0 : (x * (image.width - 1)) / (width - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const wx = sourceX - x0;
      const p00 = samplePremultiplied(image, x0, y0);
      const p10 = samplePremultiplied(image, x1, y0);
      const p01 = samplePremultiplied(image, x0, y1);
      const p11 = samplePremultiplied(image, x1, y1);
      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;
      const alpha = p00.a * w00 + p10.a * w10 + p01.a * w01 + p11.a * w11;
      const target = (y * width + x) * 4;
      if (alpha <= 0) {
        data[target] = 0;
        data[target + 1] = 0;
        data[target + 2] = 0;
        data[target + 3] = 0;
      } else {
        const unpremultiply = 255 / alpha;
        data[target] = clampByte((p00.r * w00 + p10.r * w10 + p01.r * w01 + p11.r * w11) * unpremultiply);
        data[target + 1] = clampByte((p00.g * w00 + p10.g * w10 + p01.g * w01 + p11.g * w11) * unpremultiply);
        data[target + 2] = clampByte((p00.b * w00 + p10.b * w10 + p01.b * w01 + p11.b * w11) * unpremultiply);
        data[target + 3] = clampByte(alpha);
      }
    }
  }
  return { width, height, data };
}

export function derivePublicDemoBrandAssets(options = {}) {
  const sourcePath = options.sourcePath || 'engine/assets/brand/artifact-logo-final-whitebg.png';
  const sourceBytes = readFileSync(sourcePath);
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  if (sourceHash !== OFFICIAL_WHITE_SOURCE_SHA256) {
    throw new Error(`official white-background logo source hash mismatch: ${sourceHash}`);
  }
  const sourceImage = decodePng(sourceBytes);
  const croppedLight = cropUniformBackground(sourceImage, { tolerance: 12, padding: 8 });
  const transparent = removeUniformBackground(croppedLight, { tolerance: 12 });
  const header = resizeBilinearPremultiplied(transparent, 384);
  const favicon = resizeBilinearPremultiplied(transparent, 64);

  if (transparent.removed <= 0) {
    throw new Error('transparent logo derivation removed no background pixels');
  }

  const assets = {
    'assets/artifact-logo-header.png': encodePng(header),
    'assets/favicon.png': encodePng(favicon),
  };
  const hashes = Object.fromEntries(Object.entries(assets).map(([path, bytes]) => [
    path,
    createHash('sha256').update(bytes).digest('hex'),
  ]));
  return {
    source: {
      path: sourcePath,
      sha256: sourceHash,
      width: sourceImage.width,
      height: sourceImage.height,
    },
    derivation: {
      transparent_background_removed: true,
      crop: croppedLight.crop,
      header: { width: header.width, height: header.height, sha256: hashes['assets/artifact-logo-header.png'] },
      favicon: { width: favicon.width, height: favicon.height, sha256: hashes['assets/favicon.png'] },
    },
    assets,
    hashes,
  };
}