'use strict';

/*
 * Fechamento anual do capacity planning.
 *
 * A MESMA série mensal (histórico real + meses projetados) é fechada de dois
 * jeitos, porque são duas perguntas diferentes:
 *
 *   - ANO CALENDÁRIO (jan–dez): como o cliente monta orçamento.
 *   - ANO CONTRATUAL: como a IBM fatura. É só aqui que "% do baseline" quer
 *     dizer alguma coisa — o baseline é anual e do contrato, então comparar
 *     jan–dez com o teto de um contrato que vai de jun a mai mistura dois anos
 *     de compromisso e dá um número que não existe em lugar nenhum.
 *
 * Toda linha carrega a COMPOSIÇÃO (quantos meses são reais, quantos projetados).
 * Sem isso, um ano com dois meses de SCRT e dez de projeção apareceria na
 * apresentação com o mesmo peso de um ano fechado.
 *
 * A regra de "que contrato/ano cobre este mês" NÃO é reimplementada aqui: vem de
 * contractPeriods.js, a mesma que o dashboard e o MLC usam.
 */

const { groupByContractYear, normalizar, keyToAbs, absToKey } = require('./contractPeriods');

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

/** "2026-06" -> "Jun/26" */
function rotuloCurto(k) {
  const [y, m] = String(k).split('-').map(Number);
  if (!MESES[m - 1]) return String(k);
  return `${MESES[m - 1]}/${String(y).slice(-2)}`;
}

/** Histórico + projeção numa série só, cada mês marcado com a origem. */
function serieUnificada(history, points) {
  return [
    ...(history || []).map((h) => ({
      periodKey: h.periodKey,
      totalMsuConsumed: Number(h.totalMsuConsumed) || 0,
      origem: 'real',
    })),
    ...(points || []).map((p) => ({
      periodKey: p.periodKey,
      totalMsuConsumed: Number(p.value) || 0,
      origem: 'proj',
    })),
  ];
}

function compor(meses) {
  let realMsu = 0;
  let realMonths = 0;
  let projMsu = 0;
  let projMonths = 0;
  for (const m of meses) {
    const v = Number(m.totalMsuConsumed) || 0;
    if (m.origem === 'proj') { projMsu += v; projMonths++; } else { realMsu += v; realMonths++; }
  }
  return { realMsu, realMonths, projMsu, projMonths, totalMsu: realMsu + projMsu, months: meses.length };
}

function comBaseline(row, baseline) {
  const anual = baseline ? baseline * 12 : null;
  return { ...row, annualBaselineMsu: anual, vsBaselinePct: anual ? (row.totalMsu / anual) * 100 : null };
}

/* Crescimento só entre anos COMPLETOS e consecutivos: comparar um ano cheio com
   um pedaço de ano produz "queda de 60%" onde não houve queda nenhuma. */
function anexarCrescimento(rows) {
  for (let i = 0; i < rows.length; i++) {
    const ant = rows[i - 1];
    rows[i].growthPct = ant && ant.complete && rows[i].complete && ant.totalMsu > 0
      ? ((rows[i].totalMsu - ant.totalMsu) / ant.totalMsu) * 100
      : null;
  }
  return rows;
}

/** Fechamento por ano-calendário. */
function porAnoCalendario(serie, baseline) {
  const porAno = new Map();
  for (const s of serie || []) {
    const ano = Number(String(s.periodKey).slice(0, 4));
    if (!Number.isFinite(ano)) continue;
    if (!porAno.has(ano)) porAno.set(ano, []);
    porAno.get(ano).push(s);
  }
  const rows = [...porAno.entries()].sort((a, b) => a[0] - b[0]).map(([year, meses]) => {
    const c = compor(meses);
    return comBaseline({ year, ...c, complete: c.months === 12 }, baseline);
  });
  return anexarCrescimento(rows);
}

/*
 * Meses fora de qualquer contrato chegam do groupByContractYear num balde só —
 * o que juntaria "antes do primeiro contrato" com "depois do último", e a linha
 * sairia com um intervalo sem sentido (Jan/24–Mai/28). Aqui esse balde é quebrado
 * em trechos de meses CONSECUTIVOS, que é como esses buracos realmente aparecem.
 */
function fatiarForaDeContrato(grupo) {
  const trechos = [];
  let atual = null;
  for (const m of grupo.months) {
    const abs = keyToAbs(m.periodKey);
    if (atual && abs === atual.fim + 1) { atual.months.push(m); atual.fim = abs; continue; }
    atual = { ...grupo, months: [m], fim: abs };
    trechos.push(atual);
  }
  return trechos.map((t) => ({
    ...t,
    firstPeriodKey: t.months[0].periodKey,
    lastPeriodKey: t.months[t.months.length - 1].periodKey,
  }));
}

/**
 * Fechamento por ano contratual.
 * @returns {{ rows: Array, hasContracts: boolean }}
 *
 * Meses fora de qualquer contrato (antes do primeiro início, num buraco entre
 * contratos, ou depois do último fim — a projeção costuma passar do fim da
 * vigência) viram linhas próprias, marcadas com `inContract:false`. Somá-los ao
 * ano contratual vizinho inflaria um ano que o contrato nem cobre.
 */
function porAnoContratual(serie, contracts, baseline) {
  const lista = normalizar(contracts);
  if (!lista.length) return { rows: [], hasContracts: false };

  const grupos = groupByContractYear(serie || [], lista)
    .flatMap((g) => (g.yearIndex >= 0 ? [g] : fatiarForaDeContrato(g)));

  const rows = grupos.map((g) => {
    const dentro = g.yearIndex >= 0;
    // A janela do ano vem do CONTRATO (12 meses a partir do início), não dos meses
    // que têm dado: senão um ano com 3 meses apareceria como se durasse 3 meses.
    let firstKey = g.firstPeriodKey;
    let lastKey = g.lastPeriodKey;
    if (dentro && g.contractStart) {
      const ini = keyToAbs(g.contractStart) + g.yearIndex * 12;
      firstKey = absToKey(ini);
      lastKey = absToKey(ini + 11);
    }
    const c = compor(g.months);
    return comBaseline({
      contractId: g.contractId,
      contractName: g.contractName,
      yearIndex: g.yearIndex,
      label: g.label,
      fullLabel: g.fullLabel,
      inContract: dentro,
      firstPeriodKey: firstKey,
      lastPeriodKey: lastKey,
      rangeLabel: firstKey && lastKey ? `${rotuloCurto(firstKey)}–${rotuloCurto(lastKey)}` : '–',
      ...c,
      complete: dentro && c.months === 12,
    }, baseline);
  });

  /* Ordem cronológica pura — a tabela é uma linha do tempo, e um trecho "fora de
     contrato" jogado para o fim daria a impressão de vir DEPOIS do último ano.
     Não dá para ordenar pelo id do contrato (o cliente que só tem o mês-âncora
     não tem id nenhum): a chave é o primeiro mês do trecho. */
  rows.sort((a, b) => String(a.firstPeriodKey || '').localeCompare(String(b.firstPeriodKey || '')));

  return { rows: anexarCrescimento(rows), hasContracts: true };
}

module.exports = { serieUnificada, porAnoCalendario, porAnoContratual, rotuloCurto };
