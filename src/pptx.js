'use strict';

/*
 * Escritor mínimo de .pptx (OOXML PresentationML).
 *
 * Um .pptx é um ZIP de partes XML; a fflate — já usada para LER .xlsx de SCRT —
 * fecha o pacote. Zero dependência nova.
 *
 * A API é de PRIMITIVAS DE DESENHO em pontos (o slide 16:9 tem 960×540 pt), não
 * de placeholders de layout do PowerPoint. O deck é gerado para ser apresentado,
 * não para ser editado a partir de um template: layouts com placeholder só
 * criariam caixas vazias que aparecem no slide se ninguém preencher.
 *
 * O gráfico entra como POLILINHA VETORIAL (a:custGeom), não como imagem: o
 * cliente pode dar zoom no slide sem serrilhado e o servidor não precisa de
 * canvas nem de receber PNG do navegador (o que obrigaria a exportação a ser um
 * POST — e POST em /clients/:id/... exige permissão de EDIÇÃO no guard, quando
 * gerar uma apresentação é leitura).
 *
 * Primitivas aceitas em `slide.shapes` (coordenadas em pt, origem no canto
 * superior esquerdo):
 *
 *   { t:'rect',  x,y,w,h, fill?, alpha?, line?, lineW?, text|lines[]?, … }
 *   { t:'line',  x1,y1,x2,y2, color?, w?, dash? }
 *   { t:'text',  x,y,w,h, text|lines[], size?, bold?, color?, align?, valign?,
 *                padX?, padY?, vert? ('vert270' escreve de baixo para cima) }
 *   { t:'poly',  pts:[[x,y]…], color?, w?, dash?, close?, fill?, fillAlpha? }
 *   { t:'table', x,y, cols:[larguras], rows:[[célula…]], rowH?, headH?, headRows? }
 *
 * Parágrafo (em `lines[]`): { text, size?, bold?, color?, align?, spaceBefore?,
 * lineHeight?, bullet? }.
 *
 * Célula de tabela: string, ou { text|lines[], bold?, color?, align?, fill?,
 * size?, padX?, borderBottom? }.
 *
 * `rect` com texto é a barra de gráfico com o valor dentro — uma forma só, o
 * rótulo anda junto se alguém mexer no slide. Como o PowerPoint NÃO recorta
 * texto que não cabe, use `larguraTexto`/`tamanhoQueCabe` antes de decidir onde
 * o número vai: transbordar aqui é silencioso.
 */

const { zipSync, strToU8 } = require('fflate');

const EMU_POR_PT = 12700;
const LARGURA_PT = 960;
const ALTURA_PT = 540;
const FONTE = 'Arial'; // presente no Windows, no macOS e no Office Online

/* Valor não finito vira 0, e não "NaN".
   Math.round(NaN * 12700) é NaN, e o atributo sairia literalmente y="NaN" — que
   não é um ST_Coordinate. O PowerPoint então recusa o SLIDE INTEIRO com "o
   PowerPoint encontrou um problema com o conteúdo", sem dizer qual forma. Como
   isto é o único ponto por onde toda coordenada passa, o piso fica aqui: um
   retângulo no canto é um defeito que se vê; um pacote inválido, não. */
const emu = (pt) => (Number.isFinite(pt) ? Math.round(pt * EMU_POR_PT) : 0);
const cem = (pt) => (Number.isFinite(pt) ? Math.round(pt * 100) : 0); // sz / spcPts são centésimos de ponto

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Caracteres de controle são ilegais em XML 1.0 e derrubam o PowerPoint com
    // "conteúdo não pode ser lido" — sem erro que diga onde.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

const cor = (hex) => String(hex || '000000').replace('#', '').toUpperCase();

function solidFill(hex, alpha) {
  const a = alpha === undefined || alpha === null || alpha >= 1
    ? ''
    : `<a:alpha val="${Math.round(alpha * 100000)}"/>`;
  return `<a:solidFill><a:srgbClr val="${cor(hex)}">${a}</a:srgbClr></a:solidFill>`;
}

