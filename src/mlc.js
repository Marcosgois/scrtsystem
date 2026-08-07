'use strict';

/*
 * Modelo financeiro de MLC (Monthly License Charge).
 *
 * O contrato fixa, por ano, um Baseline anual de MSUs e alguns encargos; o
 * consumo mensal ("Machine MSU Consumed") vem do SCRT do cliente — é o único
 * valor que muda mês a mês. A partir daí:
 *
 *   Baseline mensal MSUs   = Baseline anual / 12
 *   Baseline mensal R$     = Baseline mensal MSUs × Valor por MSU
 *   Growth                 = Consumo (SCRT) − Baseline mensal MSUs
 *   Consumo c/ Growth R$   = Baseline mensal R$ + Growth × Encargo de Crescimento/MSU + Σ(encargos fixos)
 *   Consumo com CBA        = Consumo c/ Growth R$ × (1 − CBA%)
 *
 * As fórmulas foram conferidas contra a planilha da CAIXA (batem ao centavo).
 *
 * VIGÊNCIAS DE PREÇO. Um aditivo pode reajustar os valores NO MEIO do ano: jan a
 * mar com um preço, abr a dez com outro. Cada `year.vigencias[]` diz a partir de
 * que mês os valores dela passam a valer, e vale até o mês anterior à próxima.
 * O BASELINE não muda: ele é anual e continua no ano — o que o aditivo reajusta é
 * preço (valor por MSU, encargo de crescimento, CBA e encargos fixos).
 *
 * Os valores do próprio ano são o PRIMEIRO trecho, implicitamente. Por isso ano
 * sem vigência nenhuma — todos os contratos que já existem — calcula exatamente
 * como antes, e não há migração de dado nenhuma.
 */

const MESES_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

/** "2024-06" + n meses -> "2025-02". */
function addMonths(periodKey, delta) {
  const [y, m] = String(periodKey).split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** "2024-06" -> "Jun/24". */
function labelOf(periodKey) {
  const [y, m] = String(periodKey).split('-').map(Number);
  return `${MESES_PT[m - 1]}/${String(y).slice(-2)}`;
}

function somaEncargos(encargos) {
  return (encargos || []).reduce((a, e) => a + (Number(e.valorMensal) || 0), 0);
}

/**
 * Preço em vigor num mês do ano contratual.
 *
 * Base = o que está no próprio ano. Depois, a ÚLTIMA vigência cujo mês inicial já
 * passou substitui a base. Vigência sem `fromPeriodKey` é ignorada em vez de
 * derrubar a conta: contrato meio preenchido não pode deixar a fatura sem preço.
 */
function precoNoMes(yr, periodKey) {
  const base = {
    valorPorMsu: Number(yr.valorPorMsu) || 0,
    encargoCrescimentoPorMsu: Number(yr.encargoCrescimentoPorMsu) || 0,
    cbaPct: Number(yr.cbaPct) || 0,
    encargos: yr.encargos || [],
    vigenciaIndex: -1,          // -1 = os valores do próprio ano
    vigenciaFrom: null,
    notas: '',
  };
  const vs = (yr.vigencias || [])
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v && x.v.fromPeriodKey)
    .sort((a, b) => String(a.v.fromPeriodKey).localeCompare(String(b.v.fromPeriodKey)));

  let atual = base;
  for (const { v, i } of vs) {
    if (String(v.fromPeriodKey) > String(periodKey)) break;
    atual = {
      valorPorMsu: Number(v.valorPorMsu) || 0,
      encargoCrescimentoPorMsu: Number(v.encargoCrescimentoPorMsu) || 0,
      cbaPct: Number(v.cbaPct) || 0,
      encargos: v.encargos || [],
      vigenciaIndex: i,
      vigenciaFrom: v.fromPeriodKey,
      notas: v.notas || '',
    };
  }
  return atual;
}

/**
 * Monta a visão do contrato mês a mês.
 * @param contract { startPeriodKey, years: [{ label, baselineAnnualMsu, valorPorMsu,
 *                   encargoCrescimentoPorMsu, cbaPct, encargos: [{nome, valorMensal}] }] }
 * @param consumoByPeriod objeto/Map periodKey -> MSU consumido (do SCRT); ausente = mês sem SCRT.
 */
