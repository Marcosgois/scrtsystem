'use strict';

/**
 * Leitor mínimo de .xlsx — só o necessário para SCRTs que vêm como planilha:
 * cada aba (worksheet) é lida como uma matriz de linhas/colunas de texto.
 *
 * Um .xlsx é um ZIP de XML. Usa fflate para descompactar e faz o parse do XML
 * "na mão" (sem dependência pesada tipo SheetJS). Cobre células de string
 * compartilhada, inline e valores diretos; posiciona cada célula pela sua
 * referência (A1, B7…) para preservar colunas vazias.
 */

const { unzipSync, strFromU8 } = require('fflate');

/** Detecta a assinatura de ZIP/xlsx ("PK\x03\x04") no início do buffer. */
function isXlsx(buffer) {
  return buffer && buffer.length > 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** "B7" -> 1 (índice de coluna, base 0). */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Todas as ocorrências de uma tag simples (sem aninhamento do mesmo nome). */
function matchAll(xml, re) {
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m);
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // por último, para não redecodificar
}

/** Concatena todos os <t>…</t> de um fragmento (string compartilhada/rica). */
function joinTextNodes(fragment) {
  return matchAll(fragment, /<t[^>]*>([\s\S]*?)<\/t>|<t[^>]*\/>/g)
    .map((m) => (m[1] !== undefined ? decodeEntities(m[1]) : ''))
    .join('');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  // Cada <si>…</si> é uma string (pode ter vários <t> em runs).
  return matchAll(xml, /<si>([\s\S]*?)<\/si>/g).map((m) => joinTextNodes(m[1]));
}

/** Converte um worksheet XML em matriz de linhas (cada linha = array de strings). */
function parseSheet(xml, shared) {
  const rows = [];
  for (const rowM of matchAll(xml, /<row[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g)) {
    const body = rowM[1] || '';
    const cells = [];
    for (const cM of matchAll(body, /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = cM[1] !== undefined ? cM[1] : cM[3];
      const inner = cM[2] !== undefined ? cM[2] : '';
      const ref = (/r="([^"]+)"/.exec(attrs) || [])[1];
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1];
      const idx = ref ? colIndex(ref) : cells.length;

      let value = '';
      if (type === 's') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        value = v !== undefined ? (shared[Number(v)] || '') : '';
      } else if (type === 'inlineStr') {
        value = joinTextNodes(inner);
      } else if (type === 'str') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        value = v !== undefined ? decodeEntities(v) : '';
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        value = v !== undefined ? v : '';
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Lê as abas de um .xlsx.
 * @returns {Array<{name: string, rows: string[][]}>} na ordem do workbook
 */
function readXlsxSheets(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const read = (name) => (files[name] ? strFromU8(files[name]) : null);

  const shared = parseSharedStrings(read('xl/sharedStrings.xml'));

  // Ordem e nomes das abas: xl/workbook.xml; arquivo de cada aba: workbook.xml.rels.
  const workbook = read('xl/workbook.xml') || '';
  const relsXml = read('xl/_rels/workbook.xml.rels') || '';
  const relTarget = {};
  for (const m of matchAll(relsXml, /<Relationship\b([^>]*)\/>/g)) {
    const id = (/Id="([^"]+)"/.exec(m[1]) || [])[1];
    const target = (/Target="([^"]+)"/.exec(m[1]) || [])[1];
    if (id && target) relTarget[id] = target.replace(/^\/?/, '').replace(/^xl\//, '');
  }

  const sheets = [];
  for (const m of matchAll(workbook, /<sheet\b([^>]*)\/>/g)) {
    const name = decodeEntities((/name="([^"]+)"/.exec(m[1]) || [])[1] || '');
    const rid = (/r:id="([^"]+)"/.exec(m[1]) || [])[1];
    let target = relTarget[rid];
    if (!target) continue;
    if (!target.startsWith('xl/')) target = `xl/${target.replace(/^\.\.\//, '')}`;
    const sheetXml = read(target) || read(target.replace(/^xl\//, 'xl/'));
    if (!sheetXml) continue;
    sheets.push({ name, rows: parseSheet(sheetXml, shared) });
  }
  return sheets;
}

/** Serializa uma matriz de linhas em CSV (todos os campos entre aspas duplas). */
function rowsToCsv(rows) {
  return rows
    .map((cells) => cells.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}

module.exports = { isXlsx, readXlsxSheets, rowsToCsv };