function traco(o) {
  if (!o || !o.color) return '<a:ln><a:noFill/></a:ln>';
  const w = emu(o.w === undefined ? 1 : o.w);
  const dash = o.dash ? `<a:prstDash val="${esc(o.dash)}"/>` : '<a:prstDash val="solid"/>';
  return `<a:ln w="${w}" cap="rnd">${solidFill(o.color)}${dash}<a:round/></a:ln>`;
}

function xfrm(x, y, w, h, flip) {
  const f = `${flip && flip.h ? ' flipH="1"' : ''}${flip && flip.v ? ' flipV="1"' : ''}`;
  return `<a:xfrm${f}><a:off x="${emu(x)}" y="${emu(y)}"/>`
    + `<a:ext cx="${Math.max(1, emu(w))}" cy="${Math.max(1, emu(h))}"/></a:xfrm>`;
}

/* ── Texto ──────────────────────────────────────────────────────────────── */

const ALINHA = { left: 'l', center: 'ctr', right: 'r' };
const ANCORA = { top: 't', middle: 'ctr', bottom: 'b' };

function paragrafo(l, padrao) {
  const size = l.size || padrao.size || 14;
  const algn = ALINHA[l.align || padrao.align || 'left'] || 'l';
  const antes = l.spaceBefore ? `<a:spcBef><a:spcPts val="${cem(l.spaceBefore)}"/></a:spcBef>` : '';
  const entrelinha = l.lineHeight ? `<a:lnSpc><a:spcPct val="${Math.round(l.lineHeight * 100000)}"/></a:lnSpc>` : '';
  /* Marcador de verdade (buChar) em vez de "• " digitado no texto: assim a
     segunda linha de um item longo alinha sob o texto, não sob a bolinha. */
  const recuo = l.bullet ? emu(16) : 0;
  const marcador = l.bullet
    ? `<a:buFont typeface="${FONTE}"/><a:buChar char="•"/>`
    : '';
  const rPr = `<a:rPr lang="pt-BR" sz="${cem(size)}" b="${(l.bold ?? padrao.bold) ? 1 : 0}" dirty="0">`
    + solidFill(l.color || padrao.color || '161616')
    + `<a:latin typeface="${FONTE}"/><a:cs typeface="${FONTE}"/></a:rPr>`;
  const corpo = String(l.text || '') === ''
    ? `<a:endParaRPr lang="pt-BR" sz="${cem(size)}"/>`
    : `<a:r>${rPr}<a:t>${esc(l.text)}</a:t></a:r>`;
  const pPr = l.bullet
    ? `<a:pPr marL="${recuo}" indent="-${recuo}" algn="${algn}">${entrelinha}${antes}${marcador}</a:pPr>`
    : `<a:pPr algn="${algn}">${entrelinha}${antes}</a:pPr>`;
  return `<a:p>${pPr}${corpo}</a:p>`;
}

/* Texto na vertical: `vert270` sobe da base para o topo (o rótulo dentro de uma
   barra estreita), `vert` desce. É o bodyPr que gira o TEXTO — girar a forma
   (xfrm rot) mexeria também na posição, porque a rotação é em torno do centro. */
const VERTICAL = { vert270: 'vert270', vert: 'vert', up: 'vert270', down: 'vert' };

const temTexto = (o) => Boolean(String(o.text || '') !== '' || (o.lines && o.lines.length));

/* O corpo de texto de uma FORMA é <p:txBody>; o de uma CÉLULA de tabela é
   <a:txBody> — mesmo conteúdo, prefixo diferente. */
function txBody(o, { vazio = false, ns = 'p' } = {}) {
  const anchor = ANCORA[o.valign || 'top'] || 't';
  const vert = VERTICAL[o.vert] ? ` vert="${VERTICAL[o.vert]}"` : '';
  const bodyPr = `<a:bodyPr wrap="square" lIns="${emu(o.padX || 0)}" tIns="${emu(o.padY || 0)}"`
    + ` rIns="${emu(o.padX || 0)}" bIns="${emu(o.padY || 0)}"${vert}`
    + ` anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>`;
  const conteudo = vazio ? '<a:p/>' : (o.lines || [{ text: o.text }]).map((l) => paragrafo(l, o)).join('');
  return `<${ns}:txBody>${bodyPr}${conteudo}</${ns}:txBody>`;
}

