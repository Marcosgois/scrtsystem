'use strict';

/*
 * O deck de capacity planning que vai para a reunião com o cliente.
 *
 * Monta os slides a partir do MESMO payload que a tela consome — nada é
 * recalculado aqui. Se o slide e a tela discordassem de um número, a reunião
 * viraria uma discussão sobre a ferramenta em vez do consumo.
 *
 * O gráfico é redesenhado em vetor (primitivas de src/pptx.js) em vez de ser uma
 * foto do canvas: o slide fica nítido em qualquer projetor e a exportação não
 * depende do navegador ter renderizado nada.
 */

const { buildPptx, LARGURA_PT } = require('./pptx');
const { rotuloCurto } = require('./forecastYears');

/* Mesma paleta da tela — o deck tem de ser reconhecível como o mesmo produto. */
const TINTA = {
  ink: '161616',
  muted: '6F6F6F',
  faint: '8D8D8D',
  rule: 'E0E0E0',
  grid: 'EDEFF2',
  surface: 'F4F4F4',
  real: '0F62FE',
  proj: 'B45309',
  baseline: 'DA1E28',
  alta: 'DA1E28',   // consumo subindo é risco, não conquista: vermelho
  baixa: '198038',
};

const MARGEM = 44;
const LARGURA = LARGURA_PT - MARGEM * 2; // 872 pt de área útil
const TOPO_CONTEUDO = 104;
const BASE_CONTEUDO = 492;

const fmt = (n) => (n === null || n === undefined ? '–' : Math.round(Number(n)).toLocaleString('pt-BR'));
const fmtM = (n) => (Math.abs(n) >= 1e6
  ? `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}M`
  : fmt(n));
const fmtPct = (p) => (p === null || p === undefined
  ? '–'
  : `${p >= 0 ? '+' : ''}${Number(p).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);
const pct1 = (p) => `${Number(p).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const dataBr = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

const nomeMetodo = (m) => (m === 'sarima' ? 'SARIMA' : 'regressão linear');

/** Composição do ano em uma frase — o slide não tem espaço para tags coloridas. */
function composicao(a) {
  if (a.projMonths === 0) return `${a.realMonths} ${a.realMonths === 1 ? 'mês real' : 'meses reais'}`;
  if (a.realMonths === 0) return `${a.projMonths} ${a.projMonths === 1 ? 'mês projetado' : 'meses projetados'}`;
  return `${a.realMonths} ${a.realMonths === 1 ? 'real' : 'reais'} + ${a.projMonths} ${a.projMonths === 1 ? 'projetado' : 'projetados'}`;
}

/* ── Moldura dos slides ─────────────────────────────────────────────────── */

function moldura({ titulo, sobretitulo, rodape, pagina, totalPaginas }) {
  return [
    { t: 'text', x: MARGEM, y: 30, w: LARGURA, h: 16, text: sobretitulo, size: 10.5, color: TINTA.muted },
    { t: 'text', x: MARGEM, y: 46, w: LARGURA, h: 34, text: titulo, size: 23, bold: true, color: TINTA.ink },
    { t: 'line', x1: MARGEM, y1: 88, x2: MARGEM + LARGURA, y2: 88, color: TINTA.rule, w: 1 },
    { t: 'line', x1: MARGEM, y1: 500, x2: MARGEM + LARGURA, y2: 500, color: TINTA.rule, w: 0.75 },
    { t: 'text', x: MARGEM, y: 508, w: LARGURA - 60, h: 14, text: rodape, size: 9, color: TINTA.faint },
    {
      t: 'text', x: MARGEM + LARGURA - 60, y: 508, w: 60, h: 14,
      text: `${pagina}/${totalPaginas}`, size: 9, color: TINTA.faint, align: 'right',
    },
  ];
}

/* ── Gráfico vetorial ───────────────────────────────────────────────────── */

/** Passo de grade "redondo" (1, 2, 2,5, 5 × potência de 10). */
function passoBonito(bruto) {
  if (!(bruto > 0)) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(bruto)));
  const norm = bruto / base;
  const m = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return m * base;
}

function amostraDeRotulos(n, maximo) {
  if (n <= maximo) return Array.from({ length: n }, (_, i) => i);
  const passo = Math.ceil(n / maximo);
  const idx = [];
  for (let i = 0; i < n; i += passo) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}

/**
 * Desenha o histórico + projeção + intervalo de 95% dentro de `box` (em pt).
 * Devolve primitivas na ordem de empilhamento (o que vem depois fica por cima).
 */
