'use strict';

/*
 * O deck de consumo zOTC: as duas visões em MSU que vão para a reunião.
 *
 *   1. COMPARAÇÃO DE CONSUMO AO MÊS POR ANO — Ano 1 × Ano 2 × Ano 3 sobrepostos
 *      na régua de 1 a 12. O eixo é a POSIÇÃO do mês dentro do ano contratual,
 *      não o mês do calendário: é o que permite comparar o mesmo ponto do ciclo.
 *   2. CONSUMIDO × PLANEJADO × CONTRATADO — a tabela por ano, as barras
 *      agrupadas e a conclusão escrita a partir dos números.
 *
 * Recebe o MESMO objeto `views` que a tela de Consumo zOTC consome — nada é
 * recalculado no caminho, então slide e navegador não têm como discordar.
 *
 * Estas visões já moraram no deck de MLC. Saíram de lá porque são em MSU:
 * respondem "quanto se consome", não "quanto se paga".
 */

const { buildPptx, larguraTexto, tamanhoQueCabe } = require('./pptx');
const {
  TINTA, MARGEM, LARGURA, TOPO, BASE,
  nMsu, nPct, dataBr, moldura, escalaY, legenda, nomeDeArquivo,
} = require('./deckBase');

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
  1: { chave: 'comparativo', montar: slideComparativo, nome: 'Comparação de consumo por ano' },
  2: { chave: 'planejado', montar: slidePlanejado, nome: 'Consumido × planejado × contratado' },
};

/** Normaliza a escolha de slides: "2" -> [2]; vazio/inválido -> os dois. */
function slidesEscolhidos(quais) {
  const lista = (Array.isArray(quais) ? quais : String(quais || '').split(','))
    .map((v) => Number(String(v).trim()))
    .filter((n) => SLIDES[n]);
  const unicos = [...new Set(lista)].sort((a, b) => a - b);
  return unicos.length ? unicos : [1, 2];
}

/**
 * Monta o .pptx do consumo zOTC.
 * @param {object} dados { client, views } — o payload de GET /clients/:id/dashboard
 * @param {{ hoje?:Date, autor?:string, slides?:string|number[] }} opts
 */
function deckZotc({ client, views }, { hoje = new Date(), autor = 'IBM Z Control Desk', slides: quais } = {}) {
  if (!views) throw new Error('Sem visões de consumo para gerar a apresentação.');
  const escolhidos = slidesEscolhidos(quais);
  const ctxBase = {
    sobretitulo: `${client.name} · Análise de consumo de software zOTC`,
    rodape: `IBM Z Control Desk · consumo em MSU por ano contratual · gerado em ${dataBr(hoje)}`,
    totalPaginas: escolhidos.length,
  };
  const shapes = escolhidos.map((n, i) => SLIDES[n].montar(views, { ...ctxBase, pagina: i + 1 }));

  return {
    buffer: buildPptx({
      title: `Análise de consumo zOTC · ${client.name}`,
      author: autor,
      createdAt: hoje,
      slides: shapes,
    }),
    fileName: nomeDeArquivo('consumo-zotc', client.name, hoje),
    slides: escolhidos,
  };
}

module.exports = { deckZotc, slidesEscolhidos, slideComparativo, slidePlanejado, SLIDES };
