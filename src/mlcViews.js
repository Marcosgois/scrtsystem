'use strict';

/*
 * A visão de MLC que vai para a reunião: o ano de fatura, em R$.
 *
 * Não recalcula fatura — lê o que computeMlcView (src/mlc.js) já produziu mês a
 * mês. O que este módulo faz é FECHAR e ROTULAR: somar o ano e confrontar com os
 * tetos contratados. Assim a tela e o .pptx nunca discordam da conta.
 *
 * As visões de CONSUMO (comparativo de anos e planejado × contratado) NÃO estão
 * aqui: são em MSU, respondem "quanto se consome" e não "quanto se paga", e por
 * isso vivem em src/zotcViews.js, na tela de Consumo zOTC.
 *
 * DEFASAGEM MED/INV. O mês MEDIDO (o do SCRT) aparece no inventário/fatura alguns
 * meses depois: "Med/Jun 25" vira "Inv/Ago 25". Isso é ROTULAGEM, não conta — o
 * valor do mês continua sendo o do mês medido, e o total confrontado com o CAP é o
 * dos 12 meses medidos. Foi assim que a planilha de origem apurou (o mesmo
 * 266.849.449,67 aparece como total da tabela e como "Total CAP Consumido").
 *
 * ANO EM CURSO. Ano que ainda não fechou é completado com o CONSUMO PLANEJADO
 * cadastrado (plannedAnnualMsu / 12 por mês que falta) — não com a projeção
 * estatística do capacity planning. São coisas diferentes: planejado é número que
 * o cliente entrega, projeção é número que o modelo calcula.
 */

const { addMonths, labelOf } = require('./mlc');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (parte, todo) => (todo > 0 ? (parte / todo) * 100 : null);

/** "2025-06" + lag -> { key, label } do mês de inventário. */
function mesDeInventario(periodKey, lag) {
  const key = addMonths(periodKey, Math.round(num(lag)));
  return { key, label: labelOf(key) };
}

/** "Jun/25 a Mai/26" */
const faixa = (de, ate) => (de && ate ? `${labelOf(de)} a ${labelOf(ate)}` : '—');