/* ── Medição de texto ────────────────────────────────────────────────────── */

/*
 * Larguras de avanço da Arial, em milésimos de em. Só os caracteres que aparecem
 * em número, data e rótulo curto — o resto cai no padrão.
 *
 * Existe porque o PowerPoint NÃO recorta texto que não cabe (`<a:noAutofit/>`):
 * um rótulo maior que a barra transborda por cima do vizinho, em silêncio. Com a
 * medida na mão, o deck decide entre pôr o número dentro ou fora da barra, e
 * encolhe a fonte da tabela até caber em vez de estourar a coluna.
 */
const AVANCO = {
  ' ': 278, '.': 278, ',': 278, ':': 278, ';': 278, '!': 278, '|': 260, "'": 191, '"': 355,
  '(': 333, ')': 333, '[': 278, ']': 278, '-': 333, '–': 556, '—': 1000, '/': 278, '\\': 278,
  '%': 889, '+': 584, '=': 584, '×': 584, '·': 278, '*': 389, '$': 556, '&': 667, '#': 556, '@': 1015,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222,
  m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500,
  y: 500, z: 500,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556,
  M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667,
  Y: 667, Z: 611,
};
const AVANCO_DIGITO = 556;   // todos os dígitos da Arial têm a mesma largura
const AVANCO_PADRAO = 556;

/**
 * Largura aproximada de um texto, em pontos. Exata para números (dígito, ponto,
 * vírgula e sinal têm largura fixa na Arial); aproximada para o resto.
 */
function larguraTexto(txt, size, { bold = false } = {}) {
  let mil = 0;
  for (const ch of String(txt || '')) {
    if (ch >= '0' && ch <= '9') mil += AVANCO_DIGITO;
    else mil += AVANCO[ch] !== undefined ? AVANCO[ch] : AVANCO_PADRAO;
  }
  // A Arial Bold é ~6% mais larga que a regular nos mesmos caracteres.
  return (mil / 1000) * Number(size || 12) * (bold ? 1.06 : 1);
}

/**
 * O maior tamanho de fonte (partindo de `size`) em que o texto cabe na largura
 * dada. Nunca desce do piso — texto ilegível não é solução para texto que estoura.
 */
function tamanhoQueCabe(txt, size, largura, { bold = false, piso = 6 } = {}) {
  let s = Number(size);
  while (s > piso && larguraTexto(txt, s, { bold }) > largura) s -= 0.25;
  return Math.max(piso, s);
}

/* ── Formas ─────────────────────────────────────────────────────────────── */

function spTexto(id, o) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Texto ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(o.x, o.y, o.w, o.h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + txBody(o)
    + '</p:sp>';
}

/* Retângulo — e, quando tem texto, a barra do gráfico com o valor DENTRO dela.
   Uma forma só: o rótulo acompanha a barra se alguém mexer no slide depois. */
function spRect(id, o) {
  const fill = o.fill ? solidFill(o.fill, o.alpha) : '<a:noFill/>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Retângulo ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(o.x, o.y, o.w, o.h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + fill + traco(o.line ? { color: o.line, w: o.lineW } : null) + '</p:spPr>'
    + txBody(o, { vazio: !temTexto(o) })
    + '</p:sp>';
}