function computeMlcView(contract, consumoByPeriod) {
  const start = contract && contract.startPeriodKey;
  const fim = (contract && contract.endPeriodKey) || null;   // null = vigente
  const anos = (contract && contract.years) || [];
  if (!start || !anos.length) return { startPeriodKey: start || null, years: [] };

  const consumoDe = (k) => {
    if (!consumoByPeriod) return null;
    const v = consumoByPeriod instanceof Map ? consumoByPeriod.get(k) : consumoByPeriod[k];
    return v == null ? null : Number(v);
  };

  const years = anos.map((yr, i) => {
    const baselineAnnualMsu = Number(yr.baselineAnnualMsu) || 0;
    const valorPorMsu = Number(yr.valorPorMsu) || 0;
    const encargoCrescimentoPorMsu = Number(yr.encargoCrescimentoPorMsu) || 0;
    const cbaPct = Number(yr.cbaPct) || 0;
    // O baseline é ANUAL e do ano inteiro: a vigência reajusta preço, não volume.
    const baselineMensalMsu = baselineAnnualMsu / 12;
    const baselineMensalRs = baselineMensalMsu * valorPorMsu;   // do 1º trecho
    const encargosMensal = somaEncargos(yr.encargos);

    const months = [];
    for (let mi = 0; mi < 12; mi++) {
      const periodKey = addMonths(start, i * 12 + mi);
      // Contrato com fim definido não gera mês além dele (o último ano pode ser
      // parcial — ex.: contrato de 2 anos e meio).
      if (fim && periodKey > fim) break;
      // Cada mês usa o preço em vigor NELE. Sem vigência cadastrada isto devolve
      // os valores do próprio ano, e a conta é idêntica à de antes.
      const preco = precoNoMes(yr, periodKey);
      const mBaselineRs = baselineMensalMsu * preco.valorPorMsu;
      const mEncargos = somaEncargos(preco.encargos);
      const consumedMsu = consumoDe(periodKey);
      const has = consumedMsu != null;
      const growth = has ? consumedMsu - baselineMensalMsu : null;
      const growthChargeRs = has ? growth * preco.encargoCrescimentoPorMsu : null;
      const monthlyWithGrowthRs = has ? mBaselineRs + growthChargeRs + mEncargos : null;
      const withCbaRs = has ? monthlyWithGrowthRs * (1 - preco.cbaPct) : null;
      months.push({
        periodKey,
        label: labelOf(periodKey),
        baselineMensalMsu,
        consumedMsu,
        source: has ? 'scrt' : null,
        growth,
        baselineMensalRs: mBaselineRs,
        growthChargeRs,
        encargosRs: has ? mEncargos : null,
        monthlyWithGrowthRs,
        withCbaRs,
        // De qual trecho de preço veio este mês (-1 = os valores do próprio ano).
        vigenciaIndex: preco.vigenciaIndex,
        valorPorMsu: preco.valorPorMsu,
        encargoCrescimentoPorMsu: preco.encargoCrescimentoPorMsu,
        cbaPct: preco.cbaPct,
      });
    }

    const comDados = months.filter((m) => m.source === 'scrt');
    const soma = (campo) => comDados.reduce((a, m) => a + (m[campo] || 0), 0);
    const totals = {
      monthsWithScrt: comDados.length,
      monthsInYear: 12,
      consumedMsu: soma('consumedMsu'),
      // Soma mês a mês, e não baseline × contagem: com vigência o valor do mês muda.
      baselineMensalRs: soma('baselineMensalRs'),
      growthChargeRs: soma('growthChargeRs'),
      monthlyWithGrowthRs: soma('monthlyWithGrowthRs'),
      withCbaRs: soma('withCbaRs'),
    };

    /* Trechos de preço do ano, derivados dos MESES — e não da lista crua de
       vigências. É o que garante que o que a tela mostra é o que a conta usou:
       se uma vigência começar fora do ano, ela simplesmente não aparece aqui,
       porque nenhum mês a usou. O primeiro trecho são os valores do próprio ano. */
    const trechos = [];
    for (const m of months) {
      const ultimo = trechos[trechos.length - 1];
      if (ultimo && ultimo.vigenciaIndex === m.vigenciaIndex) {
        ultimo.toPeriodKey = m.periodKey;
        ultimo.meses += 1;
        continue;
      }
      trechos.push({
        vigenciaIndex: m.vigenciaIndex,
        doAno: m.vigenciaIndex === -1,
        fromPeriodKey: m.periodKey,
        toPeriodKey: m.periodKey,
        meses: 1,
        valorPorMsu: m.valorPorMsu,
        encargoCrescimentoPorMsu: m.encargoCrescimentoPorMsu,
        cbaPct: m.cbaPct,
        encargos: (m.vigenciaIndex === -1
          ? (yr.encargos || [])
          : ((yr.vigencias || [])[m.vigenciaIndex] || {}).encargos || []
        ).map((e) => ({ nome: e.nome, valorMensal: Number(e.valorMensal) || 0 })),
        notas: m.vigenciaIndex === -1 ? '' : (((yr.vigencias || [])[m.vigenciaIndex] || {}).notas || ''),
      });
    }
    for (const t of trechos) {
      t.encargosMensal = somaEncargos(t.encargos);
      t.label = t.fromPeriodKey === t.toPeriodKey
        ? labelOf(t.fromPeriodKey)
        : `${labelOf(t.fromPeriodKey)} a ${labelOf(t.toPeriodKey)}`;
    }

    return {
      label: yr.label || `Ano ${i + 1}`,
      trechos,
      temVariacao: trechos.length > 1,
      firstPeriodKey: addMonths(start, i * 12),
      lastPeriodKey: months.length ? months[months.length - 1].periodKey : addMonths(start, i * 12 + 11),
      baselineAnnualMsu,
      baselineMensalMsu,
      baselineMensalRs,
      valorPorMsu,
      encargoCrescimentoPorMsu,
      cbaPct,
      encargos: (yr.encargos || []).map((e) => ({ nome: e.nome, valorMensal: Number(e.valorMensal) || 0 })),
      encargosMensal,
      months,
      totals,
    };
  });

  return { startPeriodKey: start, years };
}