function graficoProjecao(f, box) {
  const hist = f.history || [];
  const proj = f.forecast || [];
  const n = hist.length + proj.length;
  if (n < 2) return [];

  const px = box.x + 62;
  const py = box.y + 26;
  const pw = box.w - 70;
  const ph = box.h - 56;

  const baseline = f.client && f.client.monthlyBaselineMsu ? f.client.monthlyBaselineMsu : null;
  const valores = [
    ...hist.map((h) => h.totalMsuConsumed),
    ...proj.map((p) => p.value), ...proj.map((p) => p.lower), ...proj.map((p) => p.upper),
    ...(baseline ? [baseline] : []),
  ].filter((v) => Number.isFinite(v));
  let vmin = Math.min(...valores);
  let vmax = Math.max(...valores);
  if (vmax === vmin) { vmax = vmin + 1; }
  const folga = (vmax - vmin) * 0.08;
  vmin = Math.max(0, vmin - folga);
  vmax += folga;

  // Alvo de ~6 divisões: com 4 ou 5 o passo "redondo" salta cedo demais para a
  // potência seguinte e o eixo fica com três marcas numa faixa de 30M.
  const passo = passoBonito((vmax - vmin) / 6);
  const ticks = [];
  for (let v = Math.ceil(vmin / passo) * passo; v <= vmax + 1e-9; v += passo) ticks.push(v);

  const xAt = (i) => px + (pw * i) / (n - 1);
  const yAt = (v) => py + ph - ((v - vmin) / (vmax - vmin)) * ph;

  const formas = [];

  // Grade e escala vertical
  for (const v of ticks) {
    const y = yAt(v);
    formas.push({ t: 'line', x1: px, y1: y, x2: px + pw, y2: y, color: TINTA.grid, w: 0.75 });
    formas.push({
      t: 'text', x: px - 58, y: y - 7, w: 52, h: 14,
      text: fmtM(v), size: 9, color: TINTA.muted, align: 'right',
    });
  }

  // Intervalo de 95%: sobe pelo limite superior e volta pelo inferior.
  if (proj.length) {
    const iUltimoReal = hist.length - 1;
    const ancora = hist.length ? [[xAt(iUltimoReal), yAt(hist[iUltimoReal].totalMsuConsumed)]] : [];
    const cima = proj.map((p, i) => [xAt(hist.length + i), yAt(p.upper)]);
    const baixo = proj.map((p, i) => [xAt(hist.length + i), yAt(p.lower)]).reverse();
    formas.push({
      t: 'poly', pts: [...ancora, ...cima, ...baixo, ...ancora],
      fill: TINTA.proj, fillAlpha: 0.12, close: true,
    });
  }

  // Baseline contratual mensal
  if (baseline && baseline >= vmin && baseline <= vmax) {
    const y = yAt(baseline);
    formas.push({ t: 'line', x1: px, y1: y, x2: px + pw, y2: y, color: TINTA.baseline, w: 1.5, dash: 'dash' });
  }

  // Onde o dado real acaba e a projeção começa
  if (hist.length && proj.length) {
    const x = xAt(hist.length - 1);
    formas.push({ t: 'line', x1: x, y1: py, x2: x, y2: py + ph, color: 'C6C6C6', w: 0.75, dash: 'sysDash' });
  }

  formas.push({
    t: 'poly', color: TINTA.real, w: 2,
    pts: hist.map((h, i) => [xAt(i), yAt(h.totalMsuConsumed)]),
  });
  if (proj.length) {
    const ancora = hist.length ? [[xAt(hist.length - 1), yAt(hist[hist.length - 1].totalMsuConsumed)]] : [];
    formas.push({
      t: 'poly', color: TINTA.proj, w: 2, dash: 'dash',
      pts: [...ancora, ...proj.map((p, i) => [xAt(hist.length + i), yAt(p.value)])],
    });
  }

  // Eixo e rótulos de mês
  formas.push({ t: 'line', x1: px, y1: py + ph, x2: px + pw, y2: py + ph, color: 'C6C6C6', w: 1 });
  const chaves = [...hist.map((h) => h.periodKey), ...proj.map((p) => p.periodKey)];
  for (const i of amostraDeRotulos(n, 12)) {
    formas.push({
      t: 'text', x: xAt(i) - 26, y: py + ph + 7, w: 52, h: 14,
      text: rotuloCurto(chaves[i]), size: 9, color: TINTA.muted, align: 'center',
    });
  }

  // Legenda no topo do quadro
  const itens = [
    { cor: TINTA.real, texto: 'Consumo real' },
    { cor: TINTA.proj, texto: `Projeção (${nomeMetodo(f.method)})` },
    { cor: TINTA.proj, texto: 'Intervalo de 95%', faixa: true },
    ...(baseline ? [{ cor: TINTA.baseline, texto: `Baseline mensal (${fmtM(baseline)} MSU)`, tracejado: true }] : []),
  ];
  let lx = px;
  for (const it of itens) {
    const largura = 7 + it.texto.length * 4.9 + 16;
    if (it.faixa) {
      formas.push({ t: 'rect', x: lx, y: box.y + 4, w: 12, h: 8, fill: it.cor, alpha: 0.18 });
    } else {
      formas.push({
        t: 'line', x1: lx, y1: box.y + 8, x2: lx + 12, y2: box.y + 8,
        color: it.cor, w: 2, dash: it.tracejado ? 'dash' : undefined,
      });
    }
    formas.push({ t: 'text', x: lx + 16, y: box.y + 1, w: largura, h: 14, text: it.texto, size: 9, color: TINTA.muted });
    lx += largura + 14;
  }

  return formas;
}