function spLinha(id, o) {
  const x = Math.min(o.x1, o.x2);
  const y = Math.min(o.y1, o.y2);
  const w = Math.abs(o.x2 - o.x1);
  const h = Math.abs(o.y2 - o.y1);
  const flip = { h: o.x2 < o.x1, v: o.y2 < o.y1 };
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Linha ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(x, y, w, h, flip)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>`
    + `<a:noFill/>${traco({ color: o.color || '8D8D8D', w: o.w, dash: o.dash })}</p:spPr>`
    + txBody(o, { vazio: true })
    + '</p:sp>';
}

/**
 * Polilinha/área. O caminho vive num espaço de coordenadas próprio do tamanho da
 * forma; por isso o bounding box é calculado aqui e cada ponto vira relativo a
 * ele. Uma série perfeitamente plana tem altura zero — daí o piso de 1 EMU, que
 * evita `h="0"` (o PowerPoint reclama do arquivo inteiro por causa disso).
 */
function spPoly(id, o) {
  const pts = (o.pts || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return '';
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  const W = Math.max(1, emu(w));
  const H = Math.max(1, emu(h));

  const px = (v) => Math.round(((v - x0) / (w || 1)) * W);
  const py = (v) => Math.round(((v - y0) / (h || 1)) * H);
  const caminho = pts.map((p, i) => {
    const tag = i === 0 ? 'moveTo' : 'lnTo';
    return `<a:${tag}><a:pt x="${px(p[0])}" y="${py(p[1])}"/></a:${tag}>`;
  }).join('') + (o.close ? '<a:close/>' : '');

  const fill = o.fill ? solidFill(o.fill, o.fillAlpha) : '<a:noFill/>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Série ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(x0, y0, w, h)}`
    + `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>`
    + `<a:pathLst><a:path w="${W}" h="${H}" fill="${o.fill ? 'norm' : 'none'}">${caminho}</a:path></a:pathLst>`
    + '</a:custGeom>'
    + fill + traco(o.color ? { color: o.color, w: o.w, dash: o.dash } : null) + '</p:spPr>'
    + txBody(o, { vazio: true })
    + '</p:sp>';
}

/* Célula. Aceita `lines: [{text, …}]` para o cabeçalho de duas alturas do
   relatório de MLC ("Med/ Jun 25" em cima, "Inv/ Ago 25" embaixo) — dois
   parágrafos na MESMA célula, sem mesclagem: gridSpan/hMerge exigiria emitir as
   células engolidas com corpo vazio, e esquecer uma delas faz o PowerPoint pedir
   reparo sem dizer onde. */
function celula(c, opts) {
  const o = typeof c === 'object' && c !== null ? c : { text: c };
  const herda = (l) => ({
    text: l.text,
    size: l.size || o.size || opts.size,
    bold: l.bold ?? o.bold ?? opts.bold,
    color: l.color || o.color || opts.color,
    align: l.align || o.align || opts.align,
    spaceBefore: l.spaceBefore,
  });
  const linhas = (o.lines && o.lines.length ? o.lines : [{ text: o.text }]).map(herda);
  const fill = o.fill ? solidFill(o.fill) : '<a:noFill/>';
  const borda = o.borderBottom === false
    ? ''
    : `<a:lnB w="${emu(0.75)}">${solidFill(o.border || opts.border || 'E0E0E0')}</a:lnB>`;
  return '<a:tc>'
    + txBody({ lines: linhas, valign: o.valign || 'middle', align: o.align || opts.align }, { ns: 'a' })
    + `<a:tcPr marL="${emu(o.padX ?? 6)}" marR="${emu(o.padX ?? 6)}" marT="${emu(2)}" marB="${emu(2)}" anchor="ctr">`
    // Ordem obrigatória dentro de a:tcPr: linhas de borda e SÓ ENTÃO o preenchimento.
    + borda + fill + '</a:tcPr>'
    + '</a:tc>';
}

