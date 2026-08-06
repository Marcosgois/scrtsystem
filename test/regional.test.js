'use strict';

/* Agregação do painel gerencial. O que mais importa aqui: o total do recorte tem
   de bater com a soma das telas individuais — ou seja, respeitar a tag de máquina
   ignorada de CADA cliente antes de somar. */

const { agregarConsumo, agregarParque, agregarContratos, serieDoCliente, typeDaMaquina } = require('../src/regional');
const { mergeByMonth, tagContextOf } = require('../src/routes');

const helpers = { mergeByMonth, tagContextOf };

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

// Relatório mínimo no formato que o mergeByMonth espera.
const rel = (periodKey, maquinas) => ({
  periodKey,
  periodLabel: periodKey,
  totalMsuConsumed: maquinas.reduce((a, m) => a + m.msu, 0),
  machines: maquinas.map((m) => ({
    identifier: m.serial, serialNumber: m.serial, machineType: '3931',
    msuConsumed: m.msu, totalMsuConsumed: m.msu,
  })),
  lpars: [], containers: [],
});

// CAIXA tem uma máquina de produção e uma de dev/test IGNORADA.
const caixa = {
  _id: 'c1', name: 'CAIXA', monthlyBaselineMsu: 1000,
  machineTagDefs: [{ name: 'Produção', ignored: false }, { name: 'Dev/Test', ignored: true }],
  machineTags: [{ serial: 'PROD1', tag: 'Produção' }, { serial: 'DEV1', tag: 'Dev/Test' }],
  contractPeriods: [{ name: 'CAIXA 2024', startPeriodKey: '2024-06', endPeriodKey: null, years: [{}, {}] }],
};
const brb = {
  _id: 'c2', name: 'BRB', monthlyBaselineMsu: 500,
  machineTagDefs: [], machineTags: [], contractPeriods: [],
};

const reportsByClient = new Map([
  ['c1', [rel('2026-05', [{ serial: 'PROD1', msu: 100 }, { serial: 'DEV1', msu: 40 }]),
          rel('2026-06', [{ serial: 'PROD1', msu: 120 }, { serial: 'DEV1', msu: 30 }])]],
  ['c2', [rel('2026-05', [{ serial: 'X1', msu: 50 }]),
          rel('2026-06', [{ serial: 'X1', msu: 60 }])]],
]);

// ── A regra central: a máquina de tag ignorada NÃO entra ──
const serieCaixa = serieDoCliente(caixa, reportsByClient.get('c1'), helpers);
check('série do cliente exclui a máquina de tag ignorada (100, não 140)',
  serieCaixa.get('2026-05') === 100, serieCaixa.get('2026-05'));

const ag = agregarConsumo([caixa, brb], reportsByClient, helpers);
check('total de mai/2026 soma o faturável dos dois (100 + 50)',
  ag.evolucao.find((e) => e.periodKey === '2026-05').totalMsuConsumed === 150,
  ag.evolucao);
check('total de jun/2026 (120 + 60)',
  ag.evolucao.find((e) => e.periodKey === '2026-06').totalMsuConsumed === 180);
check('último mês do recorte é jun/2026 com 180',
  ag.ultimoPeriodKey === '2026-06' && ag.totalUltimoMes === 180, { k: ag.ultimoPeriodKey, v: ag.totalUltimoMes });

// A prova que dá credibilidade ao painel: soma das telas individuais == painel.
const somaIndividual = [caixa, brb]
  .map((c) => [...serieDoCliente(c, reportsByClient.get(String(c._id)), helpers).values()].reduce((a, b) => a + b, 0))
  .reduce((a, b) => a + b, 0);
check('total do painel BATE com a soma das telas individuais',
  ag.totalJanela === somaIndividual, { painel: ag.totalJanela, individual: somaIndividual });

// ── ranking ──
check('CAIXA lidera o ranking (220 x 110)',
  ag.top5[0].name === 'CAIXA' && ag.top5[0].totalMsuConsumed === 220, ag.top5);
check('percentuais somam 100', Math.round(ag.ranking.reduce((a, r) => a + r.pctDoTotal, 0)) === 100,
  ag.ranking.map((r) => r.pctDoTotal));

// ── parque por geração ──
const lifecycles = [
  { type: '3931', model: 'A01', family: 'z16', hwWdfm: '2025-12-31', coslEos: null },
  { type: '2964', model: 'Nnn', family: 'z13', hwWdfm: '2019-06-30', coslEos: '2024-12-31' },
];
const machines = [
  { model: '3931-7C6', status: 'ativa' },
  { model: '3931-7A1', status: 'dormente' },
  { model: '2964-N30', status: 'ativa' },
  { model: '9999-XXX', status: 'ativa' },        // sem ciclo de vida cadastrado
  { model: '3931-7C6', status: 'substituida' },  // fora do parque vivo
];
const parque = agregarParque(machines, lifecycles, { hoje: '2026-08-05' });
const z16 = parque.geracoes.find((g) => g.family === 'z16');
const z13 = parque.geracoes.find((g) => g.family === 'z13');
check('z16 conta 2 máquinas (1 dormente) e ignora a substituída',
  z16.quantidade === 2 && z16.dormentes === 1, z16);
check('z13 marcada como FORA DE SUPORTE (EOS dez/2024)', z13.foraDeSuporte === true, z13);
check('z16 não está fora de suporte (sem EOS anunciado)', z16.foraDeSuporte === false);
check('modelo sem ciclo de vida aparece separado', parque.geracoes.some((g) => g.semCicloDeVida), parque.geracoes.map((g) => g.family));
check('total do parque ignora substituída/desativada', parque.totalMaquinas === 4, parque.totalMaquinas);
check('conta as máquinas fora de suporte', parque.maquinasForaDeSuporte === 1, parque.maquinasForaDeSuporte);

// Cada cliente preenche o modelo do seu jeito: o BB gravou "IBM Z z16/700" (texto
// livre, sem o type) e a CAIXA gravou "3931". As duas são z16 e têm de cair no
// MESMO grupo — senão o parque aparece fatiado e sem o ciclo de vida.
const mistas = [
  { model: 'IBM Z z16/700', lsprModel: '3931-7C9', status: 'ativa' },   // BB
  { model: '3931', lsprModel: '', status: 'ativa' },                    // CAIXA
  { model: 'IBM z16 2022', lsprModel: '', status: 'ativa' },            // 2022 é o type do z900: NÃO vale
];
const pm = agregarParque(mistas, lifecycles, { hoje: '2026-08-05' });
const z16m = pm.geracoes.find((g) => g.family === 'z16');
check('modelo em texto livre entra pelo lsprModel e agrupa com o código puro',
  z16m && z16m.quantidade === 2, pm.geracoes);
check('4 dígitos no meio do texto não vira type', typeDaMaquina({ model: 'IBM z16 2022' }) === null);
check('lsprModel tem prioridade sobre o modelo', typeDaMaquina({ model: '8561', lsprModel: '3931-7C9' }) === '3931');

// ── contratos ──
const ct = agregarContratos([caixa, brb]);
check('1 cliente com contrato, 1 sem', ct.comContrato === 1 && ct.semContrato === 1, ct);
check('soma dos baselines (1000 + 500)', ct.baselineMensalTotal === 1500, ct.baselineMensalTotal);

if (failures) { console.error(`\nPAINEL GERENCIAL: ${failures} FALHA(S)`); process.exit(1); }
console.log('\nPAINEL GERENCIAL: TODOS OS TESTES PASSARAM');
