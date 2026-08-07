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

/* ── Vigências de preço dentro do ano ──────────────────────────────────────
   Um aditivo pode reajustar os valores no meio do ano: jan-mar com um preço,
   abr-dez com outro. O BASELINE não muda — ele é anual e do ano inteiro; o que
   o aditivo reajusta é preço. */
{
  const contrato = {
    startPeriodKey: '2026-01',
    years: [{
      baselineAnnualMsu: 120000, valorPorMsu: 2, encargoCrescimentoPorMsu: 0.5, cbaPct: 0.1,
      encargos: [{ nome: 'Flat', valorMensal: 100 }],
      vigencias: [{
        fromPeriodKey: '2026-04', valorPorMsu: 3, encargoCrescimentoPorMsu: 0.8, cbaPct: 0.2,
        encargos: [{ nome: 'Flat', valorMensal: 150 }], notas: 'Aditivo 1',
      }],
    }],
  };
  const consumo = {};
  for (let m = 1; m <= 12; m++) consumo[`2026-${String(m).padStart(2, '0')}`] = 12000;
  const ano = computeMlcView(contrato, consumo).years[0];
  const mes = (k) => ano.months.find((x) => x.periodKey === k);

  check('vigência: o baseline mensal é o MESMO o ano todo (o aditivo reajusta preço, não volume)',
    ano.months.every((m) => m.baselineMensalMsu === 10000), ano.months.map((m) => m.baselineMensalMsu));

  // Antes do aditivo: 10.000 × 2 = 20.000 · growth 2.000 × 0,5 = 1.000 · flat 100
  check('vigência: março ainda usa o preço do ano (18.990)',
    mes('2026-03').baselineMensalRs === 20000 && mes('2026-03').growthChargeRs === 1000
    && mes('2026-03').encargosRs === 100 && Math.abs(mes('2026-03').withCbaRs - 18990) < 1e-9, mes('2026-03'));

  // A partir do aditivo: 10.000 × 3 = 30.000 · growth 2.000 × 0,8 = 1.600 · flat 150
  check('vigência: abril já usa o preço novo (25.400)',
    mes('2026-04').baselineMensalRs === 30000 && mes('2026-04').growthChargeRs === 1600
    && mes('2026-04').encargosRs === 150 && Math.abs(mes('2026-04').withCbaRs - 25400) < 1e-9, mes('2026-04'));

  check('vigência: o total do ano soma os dois preços, não um deles vezes 12',
    Math.abs(ano.totals.withCbaRs - (18990 * 3 + 25400 * 9)) < 1e-6, ano.totals.withCbaRs);

  check('vigência: os trechos saem descritos para a tela',
    ano.temVariacao === true && ano.trechos.length === 2
    && ano.trechos[0].label === 'Jan/26 a Mar/26' && ano.trechos[0].doAno === true
    && ano.trechos[1].label === 'Abr/26 a Dez/26' && ano.trechos[1].notas === 'Aditivo 1',
    ano.trechos.map((t) => t.label));

  check('vigência: cada mês diz de que trecho veio',
    mes('2026-03').vigenciaIndex === -1 && mes('2026-04').vigenciaIndex === 0);
}

{
  // Ano SEM vigência tem de calcular exatamente como antes — é o caso de todos
  // os contratos que já existem, e não pode haver migração de dado.
  const semVig = {
    startPeriodKey: '2026-01',
    years: [{ baselineAnnualMsu: 120000, valorPorMsu: 2, encargoCrescimentoPorMsu: 0.5, cbaPct: 0.1, encargos: [{ nome: 'Flat', valorMensal: 100 }] }],
  };
  const comVigVazia = JSON.parse(JSON.stringify(semVig));
  comVigVazia.years[0].vigencias = [];
  const consumo = { '2026-01': 12000, '2026-02': 12000 };
  const a = computeMlcView(semVig, consumo).years[0];
  const b = computeMlcView(comVigVazia, consumo).years[0];
  check('sem vigência: a conta não muda em nada',
    JSON.stringify(a.months) === JSON.stringify(b.months) && a.temVariacao === false && a.trechos.length === 1,
    { totalA: a.totals.withCbaRs, totalB: b.totals.withCbaRs });

  // Duas vigências: o mês pega a ÚLTIMA que já começou, não a primeira.
  const tres = JSON.parse(JSON.stringify(semVig));
  tres.years[0].vigencias = [
    { fromPeriodKey: '2026-04', valorPorMsu: 3, encargoCrescimentoPorMsu: 0, cbaPct: 0, encargos: [] },
    { fromPeriodKey: '2026-09', valorPorMsu: 5, encargoCrescimentoPorMsu: 0, cbaPct: 0, encargos: [] },
  ];
  const c12 = {};
  for (let m = 1; m <= 12; m++) c12[`2026-${String(m).padStart(2, '0')}`] = 10000;
  const y = computeMlcView(tres, c12).years[0];
  const rs = (k) => y.months.find((x) => x.periodKey === k).baselineMensalRs;
  check('três trechos: cada mês pega a última vigência que já começou',
    rs('2026-03') === 20000 && rs('2026-08') === 30000 && rs('2026-12') === 50000,
    { mar: rs('2026-03'), ago: rs('2026-08'), dez: rs('2026-12') });

  // Fora de ordem no array não pode mudar o resultado.
  const foraDeOrdem = JSON.parse(JSON.stringify(tres));
  foraDeOrdem.years[0].vigencias.reverse();
  const y2 = computeMlcView(foraDeOrdem, c12).years[0];
  // O vigenciaIndex É a posição no array, então reordenar muda ele de propósito.
  // O que não pode mudar é o dinheiro.
  const dinheiro = (v) => v.months.map((m) => [m.periodKey, m.baselineMensalRs, m.growthChargeRs, m.encargosRs, m.withCbaRs]);
  check('vigências fora de ordem no array dão o mesmo resultado financeiro',
    JSON.stringify(dinheiro(y)) === JSON.stringify(dinheiro(y2)));
}

// O guard fica no FIM: com ele no meio do arquivo, todo teste escrito depois
// não era contado e a suíte dizia "passou" com falha na tela.
if (failures) { console.error(`MLC: ${failures} teste(s) falharam`); process.exit(1); }
console.log('MLC: TODOS OS TESTES PASSARAM');
