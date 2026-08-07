'use strict';

/*
 * O deck de MLC que vai para a reunião: as três visões de src/mlcViews.js, uma
 * por slide.
 *
 *   1. Consumo Software MLC — Ano N   (R$ mês a mês, CAP contratado, gráfico)
 *   2. Comparação de consumo ao mês por ano   (MSU, anos sobrepostos em 1..12)
 *   3. Consumido × Planejado × Contratado     (tabela, conclusão e barras)
 *
 * Nada é recalculado aqui: o deck recebe o MESMO objeto `views` que a tela do
 * módulo MLC consome. Se o slide e o navegador discordassem de um número, a
 * reunião viraria uma discussão sobre a ferramenta em vez do consumo.
 *
 * Os gráficos são vetor (primitivas de src/pptx.js), não foto de canvas: o slide
 * aguenta zoom e a exportação não depende do navegador ter renderizado nada.
 */

const { buildPptx, larguraTexto, tamanhoQueCabe, LARGURA_PT } = require('./pptx');
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

/* ── Slide 1: Consumo Software MLC do ano ────────────────────────────────── */

function tabelaDoAno(a, caixa) {
  const colRotulo = 132;
  const colValor = (LARGURA - colRotulo) / (a.colunas.length + 1);
  const cols = [colRotulo, ...a.colunas.map(() => colValor), colValor];

  /* Uma fonte só para todos os valores, a maior em que o MAIOR deles ainda cabe
     na coluna. Sem isso o número mais longo transborda por cima do vizinho — o
     PowerPoint não recorta texto. */
  const valores = [
    ...a.colunas.map((c) => nRs(c.consumoRs)), ...a.colunas.map((c) => nRs(c.comCbaRs)),
    nRs(a.totais.consumoRs), nRs(a.totais.comCbaRs),
  ];
  const maior = valores.reduce((m, s) => (s.length > m.length ? s : m), '');
  // celula() escreve marL E marR de 6pt: a caixa útil é a coluna menos 12, não 6.
  const size = tamanhoQueCabe(maior, 9, colValor - 12, { bold: true, piso: 5.5 });

  const cab1 = [
    { lines: [{ text: 'HISTÓRICO INVENTÁRIO' }, { text: '(R$) REPORTADO' }],
      color: 'FFFFFF', fill: TINTA.cabecalho, bold: true, size: 8 },
    ...a.colunas.map((c) => ({ text: `Med/ ${c.medLabel}`, color: 'FFFFFF', fill: TINTA.cabecalho, align: 'center', size: 8 })),
    { text: 'TOTAL', color: TINTA.ink, fill: TINTA.surface, align: 'center', bold: true, size: 8.5 },
  ];
  const cab2 = [
    { text: a.label, color: 'FFFFFF', fill: TINTA.cabecalho, bold: true, size: 9 },
    ...a.colunas.map((c) => ({ text: `Inv/ ${c.invLabel}`, color: 'FFFFFF', fill: TINTA.cabecalho, align: 'center', size: 8 })),
    { text: '', fill: TINTA.surface },
  ];
  const linha = (rotulo, campo, total) => ([
    { text: rotulo, bold: true, size: 8.5 },
    ...a.colunas.map((c) => ({
      text: c[campo] == null ? '—' : nRs(c[campo]),
      align: 'right', size, color: c[campo] == null ? TINTA.faint : TINTA.ink,
    })),
    { text: nRs(total), align: 'right', bold: true, size, fill: TINTA.surface },
  ]);

  return {
    t: 'table',
    x: caixa.x, y: caixa.y, cols,
    headRows: 2, headH: 19, rowH: 20, size,
    rows: [
      cab1, cab2,
      linha('Consumo Mensal (R$)', 'consumoRs', a.totais.consumoRs),
      linha(`Consumo com CBA (${a.cbaLabel})`, 'comCbaRs', a.totais.comCbaRs),
    ],
  };
}

