'use strict';

/*
 * Gera favicon.png, apple-touch-icon.png e favicon.ico a partir da MESMA
 * geometria do public/favicon.svg.
 *
 *   node scripts/gerar-favicon.js
 *
 * Por que rasterizar aqui em vez de usar uma ferramenta: o projeto não tem
 * dependência de imagem (nem sharp, nem ImageMagick) e não vale acrescentar uma
 * por um ícone de 32px. São ~40 linhas de PNG puro (zlib + CRC32) e a geometria
 * fica escrita uma vez só, então os três arquivos não podem divergir do SVG.
 *
 * Navegador moderno usa o .svg; o .ico existe para quem pede /favicon.ico direto
 * (e para o Safari antigo), e o apple-touch-icon para o atalho no iOS.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PUBLIC = path.join(__dirname, '..', 'public');

// ── Geometria, em coordenadas de 32x32 (idênticas ao favicon.svg) ──
const LADO = 32;
const RAIO = 7;
const AZUL = [0x0f, 0x62, 0xfe];   // primary
const ROXO = [0x69, 0x29, 0xc4];   // accent
// M9 9 H23 V12.4 L13.8 19.6 H23 V23 H9 V19.6 L18.2 12.4 H9 Z
const Z = [
  [9, 9], [23, 9], [23, 12.4], [13.8, 19.6], [23, 19.6],
  [23, 23], [9, 23], [9, 19.6], [18.2, 12.4], [9, 12.4],
];

const dentroDoZ = (x, y) => {
  let dentro = false;
  for (let i = 0, j = Z.length - 1; i < Z.length; j = i++) {
    const [xi, yi] = Z[i]; const [xj, yj] = Z[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
};

// Quadrado de cantos arredondados: fora do raio nos quatro cantos, dentro no resto.
function dentroDoQuadrado(x, y) {
  const cx = Math.min(Math.max(x, RAIO), LADO - RAIO);
  const cy = Math.min(Math.max(y, RAIO), LADO - RAIO);
  const dx = x - cx; const dy = y - cy;
  return dx * dx + dy * dy <= RAIO * RAIO;
}

/** RGBA de um ponto no espaço 32x32 (a=0 fora do ícone). */
function corEm(x, y) {
  if (!dentroDoQuadrado(x, y)) return [0, 0, 0, 0];
  if (dentroDoZ(x, y)) return [255, 255, 255, 255];
  const t = Math.min(1, Math.max(0, (x + y) / (LADO * 2)));   // gradiente diagonal
  return [
    Math.round(AZUL[0] + (ROXO[0] - AZUL[0]) * t),
    Math.round(AZUL[1] + (ROXO[1] - AZUL[1]) * t),
    Math.round(AZUL[2] + (ROXO[2] - AZUL[2]) * t),
    255,
  ];
}

/** Pixels RGBA de um ícone NxN, com 4x4 de supersampling (senão a diagonal serrilha). */
function pixels(n) {
  const AMOSTRAS = 4;
  const buf = Buffer.alloc(n * n * 4);
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < AMOSTRAS; sy++) {
        for (let sx = 0; sx < AMOSTRAS; sx++) {
          const x = ((px + (sx + 0.5) / AMOSTRAS) / n) * LADO;
          const y = ((py + (sy + 0.5) / AMOSTRAS) / n) * LADO;
          const c = corEm(x, y);
          // Pré-multiplica pelo alfa: sem isso a borda do ícone puxa preto.
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const i = (py * n + px) * 4;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round(a / (AMOSTRAS * AMOSTRAS));
    }
  }
  return buf;
}

/* ── PNG mínimo (RGBA, sem filtro) ───────────────────────────────────────── */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(tipo, dados) {
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(corpo));
  return Buffer.concat([len, corpo, crc]);
}

function png(n) {
  const rgba = pixels(n);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;    // 8 bits por canal
  ihdr[9] = 6;    // RGBA
  // Cada linha vai precedida do byte de filtro (0 = nenhum).
  const linhas = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y++) {
    linhas[y * (n * 4 + 1)] = 0;
    rgba.copy(linhas, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(linhas, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO com um único PNG dentro (aceito desde o Vista/IE11). */
function ico(pngBuf, n) {
  const cab = Buffer.alloc(6);
  cab.writeUInt16LE(0, 0); cab.writeUInt16LE(1, 2); cab.writeUInt16LE(1, 4);
  const dir = Buffer.alloc(16);
  dir[0] = n === 256 ? 0 : n; dir[1] = n === 256 ? 0 : n;
  dir[4] = 1;                       // planos
  dir.writeUInt16LE(32, 6);         // bits por pixel
  dir.writeUInt32LE(pngBuf.length, 8);
  dir.writeUInt32LE(22, 12);        // offset dos dados
  return Buffer.concat([cab, dir, pngBuf]);
}

const p32 = png(32);
fs.writeFileSync(path.join(PUBLIC, 'favicon.png'), p32);
fs.writeFileSync(path.join(PUBLIC, 'favicon.ico'), ico(p32, 32));
fs.writeFileSync(path.join(PUBLIC, 'apple-touch-icon.png'), png(180));
console.log(`favicon.png ${p32.length} B · favicon.ico ${p32.length + 22} B · apple-touch-icon.png gerado`);