/* ── Slides ─────────────────────────────────────────────────────────────── */

function slideCapa(f, hoje) {
  const anos = f.horizonMonths / 12;
  const periodo = f.history.length
    ? `${rotuloCurto(f.history[0].periodKey)} – ${rotuloCurto(f.history[f.history.length - 1].periodKey)}`
    : '—';
  return {
    shapes: [
      { t: 'rect', x: 0, y: 0, w: 12, h: 540, fill: TINTA.real },
      { t: 'text', x: 84, y: 168, w: 800, h: 20, text: 'IBM Z CONTROL DESK', size: 11, color: TINTA.muted },
      { t: 'text', x: 84, y: 196, w: 800, h: 58, text: 'Capacity planning', size: 44, bold: true, color: TINTA.ink },
      { t: 'text', x: 84, y: 258, w: 800, h: 34, text: f.client.name, size: 24, color: TINTA.real },
      { t: 'line', x1: 84, y1: 306, x2: 380, y2: 306, color: TINTA.rule, w: 1 },
      {
        t: 'text',
        x: 84,
        y: 322,
        w: 760,
        h: 90,
        size: 12.5,
        color: TINTA.muted,
        lines: [
          { text: `Projeção de ${anos === 1 ? '1 ano' : `${anos} anos`} pelo método ${nomeMetodo(f.method)}`, spaceBefore: 0 },
          { text: `Histórico considerado: ${f.history.length} meses de SCRT (${periodo})`, spaceBefore: 6 },
          { text: `Gerado em ${dataBr(hoje)}`, spaceBefore: 6 },
        ],
      },
    ],
  };
}

function slideGrafico(f, ctx) {
  const m = f.model;
  const descricao = m.method === 'sarima'
    ? `Modelo ${m.order} · AICc ${Number(m.aicc).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}`
      + ` · ${m.observationsUsed} observações · desvio residual ${fmt(m.sigma)} MSU`
    : `Regressão linear · inclinação ${fmt(m.slope)} MSU/mês`
      + (m.r2 !== null && m.r2 !== undefined ? ` · R² ${Number(m.r2).toFixed(3)}` : '')
      + ` · desvio residual ${fmt(m.sigma)} MSU`;

  return {
    shapes: [
      ...moldura({ ...ctx, titulo: 'Consumo mensal: histórico e projeção' }),
      ...graficoProjecao(f, { x: MARGEM, y: TOPO_CONTEUDO, w: LARGURA, h: 336 }),
      { t: 'text', x: MARGEM, y: 452, w: LARGURA, h: 16, text: 'MSU por mês', size: 9.5, color: TINTA.faint },
      { t: 'text', x: MARGEM, y: 470, w: LARGURA, h: 18, text: descricao, size: 10.5, color: TINTA.muted },
    ],
  };
}