/** As duas mini-tabelas de CAP, lado a lado. */
function blocosDeCap(a, caixa) {
  if (!a.cap) {
    return [{
      t: 'text', x: caixa.x, y: caixa.y + 8, w: LARGURA, h: 16, size: 10, color: TINTA.muted,
      text: `Sem CAP contratado cadastrado para o ${a.label} — informe o teto anual no contrato de MLC para ver o saldo.`,
    }];
  }
  const larg = (LARGURA - 24) / 2;
  const mini = (x, titulo, linhas) => ({
    t: 'table', x, y: caixa.y, cols: [larg * 0.62, larg * 0.38],
    headH: 18, rowH: 17, size: 9, headSize: 9,
    rows: [
      [{ text: titulo, color: 'FFFFFF', fill: TINTA.cabecalho, bold: true, size: 8.5 },
        { text: '', fill: TINTA.cabecalho }],
      ...linhas,
    ],
  });

  const c = a.cap;
  const esquerda = mini(caixa.x, `CAP — Máximo Anual MLC ${a.label} (${c.janelaLabel})`, [
    [{ text: 'CAP contratado', bold: true }, { text: nRs(c.anualRs), align: 'right', bold: true }],
    [{ text: 'Total CAP consumido' }, { text: nRs(c.consumidoRs), align: 'right' }],
    [{ text: c.estourado ? 'CAP excedido' : 'Saldo CAP', bold: true, fill: TINTA.atencao },
      { text: nRs(Math.abs(c.saldoRs)), align: 'right', bold: true, fill: TINTA.atencao, color: c.estourado ? TINTA.alta : TINTA.ink }],
  ]);

  const direita = c.cba
    ? mini(caixa.x + larg + 24, `CAP — Disponibilidade CBA (${c.janelaLabel})`, [
      [{ text: 'Disponibilidade contratada', bold: true }, { text: nRs(c.cba.anualRs), align: 'right', bold: true }],
      [{ text: `Total consumido (${nPct(c.cba.descontoPct)} de desconto)` }, { text: nRs(c.cba.consumidoRs), align: 'right' }],
      [{ text: c.cba.estourado ? 'CBA excedido' : 'Saldo CAP CBA', bold: true, fill: TINTA.atencao },
        { text: nRs(Math.abs(c.cba.saldoRs)), align: 'right', bold: true, fill: TINTA.atencao, color: c.cba.estourado ? TINTA.alta : TINTA.ink }],
    ])
    : null;

  return direita ? [esquerda, direita] : [esquerda];
}

/** Barras mensais em R$ com o valor escrito na vertical dentro da barra. */
function graficoBarrasMensais(a, caixa) {
  // Number.isFinite e não `!= null`: um preço absurdo no contrato produz Infinity,
  // que passaria pelo teste de nulo e viraria uma barra sem altura calculável.
  const comDado = a.colunas.filter((c) => Number.isFinite(c.consumoRs));
  if (!comDado.length) {
    return [{
      t: 'text', x: caixa.x, y: caixa.y + caixa.h / 2, w: caixa.w, h: 16, align: 'center',
      text: 'Nenhum mês deste ano tem SCRT recebido.', size: 10, color: TINTA.muted,
    }];
  }
  const capMensal = a.cap ? a.cap.mensalRs : null;
  const plot = { x: caixa.x + 64, y: caixa.y + 20, w: caixa.w - 72, h: caixa.h - 52 };
  const { yAt, grade } = escalaY(
    [...comDado.map((c) => c.consumoRs), ...(capMensal ? [capMensal] : [])],
    plot, { zero: false, divisoes: 4, pedestal: 1.6 }
  );

  const out = [...grade];
  const banda = plot.w / a.colunas.length;
  const largBarra = Math.min(34, banda * 0.6);

  a.colunas.forEach((c, i) => {
    const cx = plot.x + banda * i + (banda - largBarra) / 2;
    if (!Number.isFinite(c.consumoRs)) {
      out.push({
        t: 'text', x: cx - 6, y: plot.y + plot.h - 16, w: largBarra + 12, h: 14,
        text: '—', size: 9, color: TINTA.faint, align: 'center',
      });
      return;
    }
    const topo = yAt(c.consumoRs);
    const alturaBarra = plot.y + plot.h - topo;
    const rotulo = nRs(c.consumoRs);
    // O rótulo vai DENTRO da barra, escrito de baixo para cima. Se não couber na
    // altura, sai do desenho em vez de vazar por cima do resto do slide.
    const cabe = larguraTexto(rotulo, 7.5) < alturaBarra - 12;
    out.push({
      t: 'rect', x: cx, y: topo, w: largBarra, h: alturaBarra, fill: TINTA.barra,
      ...(cabe ? {
        text: rotulo, vert: 'vert270', size: 7.5, bold: true, color: '1F3A93',
        align: 'center', valign: 'middle', padY: 4,
      } : {}),
    });
    out.push({
      t: 'text', x: cx - banda * 0.2, y: plot.y + plot.h + 6, w: largBarra + banda * 0.4, h: 12,
      text: c.invLabel, size: 7.5, color: TINTA.muted, align: 'center',
    });
  });

  if (capMensal) {
    const y = yAt(capMensal);
    out.push({ t: 'line', x1: plot.x, y1: y, x2: plot.x + plot.w, y2: y, color: TINTA.cap, w: 1.75, dash: 'dash' });
  }
  out.push({ t: 'line', x1: plot.x, y1: plot.y + plot.h, x2: plot.x + plot.w, y2: plot.y + plot.h, color: 'C6C6C6', w: 1 });
  out.push(...legenda([
    { cor: TINTA.barra, tipo: 'area', texto: 'Consumo mensal (R$)' },
    ...(capMensal ? [{ cor: TINTA.cap, dash: 'dash', texto: `CAP contratado mensal (${nRs(capMensal)})` }] : []),
  ], plot.x, caixa.y));

  return out;
}