function gfTabela(id, o) {
  const cols = o.cols || [];
  const larguraTotal = cols.reduce((a, b) => a + b, 0);
  const headH = o.headH || 22;
  const rowH = o.rowH || 21;
  const headRows = Math.max(1, Math.min(o.headRows || 1, o.rows.length));
  const alturaTotal = headH * headRows + rowH * Math.max(0, o.rows.length - headRows);

  // Linha com mais (ou menos) células que colunas vira tabela torta no PowerPoint,
  // sem aviso. Melhor estourar aqui, com o número da linha.
  o.rows.forEach((linha, i) => {
    if (linha.length !== cols.length) {
      throw new Error(`Tabela: a linha ${i} tem ${linha.length} células para ${cols.length} colunas.`);
    }
  });

  const grid = `<a:tblGrid>${cols.map((w) => `<a:gridCol w="${emu(w)}"/>`).join('')}</a:tblGrid>`;
  const linhas = o.rows.map((linha, i) => {
    const cabecalho = i < headRows;
    const padrao = {
      size: cabecalho ? (o.headSize || 11) : (o.size || 11.5),
      bold: cabecalho,
      color: cabecalho ? '525252' : '161616',
      align: 'left',
      border: o.border,
    };
    const fundo = cabecalho ? (o.headFill || 'F4F4F4') : null;
    const cels = linha.map((c) => {
      const obj = typeof c === 'object' && c !== null ? { ...c } : { text: c };
      if (fundo && !obj.fill) obj.fill = fundo;
      return celula(obj, padrao);
    }).join('');
    return `<a:tr h="${emu(cabecalho ? headH : rowH)}">${cels}</a:tr>`;
  }).join('');

  return '<p:graphicFrame><p:nvGraphicFramePr>'
    + `<p:cNvPr id="${id}" name="Tabela ${id}"/>`
    + '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
    + `<p:xfrm><a:off x="${emu(o.x)}" y="${emu(o.y)}"/><a:ext cx="${emu(larguraTotal)}" cy="${emu(alturaTotal)}"/></p:xfrm>`
    // A URI da tabela é .../drawingml/2006/table — NÃO o namespace "main" com
    // /table no fim. Com a errada o PowerPoint abre o arquivo e mostra um quadro
    // vazio, sem erro nenhum.
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>'
    // "No Style, No Grid": as cores vêm célula a célula, não de um estilo do tema.
    + '<a:tblPr firstRow="1"><a:tableStyleId>{2D5ABB26-0587-4C30-8999-92F81FD0307C}</a:tableStyleId></a:tblPr>'
    + grid + linhas
    + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
}

function forma(id, s) {
  switch (s.t) {
    case 'rect': return spRect(id, s);
    case 'line': return spLinha(id, s);
    case 'text': return spTexto(id, s);
    case 'poly': return spPoly(id, s);
    case 'table': return gfTabela(id, s);
    default: throw new Error(`Primitiva desconhecida no slide: ${s.t}`);
  }
}

/* ── Partes fixas do pacote ─────────────────────────────────────────────── */

function slideXml(slide) {
  let id = 1; // o id 1 é da árvore de formas
  const formas = (slide.shapes || []).map((s) => forma(++id, s)).join('');
  return XML_DECL
    + `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + formas
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

function temaXml() {
  const acentos = ['0F62FE', '198038', 'B45309', 'DA1E28', '8A3FFC', '009D9A'];
  const fill3 = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3);
  const ln = '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">'
    + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>';
  const fonte = `<a:latin typeface="${FONTE}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  return XML_DECL
    + `<a:theme xmlns:a="${NS_A}" name="zControlDesk"><a:themeElements>`
    + '<a:clrScheme name="zControlDesk">'
    + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
    + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
    + '<a:dk2><a:srgbClr val="161616"/></a:dk2><a:lt2><a:srgbClr val="F4F4F4"/></a:lt2>'
    + acentos.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join('')
    + '<a:hlink><a:srgbClr val="0F62FE"/></a:hlink><a:folHlink><a:srgbClr val="8A3FFC"/></a:folHlink>'
    + '</a:clrScheme>'
    + `<a:fontScheme name="zControlDesk"><a:majorFont>${fonte}</a:majorFont><a:minorFont>${fonte}</a:minorFont></a:fontScheme>`
    + '<a:fmtScheme name="zControlDesk">'
    + `<a:fillStyleLst>${fill3}</a:fillStyleLst>`
    + `<a:lnStyleLst>${ln.repeat(3)}</a:lnStyleLst>`
    + '<a:effectStyleLst>' + '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) + '</a:effectStyleLst>'
    + `<a:bgFillStyleLst>${fill3}</a:bgFillStyleLst>`
    + '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
}

const ARVORE_VAZIA = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
  + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

function masterXml() {
  return XML_DECL
    + `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld>`
    + '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
    + ARVORE_VAZIA
    + '</p:cSld>'
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"'
    + ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"'
    + ' hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>'
    + '</p:sldMaster>';
}

function layoutXml() {
  return XML_DECL
    + `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1">`
    + `<p:cSld name="Em branco">${ARVORE_VAZIA}</p:cSld>`
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
}