/** Uma tabela por slide, quebrando em páginas quando não couber. */
function slidesDeTabela({ titulo, cabecalho, cols, linhas, nota, ctx, contarPaginas }) {
  const POR_SLIDE = 13;
  const paginas = [];
  for (let i = 0; i < Math.max(1, Math.ceil(linhas.length / POR_SLIDE)); i++) {
    paginas.push(linhas.slice(i * POR_SLIDE, (i + 1) * POR_SLIDE));
  }
  if (contarPaginas) return paginas.length;

  return paginas.map((bloco, i) => ({
    shapes: [
      ...moldura({ ...ctx, pagina: ctx.pagina + i, titulo: paginas.length > 1 ? `${titulo} (${i + 1}/${paginas.length})` : titulo }),
      bloco.length
        ? { t: 'table', x: MARGEM, y: TOPO_CONTEUDO, cols, rows: [cabecalho, ...bloco] }
        : { t: 'text', x: MARGEM, y: TOPO_CONTEUDO, w: LARGURA, h: 20, text: 'Sem anos para consolidar.', size: 12, color: TINTA.muted },
      ...(nota && i === paginas.length - 1
        ? [{
          t: 'text', x: MARGEM, y: BASE_CONTEUDO - 24, w: LARGURA, h: 18,
          text: nota, size: 10, color: TINTA.muted,
        }]
        : []),
    ],
  }));
}

function linhasCalendario(f) {
  return (f.years || []).map((a) => ([
    { text: `${a.year}${a.complete ? '' : ' (parcial)'}`, bold: true },
    composicao(a),
    { text: fmt(a.totalMsu), align: 'right', bold: true },
    {
      text: fmtPct(a.growthPct),
      align: 'right',
      color: a.growthPct === null || a.growthPct === undefined ? TINTA.muted : (a.growthPct >= 0 ? TINTA.alta : TINTA.baixa),
    },
    { text: a.annualBaselineMsu ? fmt(a.annualBaselineMsu) : '–', align: 'right', color: TINTA.muted },
    {
      text: a.vsBaselinePct === null || a.vsBaselinePct === undefined ? '–' : pct1(a.vsBaselinePct),
      align: 'right',
      color: a.vsBaselinePct === null || a.vsBaselinePct === undefined
        ? TINTA.muted : (a.vsBaselinePct > 100 ? TINTA.alta : TINTA.baixa),
    },
  ]));
}

function linhasContratual(f) {
  return (f.contractYears || []).map((a) => ([
    {
      text: a.inContract ? `${a.contractName || 'Contrato'} · ${a.label}` : 'Fora de contrato',
      bold: true,
      color: a.inContract ? TINTA.ink : TINTA.muted,
    },
    { text: a.rangeLabel, color: TINTA.muted },
    composicao(a) + (a.inContract && !a.complete ? ` · ${a.months}/12` : ''),
    { text: fmt(a.totalMsu), align: 'right', bold: true },
    {
      text: fmtPct(a.growthPct),
      align: 'right',
      color: a.growthPct === null || a.growthPct === undefined ? TINTA.muted : (a.growthPct >= 0 ? TINTA.alta : TINTA.baixa),
    },
    {
      text: a.vsBaselinePct === null || a.vsBaselinePct === undefined ? '–' : pct1(a.vsBaselinePct),
      align: 'right',
      color: a.vsBaselinePct === null || a.vsBaselinePct === undefined
        ? TINTA.muted : (a.vsBaselinePct > 100 ? TINTA.alta : TINTA.baixa),
    },
  ]));
}

function slidePremissas(f, ctx) {
  const m = f.model;
  const baseline = f.client.monthlyBaselineMsu;
  const itens = [
    m.method === 'sarima'
      ? `Método: ${m.order}, escolhido por AICc entre as ordens candidatas e ajustado sobre ${m.observationsUsed} observações.`
      : `Método: regressão linear por mínimos quadrados sobre ${f.history.length} meses.`,
    'A faixa sombreada é o intervalo de 95%: em 19 de cada 20 cenários o consumo real cai dentro dela. Ela alarga com o horizonte porque a incerteza se acumula mês a mês.',
    'Cada linha da consolidação informa quantos meses são reais (SCRT recebido) e quantos são projeção. Ano que não fecha 12 meses aparece como parcial e não entra no cálculo de crescimento.',
    baseline
      ? `Baseline contratual: ${fmt(baseline)} MSU/mês, ou ${fmt(baseline * 12)} MSU/ano. O "% do baseline" compara o consumo do ano com esse teto.`
      : 'Baseline contratual não cadastrado para este cliente — sem ele não há "% do baseline".',
    f.hasContractPeriods
      ? 'O fechamento por ano contratual segue os períodos cadastrados do cliente; a contagem de anos reinicia a cada contrato.'
      : 'Não há períodos contratuais cadastrados: só o fechamento por ano-calendário está disponível.',
    'A projeção extrapola o comportamento passado. Migração de máquina, entrada de nova aplicação ou desligamento de LPAR não estão nela — precisam ser somados à parte.',
  ];

  const linhas = [...itens, ...(f.notes || [])].map((it) => ({
    text: it, bullet: true, size: 12, color: TINTA.ink, spaceBefore: 12, lineHeight: 1.25,
  }));

  return {
    shapes: [
      ...moldura({ ...ctx, titulo: 'Método e premissas' }),
      { t: 'text', x: MARGEM, y: TOPO_CONTEUDO, w: LARGURA, h: BASE_CONTEUDO - TOPO_CONTEUDO, lines: linhas },
    ],
  };
}