function slideAnoMlc(views, ctx) {
  const a = views.anoMlc;
  if (!a) {
    return { shapes: [...moldura({ ...ctx, titulo: 'Consumo Software MLC' }),
      { t: 'text', x: MARGEM, y: TOPO, w: LARGURA, h: 20, size: 12, color: TINTA.muted,
        text: 'Não há contrato de MLC configurado para este cliente.' }] };
  }
  return {
    shapes: [
      ...moldura({ ...ctx, titulo: `Consumo Software MLC — ${a.label} (${a.periodoLabel})` }),
      tabelaDoAno(a, { x: MARGEM, y: TOPO }),
      ...blocosDeCap(a, { x: MARGEM, y: TOPO + 108 }),
      ...graficoBarrasMensais(a, { x: MARGEM, y: TOPO + 190, w: LARGURA, h: 178 }),
      {
        t: 'text', x: MARGEM, y: BASE - 12, w: LARGURA, h: 14, size: 8.5, color: TINTA.faint,
        text: `Med/ = mês medido no SCRT · Inv/ = mês em que entra no inventário `
          + `(defasagem de ${a.lagMonths} ${a.lagMonths === 1 ? 'mês' : 'meses'}). `
          + `Os valores são os do mês medido. ${a.totais.mesesComScrt} de ${a.totais.mesesNoAno} meses com SCRT recebido.`,
      },
    ],
  };
}

/* ── Slide 2: comparação de consumo por ano ──────────────────────────────── */

