'use strict';

/* Períodos contratuais: a contagem de anos reinicia a cada contrato novo.
   Caso real que motivou tudo (BRB): âncora em mai/2023 fazia mai/2026 aparecer
   como "Ano 4", quando é o "Ano 1" do contrato seguinte. */

const cp = require('../src/contractPeriods');
const { computeMlcViewMulti } = require('../src/mlc');

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

// BRB: contrato 1 de mai/2023 a abr/2026, contrato 2 a partir de mai/2026.
const BRB = [
  { _id: 'c1', name: 'BRB 2023', startPeriodKey: '2023-05', endPeriodKey: '2026-04', years: [] },
  { _id: 'c2', name: 'BRB 2026', startPeriodKey: '2026-05', endPeriodKey: null, years: [] },
];

// ── resolveMonth ──
const r1 = cp.resolveMonth(BRB, '2023-05');
check('1º mês do contrato 1 é Ano 1', r1 && r1.yearIndex === 0 && r1.fullLabel === 'BRB 2023 · Ano 1', r1 && r1.fullLabel);
const r2 = cp.resolveMonth(BRB, '2025-05');
check('mai/2025 é Ano 3 do contrato 1', r2 && r2.fullLabel === 'BRB 2023 · Ano 3', r2 && r2.fullLabel);
const r3 = cp.resolveMonth(BRB, '2026-04');
check('abr/2026 (último mês) ainda é Ano 3 do contrato 1', r3 && r3.fullLabel === 'BRB 2023 · Ano 3', r3 && r3.fullLabel);

// O CORAÇÃO DO PEDIDO: mai/2026 tem de ser Ano 1 do contrato NOVO, não "Ano 4".
const r4 = cp.resolveMonth(BRB, '2026-05');
check('mai/2026 vira Ano 1 do contrato 2 (e NÃO "Ano 4")',
  r4 && r4.contract._id === 'c2' && r4.yearIndex === 0 && r4.fullLabel === 'BRB 2026 · Ano 1', r4 && r4.fullLabel);
const r5 = cp.resolveMonth(BRB, '2027-05');
check('mai/2027 é Ano 2 do contrato 2', r5 && r5.fullLabel === 'BRB 2026 · Ano 2', r5 && r5.fullLabel);

// Antes de tudo e em intervalo sem contrato
check('mês anterior ao 1º contrato fica fora', cp.resolveMonth(BRB, '2023-04') === null);
const comBuraco = [
  { _id: 'a', name: 'A', startPeriodKey: '2020-01', endPeriodKey: '2020-12', years: [] },
  { _id: 'b', name: 'B', startPeriodKey: '2022-01', endPeriodKey: null, years: [] },
];
check('mês no intervalo sem contrato fica fora', cp.resolveMonth(comBuraco, '2021-06') === null);

// ── groupByContractYear ──
const serie = [
  { periodKey: '2026-03', totalMsuConsumed: 10 },
  { periodKey: '2026-04', totalMsuConsumed: 20 },
  { periodKey: '2026-05', totalMsuConsumed: 30 },   // contrato novo
  { periodKey: '2026-06', totalMsuConsumed: 40 },
];
const g = cp.groupByContractYear(serie, BRB);
check('a série vira 2 grupos (fim do contrato 1 + início do 2)', g.length === 2, g.map((x) => x.fullLabel));
const gC1 = g.find((x) => x.contractId === 'c1');
const gC2 = g.find((x) => x.contractId === 'c2');
check('grupo do contrato 1 soma 30 (10+20)', gC1 && gC1.total === 30, gC1 && gC1.total);
check('grupo do contrato 2 soma 70 (30+40)', gC2 && gC2.total === 70, gC2 && gC2.total);
check('o acumulado ZERA no contrato novo', gC2 && gC2.accByKey['2026-05'] === 30, gC2 && gC2.accByKey);
check('rótulos não se confundem', gC1.fullLabel === 'BRB 2023 · Ano 3' && gC2.fullLabel === 'BRB 2026 · Ano 1',
  [gC1.fullLabel, gC2.fullLabel]);

const gFora = cp.groupByContractYear([{ periodKey: '2019-01', totalMsuConsumed: 5 }], BRB);
check('mês fora de contrato vai para o grupo "Fora de contrato"',
  gFora.length === 1 && gFora[0].contractId === null && gFora[0].label === 'Fora de contrato', gFora[0] && gFora[0].label);

// ── validar ──
check('lista válida passa', cp.validar(BRB) === null, cp.validar(BRB));
check('sobreposição é recusada',
  /sobrep/i.test(cp.validar([
    { name: 'A', startPeriodKey: '2023-01', endPeriodKey: '2024-06' },
    { name: 'B', startPeriodKey: '2024-01' },
  ]) || ''));
check('contrato anterior sem fim é recusado',
  /sem fim/i.test(cp.validar([
    { name: 'A', startPeriodKey: '2023-01', endPeriodKey: null },
    { name: 'B', startPeriodKey: '2026-01' },
  ]) || ''));
check('fim antes do início é recusado',
  /antes de começar/i.test(cp.validar([{ name: 'A', startPeriodKey: '2024-06', endPeriodKey: '2024-01' }]) || ''));
check('buraco entre contratos é PERMITIDO', cp.validar(comBuraco) === null, cp.validar(comBuraco));

// ── contratoVigente ──
check('vigente é o contrato sem fim', (cp.contratoVigente(BRB) || {})._id === 'c2');

// ── MLC com vários contratos ──
const ano = { baselineAnnualMsu: 1200, valorPorMsu: 2, encargoCrescimentoPorMsu: 1, cbaPct: 0, encargos: [] };
const mlcMulti = computeMlcViewMulti([
  { _id: 'c1', name: 'BRB 2023', startPeriodKey: '2023-05', endPeriodKey: '2024-04', years: [ano] },
  { _id: 'c2', name: 'BRB 2024', startPeriodKey: '2024-05', endPeriodKey: null, years: [ano] },
], { '2023-05': 100, '2024-05': 200 });
check('MLC devolve os dois contratos', mlcMulti.contracts.length === 2, mlcMulti.contracts.length);
check('cada contrato reinicia em Ano 1',
  mlcMulti.contracts.every((c) => c.years[0].label === 'Ano 1'), mlcMulti.contracts.map((c) => c.years[0].label));
check('o rótulo completo distingue os dois',
  mlcMulti.contracts[0].years[0].fullLabel === 'BRB 2023 · Ano 1'
  && mlcMulti.contracts[1].years[0].fullLabel === 'BRB 2024 · Ano 1',
  mlcMulti.contracts.map((c) => c.years[0].fullLabel));
check('contrato com fim não gera mês além dele',
  mlcMulti.contracts[0].years[0].lastPeriodKey === '2024-04', mlcMulti.contracts[0].years[0].lastPeriodKey);
check('contrato vigente é marcado', mlcMulti.contracts[1].vigente === true && mlcMulti.contracts[0].vigente === false);

if (failures) { console.error(`\nPERÍODOS CONTRATUAIS: ${failures} FALHA(S)`); process.exit(1); }
console.log('\nPERÍODOS CONTRATUAIS: TODOS OS TESTES PASSARAM');
