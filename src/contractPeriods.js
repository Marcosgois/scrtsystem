'use strict';

/*
 * Períodos contratuais do cliente (zOTC/MLC).
 *
 * Antes existia um mês-âncora único e os anos saíam em blocos de 12 meses ao
 * infinito. Quando o contrato acabava e entrava outro, o "Ano 1" do novo aparecia
 * como "Ano 4" — foi o que aconteceu no BRB. Agora o cliente tem uma LISTA de
 * contratos em sequência e a contagem de anos reinicia em cada um.
 *
 * Este módulo é a ÚNICA fonte da regra "que contrato/ano cobre este mês", para o
 * dashboard (zOTC) e o MLC nunca divergirem.
 */

const keyToAbs = (k) => { const [y, m] = String(k).split('-').map(Number); return y * 12 + (m - 1); };
const absToKey = (a) => `${Math.floor(a / 12)}-${String((a % 12) + 1).padStart(2, '0')}`;
const ehChave = (k) => /^\d{4}-\d{2}$/.test(String(k || ''));

/** Ordena por início e normaliza. Contrato sem início válido é descartado. */
function normalizar(contracts) {
  return (contracts || [])
    .filter((c) => c && ehChave(c.startPeriodKey))
    .map((c) => ({
      _id: c._id ? String(c._id) : null,
      name: String(c.name || `Contrato ${String(c.startPeriodKey).slice(0, 4)}`).trim(),
      startPeriodKey: c.startPeriodKey,
      endPeriodKey: ehChave(c.endPeriodKey) ? c.endPeriodKey : null,
      years: c.years || [],
    }))
    .sort((a, b) => a.startPeriodKey.localeCompare(b.startPeriodKey));
}

/**
 * Em que contrato/ano cai um mês.
 * @returns { contract, yearIndex (0-based), label, fullLabel } ou null se o mês
 *          estiver fora de todos os contratos (intervalo sem contrato é permitido).
 */
function resolveMonth(contracts, periodKey) {
  if (!ehChave(periodKey)) return null;
  const abs = keyToAbs(periodKey);
  for (const c of normalizar(contracts)) {
    const ini = keyToAbs(c.startPeriodKey);
    if (abs < ini) continue;
    if (c.endPeriodKey && abs > keyToAbs(c.endPeriodKey)) continue;
    const yearIndex = Math.floor((abs - ini) / 12);
    const label = `Ano ${yearIndex + 1}`;
    return { contract: c, yearIndex, label, fullLabel: `${c.name} · ${label}` };
  }
  return null;
}

/**
 * Agrupa uma série mensal nos anos de cada contrato, acumulando o consumo DENTRO
 * de cada ano (o acumulado zera a cada ano, como o contrato manda).
 *
 * @param series [{ periodKey, totalMsuConsumed, ... }]
 * @returns [{ contractId, contractName, yearIndex, label, fullLabel,
 *             firstPeriodKey, lastPeriodKey, months, accByKey, total }]
 *          Os meses fora de qualquer contrato caem num grupo com contractId null.
 */
function groupByContractYear(series, contracts) {
  const grupos = new Map();
  const chave = (r) => (r ? `${r.contract._id || r.contract.name}#${r.yearIndex}` : 'sem-contrato');

  for (const s of series || []) {
    const r = resolveMonth(contracts, s.periodKey);
    const k = chave(r);
    if (!grupos.has(k)) {
      grupos.set(k, {
        contractId: r ? r.contract._id : null,
        contractName: r ? r.contract.name : null,
        contractStart: r ? r.contract.startPeriodKey : null,
        yearIndex: r ? r.yearIndex : -1,
        label: r ? r.label : 'Fora de contrato',
        fullLabel: r ? r.fullLabel : 'Fora de contrato',
        months: [],
      });
    }
    grupos.get(k).months.push(s);
  }

  const saida = [...grupos.values()];
  for (const g of saida) {
    g.months.sort((a, b) => String(a.periodKey).localeCompare(String(b.periodKey)));
    let acc = 0;
    g.accByKey = {};
    for (const m of g.months) { acc += Number(m.totalMsuConsumed) || 0; g.accByKey[m.periodKey] = acc; }
    g.total = acc;
    g.firstPeriodKey = g.months.length ? g.months[0].periodKey : null;
    g.lastPeriodKey = g.months.length ? g.months[g.months.length - 1].periodKey : null;
  }

  // Ordem cronológica; "fora de contrato" sempre por último para não poluir o começo.
  return saida.sort((a, b) => {
    if (!a.contractId !== !b.contractId) return a.contractId ? -1 : 1;
    return String(a.firstPeriodKey || '').localeCompare(String(b.firstPeriodKey || ''));
  });
}

/** O contrato vigente (sem fim) ou, na falta, o de início mais recente. */
function contratoVigente(contracts) {
  const lista = normalizar(contracts);
  if (!lista.length) return null;
  return lista.filter((c) => !c.endPeriodKey).pop() || lista[lista.length - 1];
}

/**
 * Valida a lista inteira. Sobreposição é erro (um mês não pode pertencer a dois
 * contratos); buraco entre contratos é permitido de propósito.
 */
function validar(contracts) {
  const lista = normalizar(contracts);
  for (const c of lista) {
    if (!c.name) return 'Todo contrato precisa de um nome.';
    if (c.endPeriodKey && c.endPeriodKey < c.startPeriodKey) {
      return `O contrato "${c.name}" termina antes de começar.`;
    }
  }
  for (let i = 0; i < lista.length - 1; i++) {
    const atual = lista[i];
    const proximo = lista[i + 1];
    if (!atual.endPeriodKey) {
      return `O contrato "${atual.name}" está sem fim, mas "${proximo.name}" começa depois dele. Informe o mês final de "${atual.name}".`;
    }
    if (atual.endPeriodKey >= proximo.startPeriodKey) {
      return `Os contratos "${atual.name}" e "${proximo.name}" se sobrepõem.`;
    }
  }
  return null;
}

module.exports = { normalizar, resolveMonth, groupByContractYear, contratoVigente, validar, keyToAbs, absToKey };