/** Rótulo do CBA do ano: um só, ou a faixa quando um aditivo mudou no meio. */
function rotuloCba(ano) {
  const vistos = [...new Set(ano.months.map((m) => num(m.cbaPct)))];
  const fmt = (p) => `${(p * 100).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;
  if (vistos.length <= 1) return fmt(vistos[0] || 0);
  return `${fmt(vistos[0])} a ${fmt(vistos[vistos.length - 1])}`;
}

/* ── 1. Ano de MLC em R$ ─────────────────────────────────────────────────── */

/**
 * Fecha um ano do MLC: os 12 meses em R$, o total e o confronto com o CAP.
 * @param {object} view resultado de computeMlcView
 * @param {number} indice índice do ano (0-based)
 * @param {{ lag?: number, cadastro?: object }} opts `cadastro` é o year cru do
 *        contrato, de onde saem capAnualRs / capCbaRs (a view não os carrega).
 */
function visaoAnoMlc(view, indice, { lag = 2, cadastro = null } = {}) {
  const ano = view && view.years && view.years[indice];
  if (!ano) return null;

  const colunas = ano.months.map((m) => {
    const inv = mesDeInventario(m.periodKey, lag);
    return {
      medPeriodKey: m.periodKey,
      medLabel: m.label,
      invPeriodKey: inv.key,
      invLabel: inv.label,
      temScrt: m.source === 'scrt',
      consumoRs: m.monthlyWithGrowthRs,
      comCbaRs: m.withCbaRs,
      consumedMsu: m.consumedMsu,
      cbaPct: m.cbaPct,
    };
  });

  const totais = {
    consumoRs: ano.totals.monthlyWithGrowthRs,
    comCbaRs: ano.totals.withCbaRs,
    consumedMsu: ano.totals.consumedMsu,
    mesesComScrt: ano.totals.monthsWithScrt,
    mesesNoAno: colunas.length,
    fechado: ano.totals.monthsWithScrt === colunas.length,
  };

  const primeiraInv = colunas.length ? colunas[0].invPeriodKey : null;
  const ultimaInv = colunas.length ? colunas[colunas.length - 1].invPeriodKey : null;

  /* O CAP é opcional. Sem ele cadastrado o bloco inteiro some da tela e do slide —
     mostrar "Saldo: −266.849.449,67" porque o teto ficou em zero seria pior do que
     não mostrar nada. */
  const capAnualRs = num(cadastro && cadastro.capAnualRs);
  const capCbaRs = num(cadastro && cadastro.capCbaRs);
  const cap = capAnualRs > 0 ? {
    anualRs: capAnualRs,
    mensalRs: capAnualRs / 12,
    consumidoRs: totais.consumoRs,
    saldoRs: capAnualRs - totais.consumoRs,
    usoPct: pct(totais.consumoRs, capAnualRs),
    estourado: totais.consumoRs > capAnualRs,
    // A janela do CAP é a de INVENTÁRIO: é quando as faturas caem.
    janelaLabel: faixa(primeiraInv, ultimaInv),
    cba: capCbaRs > 0 ? {
      anualRs: capCbaRs,
      consumidoRs: totais.comCbaRs,
      saldoRs: capCbaRs - totais.comCbaRs,
      usoPct: pct(totais.comCbaRs, capCbaRs),
      estourado: totais.comCbaRs > capCbaRs,
      // O desconto que os dois tetos negociados implicam — quase 19%, nunca exato.
      descontoPct: pct(capAnualRs - capCbaRs, capAnualRs),
    } : null,
  } : null;

  return {
    indice,
    label: ano.label,
    firstPeriodKey: ano.firstPeriodKey,
    lastPeriodKey: ano.lastPeriodKey,
    periodoLabel: faixa(ano.firstPeriodKey, ano.lastPeriodKey),
    invFirstPeriodKey: primeiraInv,
    invLastPeriodKey: ultimaInv,
    invPeriodoLabel: faixa(primeiraInv, ultimaInv),
    lagMonths: Math.round(num(lag)),
    cbaLabel: rotuloCba(ano),
    baselineMensalMsu: ano.baselineMensalMsu,
    baselineAnnualMsu: ano.baselineAnnualMsu,
    temVariacaoDePreco: ano.temVariacao,
    trechos: ano.trechos,
    colunas,
    totais,
    cap,
  };
}

/**
 * A visão do ano escolhido, no formato que a tela e o .pptx consomem.
 * @param {object} view resultado de computeMlcView
 * @param {object} contract o contrato cru (de onde vêm os campos de cadastro)
 * @param {{ lag?: number, baselinePadraoAnual?: number, ano?: number }} opts
 */
function montarVisoes(view, contract, { lag = 2, ano = null } = {}) {
  const anosCadastro = (contract && contract.years) || [];
  const total = ((view && view.years) || []).length;
  // Sem ano escolhido, abre no último com SCRT — é o que interessa numa reunião.
  const comDados = ((view && view.years) || [])
    .map((y, i) => ({ i, n: y.totals.monthsWithScrt }))
    .filter((x) => x.n > 0);
  const escolhido = Number.isInteger(ano) && ano >= 0 && ano < total
    ? ano
    : (comDados.length ? comDados[comDados.length - 1].i : 0);

  return {
    anoSelecionado: escolhido,
    anosDisponiveis: ((view && view.years) || []).map((y, i) => ({
      indice: i,
      label: y.label,
      periodoLabel: faixa(y.firstPeriodKey, y.lastPeriodKey),
      mesesComScrt: y.totals.monthsWithScrt,
    })),
    anoMlc: visaoAnoMlc(view, escolhido, { lag, cadastro: anosCadastro[escolhido] }),
  };
}

module.exports = { montarVisoes, visaoAnoMlc, mesDeInventario, rotuloCba };
