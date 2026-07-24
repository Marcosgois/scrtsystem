'use strict';

/* Testa o cálculo de MLC com números sintéticos, conferíveis à mão. */

const assert = require('assert');
const { computeMlcView, addMonths, labelOf, somaEncargos } = require('../src/mlc');

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const perto = (a, b) => Math.abs(a - b) < 1e-6;

// --- utilitários de data ---
check('addMonths soma dentro do ano', addMonths('2024-06', 3) === '2024-09');
check('addMonths vira o ano', addMonths('2024-06', 12) === '2025-06');
check('addMonths atravessa dezembro', addMonths('2024-11', 2) === '2025-01');
check('labelOf formata pt-BR curto', labelOf('2024-06') === 'Jun/24');
check('somaEncargos soma a lista', somaEncargos([{ valorMensal: 1e6 }, { valorMensal: 5e5 }]) === 1.5e6);

// --- contrato sintético de 1 ano ---
// baseline anual 120.000.000 -> mensal 10.000.000 MSU
// valor por MSU = 2 -> baseline mensal R$ 20.000.000
// encargo de crescimento por MSU = 0,5 ; encargos fixos = 1.500.000 ; CBA 19%
const contract = {
  startPeriodKey: '2024-06',
  years: [{
    label: 'Ano 1',
    baselineAnnualMsu: 120000000,
    valorPorMsu: 2,
    encargoCrescimentoPorMsu: 0.5,
    cbaPct: 0.19,
    encargos: [{ nome: 'Dev/Test', valorMensal: 1000000 }, { nome: 'Produtos Flat', valorMensal: 500000 }],
  }],
};
// Só dois meses têm SCRT; o resto do ano fica sem consumo.
const consumo = { '2024-06': 12000000, '2024-07': 9000000 };

const view = computeMlcView(contract, consumo);
const ano = view.years[0];
const jun = ano.months[0];
const jul = ano.months[1];
const ago = ano.months[2];

check('a visão tem 1 ano e 12 meses', view.years.length === 1 && ano.months.length === 12);
check('baseline mensal MSU = anual/12', ano.baselineMensalMsu === 10000000);
check('baseline mensal R$ = mensal × valor por MSU', ano.baselineMensalRs === 20000000);
check('encargos fixos mensais somados', ano.encargosMensal === 1500000);

// Jun/24 consumo 12.000.000 (acima do baseline)
check('Jun: fonte é o SCRT', jun.source === 'scrt' && jun.consumedMsu === 12000000);
check('Jun: growth = consumo − baseline', jun.growth === 2000000);
check('Jun: encargo de crescimento = growth × 0,5', jun.growthChargeRs === 1000000);
// 20.000.000 + 1.000.000 + 1.500.000 = 22.500.000
check('Jun: consumo c/ growth R$', jun.monthlyWithGrowthRs === 22500000, jun.monthlyWithGrowthRs);
// 22.500.000 × 0,81 = 18.225.000
check('Jun: consumo com CBA (19%)', jun.withCbaRs === 18225000, jun.withCbaRs);

// Jul/24 consumo 9.000.000 (abaixo do baseline -> growth negativo)
check('Jul: growth negativo', jul.growth === -1000000);
// 20.000.000 + (-500.000) + 1.500.000 = 21.000.000
check('Jul: consumo c/ growth cai com growth negativo', jul.monthlyWithGrowthRs === 21000000, jul.monthlyWithGrowthRs);
check('Jul: consumo com CBA', perto(jul.withCbaRs, 21000000 * 0.81), jul.withCbaRs);

// Ago/24 sem SCRT -> nada calculado ("só meses com SCRT")
check('Ago: sem SCRT, fonte nula', ago.source === null && ago.consumedMsu === null);
check('Ago: cálculos ficam nulos', ago.growth === null && ago.monthlyWithGrowthRs === null && ago.withCbaRs === null);

// Totais do ano (somam só os meses com SCRT)
check('Total: conta 2 de 12 meses com SCRT', ano.totals.monthsWithScrt === 2 && ano.totals.monthsInYear === 12);
check('Total: MSU consumido = 12M + 9M', ano.totals.consumedMsu === 21000000);
check('Total: consumo c/ growth soma os 2 meses', ano.totals.monthlyWithGrowthRs === 22500000 + 21000000);
check('Total: baseline R$ conta só meses com dado', ano.totals.baselineMensalRs === 20000000 * 2);

// --- mapeamento de anos (2º ano começa 12 meses depois) ---
const c2 = { startPeriodKey: '2024-06', years: [{ baselineAnnualMsu: 12 }, { baselineAnnualMsu: 12 }] };
const v2 = computeMlcView(c2, {});
check('Ano 2 começa em Jun/25', v2.years[1].firstPeriodKey === '2025-06' && v2.years[1].lastPeriodKey === '2026-05');
check('rótulo do ano é gerado quando ausente', v2.years[1].label === 'Ano 2');

// --- contrato vazio não quebra ---
check('sem contrato devolve years vazio', computeMlcView({}, {}).years.length === 0);

console.log('');
if (failures) { console.error(`MLC: ${failures} teste(s) falharam`); process.exit(1); }
console.log('MLC: TODOS OS TESTES PASSARAM');