function slideComparativo(views, ctx) {
  const c = views.comparativo;
  const base = [...moldura({ ...ctx, titulo: 'Comparação de consumo ao mês (em MSU) por ano' })];
  if (!c.anos.length) {
    base.push({ t: 'text', x: MARGEM, y: TOPO, w: LARGURA, h: 20, size: 12, color: TINTA.muted,
      text: 'Nenhum ano contratual tem consumo medido.' });
    return { shapes: base };
  }

  const caixa = { x: MARGEM, y: TOPO + 6, w: LARGURA, h: 336 };
  const plot = { x: caixa.x + 66, y: caixa.y + 24, w: caixa.w - 76, h: caixa.h - 58 };
  const todos = c.anos.flatMap((a) => a.pontos.filter((v) => v != null));
  const { yAt, grade } = escalaY(
    [...todos, ...(c.baseline ? [c.baseline.mensalMsu] : [])],
    plot, { zero: false, divisoes: 6 }
  );
  const xAt = (pos) => plot.x + (plot.w * (pos - 1)) / 11;

  const out = [...base, ...grade];

  if (c.baseline) {
    const y = yAt(c.baseline.mensalMsu);
    out.push({ t: 'line', x1: plot.x, y1: y, x2: plot.x + plot.w, y2: y, color: '0072C3', w: 1.75, dash: 'sysDash' });
  }

  /* A linha muda de traço onde o dado deixa de ser medido: sólida no que veio do
     SCRT, tracejada no trecho completado pelo consumo planejado. Uma linha só,
     inteira e tracejada, esconderia que metade dela é medição. */
  for (const a of c.anos) {
    const ponto = (k) => (a.pontos[k] == null ? null : [xAt(k + 1), yAt(a.pontos[k])]);
    const corte = a.posicaoUltimoReal || 12;
    const medidos = [];
    const planejados = [];
    for (let k = 0; k < a.pontos.length; k++) {
      const p = ponto(k);
      if (!p) continue;
      if (k + 1 <= corte) medidos.push(p);
      else planejados.push(p);
    }
    if (medidos.length >= 2) out.push({ t: 'poly', pts: medidos, color: a.cor, w: 2.25 });
    if (planejados.length) {
      const emenda = medidos.length ? [medidos[medidos.length - 1]] : [];
      const trecho = [...emenda, ...planejados];
      if (trecho.length >= 2) out.push({ t: 'poly', pts: trecho, color: a.cor, w: 2.25, dash: 'dash' });
    }
  }

  // Rótulo do primeiro e do último ponto de cada ano — é o que a reunião lê.
  for (const a of c.anos) {
    for (const p of [a.primeiro, a.ultimo]) {
      if (!p) continue;
      const txt = nMsu(p.valor);
      const larg = larguraTexto(txt, 8.5) + 8;
      const daDireita = p.posicao > 6;
      out.push({
        t: 'text', x: xAt(p.posicao) + (daDireita ? -larg - 6 : 6), y: yAt(p.valor) - 16,
        w: larg, h: 13, text: txt, size: 8.5, bold: true, color: a.cor,
        align: daDireita ? 'right' : 'left',
      });
    }
  }

  // Eixo X: a POSIÇÃO no ano contratual, não o mês do calendário.
  for (let k = 1; k <= 12; k++) {
    out.push({ t: 'text', x: xAt(k) - 14, y: plot.y + plot.h + 8, w: 28, h: 13,
      text: String(k), size: 9, color: TINTA.muted, align: 'center' });
  }
  out.push({ t: 'line', x1: plot.x, y1: plot.y + plot.h, x2: plot.x + plot.w, y2: plot.y + plot.h, color: 'C6C6C6', w: 1 });

  // Anotação do estouro: triângulo apontando o ponto + caixa amarela por cima.
  if (c.estouro) {
    const serie = c.anos.find((a) => a.indice === c.estouro.anoIndice);
    if (serie) {
      const px = xAt(c.estouro.posicao);
      const py = yAt(c.estouro.valor);
      out.push({ t: 'poly', pts: [[px - 6, py - 20], [px + 6, py - 20], [px, py - 8]], close: true, fill: TINTA.alta });
      const larg = larguraTexto(c.estouro.texto, 9) + 14;
      const cx = Math.min(Math.max(px - larg / 2, plot.x), plot.x + plot.w - larg);
      out.push({ t: 'rect', x: cx, y: py - 48, w: larg, h: 24, fill: TINTA.atencao, line: 'D2A106', lineW: 0.75 });
      out.push({ t: 'text', x: cx, y: py - 42, w: larg, h: 14, text: c.estouro.texto, size: 9, bold: true, color: TINTA.ink, align: 'center' });
    }
  }

  out.push(...legenda([
    ...c.anos.map((a) => ({
      cor: a.cor,
      texto: a.mesesPlanejados > 0
        ? `${a.label} (${a.mesesComDado} medidos + ${a.mesesPlanejados} planejados)`
        : `${a.label} (${a.periodoLabel})`,
    })),
    ...(c.baseline ? [{ cor: '0072C3', dash: 'sysDash', texto: c.baseline.label }] : []),
  ], plot.x, caixa.y));

  out.push({ t: 'text', x: MARGEM, y: BASE - 26, w: LARGURA, h: 26, size: 8.5, color: TINTA.faint,
    lines: [
      { text: 'Eixo horizontal: posição do mês dentro do ano contratual (1 = primeiro mês do ano), para comparar o mesmo ponto do ciclo em anos diferentes.' },
      ...(c.estouro ? [{ text: `Estouro: no mês ${c.estouro.posicao}${c.estouro.planejado ? ' (trecho planejado)' : ''} o consumo acumulado do ${c.estouro.anoLabel} chega a ${nMsu(c.estouro.acumuladoMsu)} MSU e passa o baseline anual de ${nMsu(c.baseline.anualMsu)} MSU.` }] : []),
    ] });

  return { shapes: out };
}

/* ── Slide 3: consumido × planejado × contratado ─────────────────────────── */

