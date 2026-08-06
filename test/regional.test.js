'use strict';

/* Agregação do painel gerencial. O que mais importa aqui: o total do recorte tem
   de bater com a soma das telas individuais — ou seja, respeitar a tag de máquina
   ignorada de CADA cliente antes de somar. */

const {
  agregarConsumo, agregarParque, agregarContratos, serieDoCliente,
  typeDaMaquina, indexarCicloDeVida, cicloDaMaquina,
} = require('../src/regional');
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

// ── um type com MAIS DE UMA linha de ciclo de vida ──
// 9176 é z17 MER (rack mount) e z17 ME2, 3932 é z16 AGZ e z16 A02, 2064 é z900
// G1 e G2. Na ordem da semente (a mesma que o banco devolve), a primeira linha do
// type é a que vale quando nada decide.
const lcAmbiguos = [
  { type: '9176', model: 'MER', family: 'z17 MER', hwWdfm: null, coslEos: null },
  { type: '9176', model: 'ME2', family: 'z17 ME2', hwWdfm: null, coslEos: null },
  { type: '3932', model: 'AGZ', family: 'z16 AGZ', hwWdfm: '2027-03-31', coslEos: null },
  { type: '3932', model: 'A02', family: 'z16 A02', hwWdfm: '2027-03-31', coslEos: null },
  { type: '2064', model: '2nn', family: 'z900 G2', hwWdfm: '2006-06-30', coslEos: '2014-12-31' },
  { type: '2064', model: '1nn', family: 'z900 G1', hwWdfm: '2006-06-30', coslEos: '2014-12-31' },
];
const idxAmbiguos = indexarCicloDeVida(lcAmbiguos);
const ambiguas = [
  { model: 'IBM z17 ME2', lsprModel: '9176-Z06', status: 'ativa' },                          // modelo escrito à mão
  { model: 'IBM Z z17/Z00', featureModel: 'MER', lsprModel: '9176-Z06', status: 'ativa' },   // veio do SCRT, o feature diz o modelo
  { model: 'IBM Z z17/Y00', lsprModel: '9176-Y03', status: 'ativa' },                        // nada decide -> primeira linha
  { model: '2064-116', status: 'ativa' },                                                    // 1nn -> G1
  { model: '2064-216', status: 'ativa' },                                                    // 2nn -> G2
  { model: 'IBM Z z16/A00', lsprModel: '3932-A02', status: 'ativa' },                        // A02 aqui é CAPACIDADE, não modelo
];
const pa = agregarParque(ambiguas, lcAmbiguos, { hoje: '2026-08-05' });
const fam = (f) => pa.geracoes.find((g) => g.family === f);
check('9176 com "ME2" no modelo vira z17 ME2 (não o MER da primeira linha)',
  fam('z17 ME2') && fam('z17 ME2').quantidade === 1, pa.geracoes);
check('9176 com "MER" no feature entra no z17 MER, junto com a indecidível',
  fam('z17 MER') && fam('z17 MER').quantidade === 2, pa.geracoes);
check('2064 separa G1 e G2 pelo padrão 1nn/2nn do modelo',
  fam('z900 G1') && fam('z900 G1').quantidade === 1 && fam('z900 G2') && fam('z900 G2').quantidade === 1, pa.geracoes);
// O identificador de capacidade do zPCR ("3932-A02" = A02) não é o modelo da
// máquina: usá-lo rotularia de "z16 A02" uma máquina que pode ser AGZ.
check('capacidade do lsprModel NÃO decide o modelo (cai na primeira linha do type)',
  fam('z16 AGZ') && fam('z16 AGZ').quantidade === 1 && !fam('z16 A02'), pa.geracoes);
check('type com uma linha só continua casando direto',
  cicloDaMaquina({ model: '3931-7C6' }, indexarCicloDeVida(lifecycles)).family === 'z16');
check('type sem ciclo de vida continua sem linha',
  cicloDaMaquina({ model: '9999-XXX' }, idxAmbiguos) === null);
check('dois códigos casando com linhas diferentes não decidem (volta à primeira)',
  cicloDaMaquina({ model: '2064-116', variant: '216' }, idxAmbiguos).family === 'z900 G2');

// ── contratos ──
const ct = agregarContratos([caixa, brb]);
check('1 cliente com contrato, 1 sem', ct.comContrato === 1 && ct.semContrato === 1, ct);
check('soma dos baselines (1000 + 500)', ct.baselineMensalTotal === 1500, ct.baselineMensalTotal);

if (failures) { console.error(`\nPAINEL GERENCIAL: ${failures} FALHA(S)`); process.exit(1); }
console.log('\nPAINEL GERENCIAL: TODOS OS TESTES PASSARAM');