function rels(itens) {
  return XML_DECL
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + itens.map((i) => `<Relationship Id="${i.id}" Type="${i.type}" Target="${i.target}"/>`).join('')
    + '</Relationships>';
}

const TIPO = {
  doc: `${NS_R}/officeDocument`,
  core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  app: `${NS_R}/extended-properties`,
  master: `${NS_R}/slideMaster`,
  layout: `${NS_R}/slideLayout`,
  slide: `${NS_R}/slide`,
  theme: `${NS_R}/theme`,
};

/**
 * Monta o .pptx.
 * @param {{title?:string, author?:string, slides:Array<{shapes:Array}>}} deck
 * @returns {Buffer}
 */
function buildPptx(deck) {
  const slides = deck.slides || [];
  if (!slides.length) throw new Error('Apresentação sem slides.');

  const n = slides.length;
  const relsApresentacao = [
    { id: 'rId1', type: TIPO.master, target: 'slideMasters/slideMaster1.xml' },
    ...slides.map((_, i) => ({ id: `rId${i + 2}`, type: TIPO.slide, target: `slides/slide${i + 1}.xml` })),
    { id: `rId${n + 2}`, type: TIPO.theme, target: 'theme/theme1.xml' },
  ];

  const apresentacao = XML_DECL
    + `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + '<p:sldIdLst>'
    + slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')
    + '</p:sldIdLst>'
    + `<p:sldSz cx="${emu(LARGURA_PT)}" cy="${emu(ALTURA_PT)}"/>`
    + '<p:notesSz cx="6858000" cy="9144000"/>'
    + '</p:presentation>';

  const tipos = XML_DECL
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';

  const quando = (deck.createdAt instanceof Date ? deck.createdAt : new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const core = XML_DECL
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
    + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${esc(deck.title || 'Apresentação')}</dc:title>`
    + `<dc:creator>${esc(deck.author || 'IBM Z Control Desk')}</dc:creator>`
    + `<cp:lastModifiedBy>${esc(deck.author || 'IBM Z Control Desk')}</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${quando}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${quando}</dcterms:modified>`
    + '</cp:coreProperties>';

  const app = XML_DECL
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
    + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + `<Application>IBM Z Control Desk</Application><Slides>${n}</Slides>`
    + '<ScaleCrop>false</ScaleCrop><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>'
    + '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion>'
    + '</Properties>';

  // A ordem importa: [Content_Types].xml precisa ser a primeira entrada do ZIP.
  const arquivos = {
    '[Content_Types].xml': strToU8(tipos),
    '_rels/.rels': strToU8(rels([
      { id: 'rId1', type: TIPO.doc, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: TIPO.core, target: 'docProps/core.xml' },
      { id: 'rId3', type: TIPO.app, target: 'docProps/app.xml' },
    ])),
    'docProps/core.xml': strToU8(core),
    'docProps/app.xml': strToU8(app),
    'ppt/presentation.xml': strToU8(apresentacao),
    'ppt/_rels/presentation.xml.rels': strToU8(rels(relsApresentacao)),
    'ppt/theme/theme1.xml': strToU8(temaXml()),
    'ppt/slideMasters/slideMaster1.xml': strToU8(masterXml()),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(rels([
      { id: 'rId1', type: TIPO.layout, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: TIPO.theme, target: '../theme/theme1.xml' },
    ])),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(layoutXml()),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(rels([
      { id: 'rId1', type: TIPO.master, target: '../slideMasters/slideMaster1.xml' },
    ])),
  };
  slides.forEach((s, i) => {
    arquivos[`ppt/slides/slide${i + 1}.xml`] = strToU8(slideXml(s));
    arquivos[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(rels([
      { id: 'rId1', type: TIPO.layout, target: '../slideLayouts/slideLayout1.xml' },
    ]));
  });

  return Buffer.from(zipSync(arquivos, { level: 6, mtime: deck.createdAt || new Date() }));
}

module.exports = { buildPptx, larguraTexto, tamanhoQueCabe, LARGURA_PT, ALTURA_PT, FONTE, esc };
