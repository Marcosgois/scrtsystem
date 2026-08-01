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
    const baselineMensalMsu = baselineAnnualMsu / 12;
    const baselineMensalRs = baselineMensalMsu * valorPorMsu;
    const encargosMensal = somaEncargos(yr.encargos);

    const months = [];
    for (let mi = 0; mi < 12; mi++) {
      const periodKey = addMonths(start, i * 12 + mi);
      // Contrato com fim definido não gera mês além dele (o último ano pode ser
      // parcial — ex.: contrato de 2 anos e meio).
      if (fim && periodKey > fim) break;
      const consumedMsu = consumoDe(periodKey);
      const has = consumedMsu != null;
      const growth = has ? consumedMsu - baselineMensalMsu : null;
      const growthChargeRs = has ? growth * encargoCrescimentoPorMsu : null;
      const monthlyWithGrowthRs = has ? baselineMensalRs + growthChargeRs + encargosMensal : null;
      const withCbaRs = has ? monthlyWithGrowthRs * (1 - cbaPct) : null;
      months.push({
        periodKey,
        label: labelOf(periodKey),
        baselineMensalMsu,
        consumedMsu,
        source: has ? 'scrt' : null,
        growth,
        baselineMensalRs,
        growthChargeRs,
        encargosRs: has ? encargosMensal : null,
        monthlyWithGrowthRs,
        withCbaRs,
      });
    }

    const comDados = months.filter((m) => m.source === 'scrt');
    const soma = (campo) => comDados.reduce((a, m) => a + (m[campo] || 0), 0);
    const totals = {
      monthsWithScrt: comDados.length,
      monthsInYear: 12,
      consumedMsu: soma('consumedMsu'),
      baselineMensalRs: baselineMensalRs * comDados.length,
      growthChargeRs: soma('growthChargeRs'),
      monthlyWithGrowthRs: soma('monthlyWithGrowthRs'),
      withCbaRs: soma('withCbaRs'),
    };

    return {
      label: yr.label || `Ano ${i + 1}`,
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