/**
 * Visão de VÁRIOS contratos em sequência (o caso real: um contrato acaba e entra
 * outro, e a contagem de anos reinicia). Cada contrato é calculado pela mesma
 * computeMlcView acima — o que muda é que os anos vêm rotulados com o nome do
 * contrato ("BRB 2023 · Ano 3"), então dois "Ano 1" nunca se confundem.
 *
 * @param contracts [{ _id, name, startPeriodKey, endPeriodKey, years }]
 */
function computeMlcViewMulti(contracts, consumoByPeriod) {
  const lista = (contracts || [])
    .filter((c) => c && c.startPeriodKey)
    .slice()
    .sort((a, b) => String(a.startPeriodKey).localeCompare(String(b.startPeriodKey)));

  const out = lista.map((c) => {
    const view = computeMlcView(c, consumoByPeriod);
    return {
      _id: c._id ? String(c._id) : null,
      name: c.name || `Contrato ${String(c.startPeriodKey).slice(0, 4)}`,
      startPeriodKey: c.startPeriodKey,
      endPeriodKey: c.endPeriodKey || null,
      vigente: !c.endPeriodKey,
      years: view.years.map((y, i) => ({
        ...y,
        yearIndex: i,                                    // 0-based dentro DESTE contrato
        contractName: c.name || `Contrato ${String(c.startPeriodKey).slice(0, 4)}`,
        // Rótulo completo, o que aparece no gráfico e nas tabelas.
        fullLabel: `${c.name || `Contrato ${String(c.startPeriodKey).slice(0, 4)}`} · ${y.label}`,
      })),
    };
  });

  return { contracts: out };
}

module.exports = { computeMlcView, computeMlcViewMulti, addMonths, labelOf, somaEncargos, MESES_PT };