function tabelaPlanejado(p, caixa, larg) {
  const cols = [larg * 0.26, larg * 0.19, larg * 0.19, larg * 0.19, larg * 0.17];
  const marcaBaseline = p.notas.find((n) => n.tipo === 'baseline');
  const marcaEstimado = p.notas.find((n) => n.tipo === 'estimado' || n.tipo === 'parcial');

  // Cabeçalho em duas linhas: "Consumido vs contratado" numa linha só não cabe
  // na coluna e o PowerPoint deixaria vazar por cima da vizinha, sem avisar.
  const duasLinhas = (a, b) => ({ lines: [{ text: a }, { text: b }], align: 'right' });
  const rows = [[
    { text: 'Ano contratual' },
    duasLinhas('Consumo', 'planejado'),
    duasLinhas('Baseline', 'contratado'),
    duasLinhas('MSUs', 'consumidas'),
    duasLinhas('Consumido vs', 'contratado'),
  ]];
  for (const a of p.anos) {
    rows.push([
      { text: `${a.label} (${a.periodoLabel})`, bold: true, size: 9 },
      { text: a.planejadoMsu > 0 ? nMsu(a.planejadoMsu) : '—', align: 'right', size: 9,
        color: a.planejadoMsu > 0 ? TINTA.ink : TINTA.faint },
      { text: nMsu(a.baselineZotcMsu) + (a.baselineIgualConsumoAnterior && marcaBaseline ? ` ${marcaBaseline.marca}` : ''),
        align: 'right', size: 9, ...(a.baselineIgualConsumoAnterior ? { fill: TINTA.destaque } : {}) },
      { text: nMsu(a.consumidasMsu) + ((a.estimado || a.parcialSemPlanejado) && marcaEstimado ? ` ${marcaEstimado.marca}` : ''),
        align: 'right', bold: true, size: 9, ...(a.estimado || a.parcialSemPlanejado ? { fill: TINTA.surface } : {}) },
      { text: nPct(a.vsContratadoPct), align: 'right', bold: true, size: 9,
        color: a.excedeBaseline ? TINTA.alta : TINTA.baixa },
    ]);
  }
  return { t: 'table', x: caixa.x, y: caixa.y, cols, headH: 30, rowH: 22, headSize: 8.5, rows };
}

function graficoBarrasAgrupadas(p, caixa) {
  const anos = p.anos;
  if (!anos.length) return [];
  const plot = { x: caixa.x + 66, y: caixa.y + 20, w: caixa.w - 76, h: caixa.h - 48 };
  const { yAt, grade } = escalaY(
    anos.flatMap((a) => [a.consumidasMsu, a.planejadoMsu, a.baselineZotcMsu]).filter((v) => v > 0),
    plot, { zero: true, divisoes: 4 }
  );

  const out = [...grade];
  const banda = plot.w / anos.length;
  const largBarra = Math.min(66, banda * 0.28);
  const vao = 8;

  anos.forEach((a, i) => {
    const centro = plot.x + banda * i + banda / 2;
    const par = [
      { valor: a.consumidasMsu, cor: '2E6BD4', rotulo: nMsu(a.consumidasMsu) },
      { valor: a.planejadoMsu, cor: 'ED7D31', rotulo: a.planejadoMsu > 0 ? nMsu(a.planejadoMsu) : '' },
    ];
    par.forEach((b, k) => {
      if (!(b.valor > 0)) return;
      const bx = centro - largBarra - vao / 2 + k * (largBarra + vao);
      const topo = yAt(b.valor);
      const altura = plot.y + plot.h - topo;
      /* O valor vai DENTRO da barra, em branco. Acima dela ele cruzaria a linha
         tracejada do baseline — que passa exatamente na faixa de altura em que os
         rótulos caem — e os dois ficariam ilegíveis. */
      const size = tamanhoQueCabe(b.rotulo, 8.5, largBarra - 4, { bold: true, piso: 6 });
      out.push({
        t: 'rect', x: bx, y: topo, w: largBarra, h: altura, fill: b.cor,
        ...(altura > 20 ? {
          text: b.rotulo, size, bold: true, color: 'FFFFFF',
          align: 'center', valign: 'top', padY: 5,
        } : {}),
      });
    });

    // Baseline contratado do ano: um degrau, não uma reta — ele muda por aditivo.
    if (a.baselineZotcMsu > 0) {
      const y = yAt(a.baselineZotcMsu);
      out.push({ t: 'line', x1: plot.x + banda * i + 6, y1: y, x2: plot.x + banda * (i + 1) - 6, y2: y, color: TINTA.alta, w: 1.75, dash: 'dash' });
    }
    out.push({ t: 'text', x: plot.x + banda * i, y: plot.y + plot.h + 6, w: banda, h: 13,
      text: a.label, size: 9, bold: true, color: TINTA.ink, align: 'center' });
  });

  out.push({ t: 'line', x1: plot.x, y1: plot.y + plot.h, x2: plot.x + plot.w, y2: plot.y + plot.h, color: 'C6C6C6', w: 1 });
  out.push(...legenda([
    { cor: '2E6BD4', tipo: 'area', texto: 'MSUs consumidas (SCRT)' },
    { cor: 'ED7D31', tipo: 'area', texto: 'Consumo planejado' },
    { cor: TINTA.alta, dash: 'dash', texto: 'Baseline contratado' },
  ], plot.x, caixa.y));
  return out;
}