/**
 * Os slides do deck, como primitivas de desenho — antes de virarem OOXML.
 * Exposto separado do .pptx para poder ser inspecionado (e renderizado como SVG
 * numa prévia) sem abrir o PowerPoint.
 * @param {object} f payload de GET /clients/:id/forecast
 * @returns {Array<{shapes:Array}>}
 */
function slidesDoDeck(f, { hoje = new Date() } = {}) {
  const anos = f.horizonMonths / 12;
  const ctxBase = {
    sobretitulo: `${f.client.name} · Capacity planning`,
    rodape: `IBM Z Control Desk · projeção ${nomeMetodo(f.method)} · ${anos === 1 ? '1 ano' : `${anos} anos`} · gerado em ${dataBr(hoje)}`,
  };

  const calend = linhasCalendario(f);
  const contrat = linhasContratual(f);
  const colsCalend = [96, 168, 168, 120, 168, 152];
  const colsContrat = [210, 118, 160, 154, 110, 120];
  const cabCalend = ['Ano', 'Composição', 'Consumo total (MSU)', 'Crescimento', 'Baseline anual', '% do baseline'];
  const cabContrat = ['Contrato · Ano', 'Período', 'Composição', 'Consumo total (MSU)', 'Crescimento', '% do baseline'];

  // Conta as páginas antes para numerar o rodapé certo (o total aparece em todas).
  const nCalend = slidesDeTabela({ linhas: calend, contarPaginas: true });
  const nContrat = f.hasContractPeriods ? slidesDeTabela({ linhas: contrat, contarPaginas: true }) : 0;
  const total = 1 /* capa */ + 1 /* gráfico */ + nCalend + nContrat + 1 /* premissas */;

  let pagina = 2; // a capa não recebe rodapé numerado
  const ctx = (extra) => ({ ...ctxBase, totalPaginas: total, pagina, ...extra });

  const slides = [slideCapa(f, hoje)];

  slides.push(slideGrafico(f, ctx()));
  pagina += 1;

  slides.push(...slidesDeTabela({
    titulo: 'Consolidado por ano-calendário',
    cabecalho: cabCalend,
    cols: colsCalend,
    linhas: calend,
    ctx: ctx(),
    nota: 'Ano-calendário (jan–dez): a base de orçamento do cliente.',
  }));
  pagina += nCalend;

  if (f.hasContractPeriods) {
    slides.push(...slidesDeTabela({
      titulo: 'Consolidado por ano contratual',
      cabecalho: cabContrat,
      cols: colsContrat,
      linhas: contrat,
      ctx: ctx(),
      nota: 'Ano contratual: a janela em que o baseline é apurado e o consumo é faturado.',
    }));
    pagina += nContrat;
  }

  slides.push(slidePremissas(f, ctx()));
  return slides;
}

/**
 * Monta o .pptx do capacity planning.
 * @param {object} f payload de GET /clients/:id/forecast
 * @param {{hoje?:Date, autor?:string}} opts
 * @returns {{ buffer: Buffer, fileName: string }}
 */
function deckCapacityPlanning(f, { hoje = new Date(), autor = 'IBM Z Control Desk' } = {}) {
  const buffer = buildPptx({
    title: `Capacity planning · ${f.client.name}`,
    author: autor,
    createdAt: hoje,
    slides: slidesDoDeck(f, { hoje }),
  });

  const slug = String(f.client.name || 'cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'cliente';
  const carimbo = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

  return { buffer, fileName: `capacity-planning-${slug}-${carimbo}.pptx` };
}

module.exports = { deckCapacityPlanning, slidesDoDeck, graficoProjecao, passoBonito, composicao };
