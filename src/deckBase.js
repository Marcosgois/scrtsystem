'use strict';

/*
 * A base comum dos decks: a moldura do slide, a escala dos gráficos, a legenda e
 * os formatadores.
 *
 * Existe porque o deck de MLC (R$) e o de consumo zOTC (MSU) precisam parecer o
 * MESMO documento quando saem grampeados na mesma reunião — mesma margem, mesma
 * régua, mesma cor para a mesma coisa. Duplicar isso garantiria que um dos dois
 * ficasse com o título dois pontos mais alto que o outro.
 *
 * Coordenadas em pontos, sobre o slide 16:9 de 960×540 (ver src/pptx.js).
 */

const { larguraTexto, LARGURA_PT } = require('./pptx');
const { passoBonito } = require('./deckCapacity');


const TINTA = {
  ink: '161616',
  muted: '6F6F6F',
  faint: '8D8D8D',
  rule: 'E0E0E0',
  grid: 'EDEFF2',
  surface: 'F4F4F4',
  cabecalho: '1F3A93',   // o azul das faixas de cabeçalho do relatório
  barra: 'A8C0EA',
  cap: 'FF832B',
  alta: 'DA1E28',
  baixa: '198038',
  destaque: 'C8E6C9',    // verde do "baseline igual ao consumo do ano anterior"
  atencao: 'FFF8C5',     // amarelo da caixa de anotação
};

const MARGEM = 44;
const LARGURA = LARGURA_PT - MARGEM * 2;   // 872 pt
const TOPO = 104;
const BASE = 492;

const nRs = (v) => (v === null || v === undefined
  ? '—'
  : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const nMsu = (v) => (v === null || v === undefined ? '—' : Math.round(Number(v)).toLocaleString('pt-BR'));
const nPct = (v) => (v === null || v === undefined
  ? '—'
  : `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const fmtM = (v) => (Math.abs(v) >= 1e6
  ? `${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}M`
  : Math.round(v).toLocaleString('pt-BR'));
const dataBr = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/* ── Moldura ─────────────────────────────────────────────────────────────── */

function moldura({ titulo, sobretitulo, rodape, pagina, totalPaginas }) {
  return [
    { t: 'text', x: MARGEM, y: 30, w: LARGURA, h: 16, text: sobretitulo, size: 10.5, color: TINTA.muted },
    { t: 'text', x: MARGEM, y: 46, w: LARGURA, h: 34, text: titulo, size: 22, bold: true, color: TINTA.ink },
    { t: 'line', x1: MARGEM, y1: 88, x2: MARGEM + LARGURA, y2: 88, color: TINTA.rule, w: 1 },
    { t: 'line', x1: MARGEM, y1: 500, x2: MARGEM + LARGURA, y2: 500, color: TINTA.rule, w: 0.75 },
    { t: 'text', x: MARGEM, y: 508, w: LARGURA - 60, h: 14, text: rodape, size: 9, color: TINTA.faint },
    {
      t: 'text', x: MARGEM + LARGURA - 60, y: 508, w: 60, h: 14,
      text: `${pagina}/${totalPaginas}`, size: 9, color: TINTA.faint, align: 'right',
    },
  ];
}

/* ── Eixo comum aos gráficos ─────────────────────────────────────────────── */

/**
 * Escala vertical e grade de um quadro. Devolve as primitivas da grade e a
 * função yAt — nenhum gráfico daqui inventa a própria escala.
 */
function escalaY(valores, caixa, { zero = true, divisoes = 5, formata = fmtM, pedestal = 0.08 } = {}) {
  const finitos = valores.filter((v) => Number.isFinite(v));
  let vmax = finitos.length ? Math.max(...finitos) : 1;
  // Math.min() sem argumento é Infinity — e daí todo yAt() sai NaN.
  let vmin = zero || !finitos.length ? 0 : Math.min(...finitos);
  if (vmax === vmin) vmax = vmin + 1;
  const amplitude = vmax - vmin;
  vmax += amplitude * 0.08;
  /* Barra precisa de corpo: com o piso colado no menor valor, doze meses que
     variam 5% viram doze tracinhos e o gráfico não diz nada. O `pedestal` afunda
     o piso uma fração da amplitude — mantendo a diferença entre os meses visível,
     que é o que o eixo truncado existe para mostrar. */
  if (!zero) vmin = Math.max(0, vmin - amplitude * pedestal);

  const passo = passoBonito((vmax - vmin) / divisoes);
  const ticks = [];
  for (let v = Math.ceil(vmin / passo) * passo; v <= vmax + 1e-9; v += passo) ticks.push(v);

  const yAt = (v) => caixa.y + caixa.h - ((v - vmin) / (vmax - vmin)) * caixa.h;
  const grade = [];
  for (const v of ticks) {
    const y = yAt(v);
    grade.push({ t: 'line', x1: caixa.x, y1: y, x2: caixa.x + caixa.w, y2: y, color: TINTA.grid, w: 0.75 });
    grade.push({
      t: 'text', x: caixa.x - 60, y: y - 6.5, w: 54, h: 13,
      text: formata(v), size: 8.5, color: TINTA.muted, align: 'right',
    });
  }
  return { yAt, vmin, vmax, grade };
}

/** Legenda horizontal: amostra + rótulo, medindo o texto para não sobrepor. */
function legenda(itens, x, y, { size = 9 } = {}) {
  const out = [];
  let lx = x;
  for (const it of itens) {
    if (it.tipo === 'area') {
      out.push({ t: 'rect', x: lx, y: y + 3, w: 12, h: 8, fill: it.cor, alpha: it.alpha ?? 1 });
    } else {
      out.push({ t: 'line', x1: lx, y1: y + 7, x2: lx + 12, y2: y + 7, color: it.cor, w: 2, dash: it.dash });
    }
    const larg = larguraTexto(it.texto, size);
    out.push({ t: 'text', x: lx + 16, y, w: larg + 4, h: 14, text: it.texto, size, color: TINTA.muted });
    lx += 16 + larg + 16;
  }
  return out;
}

/** "consumo-software-caixa-2026-08-07.pptx" — sem acento, sem espaço. */
function nomeDeArquivo(prefixo, nomeCliente, hoje) {
  const slug = String(nomeCliente || 'cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'cliente';
  const d = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  return `${prefixo}-${slug}-${d}.pptx`;
}

module.exports = {
  TINTA, MARGEM, LARGURA, TOPO, BASE,
  nRs, nMsu, nPct, fmtM, dataBr,
  moldura, escalaY, legenda, nomeDeArquivo,
};
