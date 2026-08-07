'use strict';

/*
 * O deck de MLC: o ano de fatura em R$ — os 12 meses com a defasagem Med/Inv, o
 * CAP contratado e o gráfico contra o CAP mensal.
 *
 * Recebe o MESMO objeto `views` que a tela do módulo MLC consome; nada é
 * recalculado no caminho. As visões de CONSUMO (MSU) saíram daqui: viraram o
 * deck de src/deckZotc.js, na tela de Consumo zOTC.
 */

const { buildPptx, larguraTexto, tamanhoQueCabe } = require('./pptx');
const {
  TINTA, MARGEM, LARGURA, TOPO, BASE,
  nRs, nPct, dataBr, moldura, escalaY, legenda, nomeDeArquivo,
} = require('./deckBase');

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

/**
 * Monta o .pptx do MLC (um slide: o ano de fatura).
 * @param {object} dados { client, views } — o mesmo payload de GET /clients/:id/mlc
 */
function deckMlc({ client, views }, { hoje = new Date(), autor = 'IBM Z Control Desk' } = {}) {
  if (!views) throw new Error('Sem visões de MLC para gerar a apresentação.');
  const ctx = {
    sobretitulo: `${client.name} · Consumo de software`,
    rodape: `IBM Z Control Desk · ${views.anoMlc ? views.anoMlc.label : 'MLC'} · gerado em ${dataBr(hoje)}`,
    totalPaginas: 1,
    pagina: 1,
  };
  return {
    buffer: buildPptx({
      title: `Consumo Software MLC · ${client.name}`,
      author: autor,
      createdAt: hoje,
      slides: [slideAnoMlc(views, ctx)],
    }),
    fileName: nomeDeArquivo('consumo-mlc', client.name, hoje),
  };
}

module.exports = { deckMlc, slideAnoMlc };