function slidePlanejado(views, ctx) {
  const p = views.planejado;
  const base = [...moldura({ ...ctx, titulo: 'Consumo consolidado: consumido, planejado e contratado' })];
  if (!p.anos.length) {
    base.push({ t: 'text', x: MARGEM, y: TOPO, w: LARGURA, h: 20, size: 12, color: TINTA.muted,
      text: 'Nenhum ano contratual com consumo medido ou consumo planejado cadastrado.' });
    return { shapes: base };
  }

  const largTabela = LARGURA * 0.56;
  const out = [...base, tabelaPlanejado(p, { x: MARGEM, y: TOPO }, largTabela)];

  // Conclusão à direita da tabela: é o que o cliente lê primeiro.
  const xConc = MARGEM + largTabela + 22;
  const largConc = LARGURA - largTabela - 22;
  out.push({ t: 'text', x: xConc, y: TOPO, w: largConc, h: 16, text: 'Conclusão', size: 12, bold: true, color: TINTA.ink });
  out.push({
    t: 'text', x: xConc, y: TOPO + 20, w: largConc, h: 150,
    lines: p.conclusoes.map((c) => ({ text: c, bullet: true, size: 9.5, color: TINTA.ink, spaceBefore: 8, lineHeight: 1.2 })),
  });

  const yNotas = TOPO + 40 + 22 * p.anos.length;
  if (p.notas.length) {
    out.push({
      t: 'text', x: MARGEM, y: yNotas, w: largTabela, h: 34, size: 8, color: TINTA.muted,
      lines: p.notas.map((n) => ({ text: `${n.marca} ${n.texto}`, size: 8, color: TINTA.muted, spaceBefore: 2 })),
    });
  }

  out.push(...graficoBarrasAgrupadas(p, { x: MARGEM, y: 300, w: LARGURA, h: 182 }));
  return { shapes: out };
}

/* ── Montagem ────────────────────────────────────────────────────────────── */

const SLIDES = {
  1: { chave: 'ano', montar: slideAnoMlc, nome: 'Consumo Software MLC do ano' },
  2: { chave: 'comparativo', montar: slideComparativo, nome: 'Comparação de consumo por ano' },
  3: { chave: 'planejado', montar: slidePlanejado, nome: 'Consumido × planejado × contratado' },
};

/** Normaliza a escolha de slides: "1,3" -> [1,3]; vazio/ inválido -> os três. */
function slidesEscolhidos(quais) {
  const lista = (Array.isArray(quais) ? quais : String(quais || '').split(','))
    .map((v) => Number(String(v).trim()))
    .filter((n) => SLIDES[n]);
  const unicos = [...new Set(lista)].sort((a, b) => a - b);
  return unicos.length ? unicos : [1, 2, 3];
}

/**
 * Monta o .pptx do MLC.
 * @param {object} dados { client, views } — o mesmo payload de GET /clients/:id/mlc
 * @param {{ hoje?:Date, autor?:string, slides?:string|number[] }} opts
 */
function deckMlc({ client, views }, { hoje = new Date(), autor = 'IBM Z Control Desk', slides: quais } = {}) {
  if (!views) throw new Error('Sem visões de MLC para gerar a apresentação.');
  const escolhidos = slidesEscolhidos(quais);
  const total = escolhidos.length;
  const ctxBase = {
    sobretitulo: `${client.name} · Consumo de software`,
    rodape: `IBM Z Control Desk · ${views.anoMlc ? views.anoMlc.label : 'MLC'} · gerado em ${dataBr(hoje)}`,
    totalPaginas: total,
  };

  const shapes = escolhidos.map((n, i) => SLIDES[n].montar(views, { ...ctxBase, pagina: i + 1 }));

  const slug = String(client.name || 'cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'cliente';
  const carimbo = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

  return {
    buffer: buildPptx({
      title: `Consumo de software · ${client.name}`,
      author: autor,
      createdAt: hoje,
      slides: shapes,
    }),
    fileName: `consumo-software-${slug}-${carimbo}.pptx`,
    slides: escolhidos,
  };
}

module.exports = { deckMlc, slidesEscolhidos, slideAnoMlc, slideComparativo, slidePlanejado, SLIDES, TINTA };
