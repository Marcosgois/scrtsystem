'use strict';

/*
 * A visão de MLC do ano (R$). Os números vêm do relatório real que vai à CAIXA —
 * se um deles mudar, é porque a conta mudou, e isso tem de doer aqui antes de
 * doer na reunião.
 *
 * O que mais importa neste arquivo:
 *   - a defasagem Med/Inv é ROTULAGEM: o total confrontado com o CAP é o dos
 *     meses MEDIDOS, e não pode escorregar com o lag;
 *   - CAP não cadastrado some da visão em vez de virar saldo negativo;
 *   - o CAP com CBA é um teto negociado, não o CAP × (1 − CBA).
 *
 * As visões de CONSUMO (MSU) estão em test/zotc-views.test.js.
 */

const assert = require('assert');
const { computeMlcView } = require('../src/mlc');
const { montarVisoes, visaoAnoMlc, mesDeInventario, rotuloCba } = require('../src/mlcViews');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

/* ── Cenário: CAIXA, contrato de jun/2024, três anos ─────────────────────── */

const ENCARGOS_A2 = [{ nome: 'Produtos Flat', valorMensal: 190627.71 }, { nome: 'Dev/Test', valorMensal: 900042.95 }];
const ANO = (over) => ({
  baselineAnnualMsu: 173439316,
  valorPorMsu: 1.42454658722355,
  encargoCrescimentoPorMsu: 0.2849,
  cbaPct: 0.19,
  encargos: ENCARGOS_A2,
  ...over,
});

const CONTRATO = {
  startPeriodKey: '2024-06',
  years: [
    ANO({ label: 'Ano 1', valorPorMsu: 1.43410560346319, encargoCrescimentoPorMsu: 0.2868, baselineZotcAnualMsu: 232399860, plannedAnnualMsu: 197697049 }),
    ANO({ label: 'Ano 2', capAnualRs: 273721090.24, capCbaRs: 221713323.43, baselineZotcAnualMsu: 232399860, plannedAnnualMsu: 215048454 }),
    ANO({ label: 'Ano 3', valorPorMsu: 1.56867718345812, encargoCrescimentoPorMsu: 0.3137, baselineZotcAnualMsu: 238017484, plannedAnnualMsu: 232399859 }),
  ],
};

// Consumo real da CAIXA (MSU), jun/24 em diante.
const CONSUMO_ANO1 = [16593757, 16220784, 16107531, 17001385, 18588938, 17118080, 18513488, 18962007, 16881605, 18641077, 17613723, 18613417];
const CONSUMO_ANO2 = [17949583, 18745956, 18830236, 19527781, 19563508, 18520501, 20390785, 20514032, 18855951, 21796215, 20833542, 22493876];
const CONSUMO_ANO3 = [22040571, 22197042]; // ano em curso: só 2 meses medidos

function serieDe(inicio, ...blocos) {
  const out = {};
  let [y, m] = inicio.split('-').map(Number);
  for (const bloco of blocos) {
    for (const v of bloco) {
      out[`${y}-${String(m).padStart(2, '0')}`] = v;
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
  }
  return out;
}
const serie = (...blocos) => serieDe('2024-06', ...blocos);
const CONSUMO = serie(CONSUMO_ANO1, CONSUMO_ANO2, CONSUMO_ANO3);
const VIEW = computeMlcView(CONTRATO, CONSUMO);
const OPTS = { anosCadastro: CONTRATO.years, baselinePadraoAnual: 19366655 * 12 };
console.log('Defasagem Med/Inv:');
check('mês de inventário é o medido + a defasagem', () => {
  assert.deepStrictEqual(mesDeInventario('2025-06', 2), { key: '2025-08', label: 'Ago/25' });
  assert.deepStrictEqual(mesDeInventario('2025-11', 2), { key: '2026-01', label: 'Jan/26' });
  assert.deepStrictEqual(mesDeInventario('2025-06', 0), { key: '2025-06', label: 'Jun/25' });
});

const A2 = visaoAnoMlc(VIEW, 1, { lag: 2, cadastro: CONTRATO.years[1] });

check('as 12 colunas trazem o par medido → inventário', () => {
  assert.strictEqual(A2.colunas.length, 12);
  assert.strictEqual(A2.colunas[0].medLabel, 'Jun/25');
  assert.strictEqual(A2.colunas[0].invLabel, 'Ago/25');
  assert.strictEqual(A2.colunas[11].medLabel, 'Mai/26');
  assert.strictEqual(A2.colunas[11].invLabel, 'Jul/26');
  assert.strictEqual(A2.periodoLabel, 'Jun/25 a Mai/26');
  assert.strictEqual(A2.invPeriodoLabel, 'Ago/25 a Jul/26');
});
check('a DEFASAGEM NÃO MEXE NO VALOR: o total é o dos meses medidos', () => {
  const semLag = visaoAnoMlc(VIEW, 1, { lag: 0, cadastro: CONTRATO.years[1] });
  const comLag = visaoAnoMlc(VIEW, 1, { lag: 5, cadastro: CONTRATO.years[1] });
  assert.strictEqual(semLag.totais.consumoRs, comLag.totais.consumoRs);
  assert.strictEqual(semLag.colunas[0].consumoRs, comLag.colunas[0].consumoRs);
  assert.notStrictEqual(semLag.colunas[0].invLabel, comLag.colunas[0].invLabel);
});

console.log('\nVisão 1 — Ano de MLC (R$):');
check('a linha "com CBA" é o consumo × (1 − CBA)', () => {
  for (const c of A2.colunas) {
    assert.ok(Math.abs(c.comCbaRs - c.consumoRs * 0.81) < 0.01, `${c.medLabel}: ${c.comCbaRs} ≠ ${c.consumoRs} × 0,81`);
  }
  assert.ok(Math.abs(A2.totais.comCbaRs - A2.totais.consumoRs * 0.81) < 0.02);
});
check('o rótulo do CBA sai formatado do próprio mês', () => {
  assert.strictEqual(A2.cbaLabel, '19%');
  assert.strictEqual(rotuloCba({ months: [{ cbaPct: 0.19 }, { cbaPct: 0.17 }] }), '19% a 17%');
});
check('CAP: saldo é teto − consumido, e o uso vem em %', () => {
  assert.ok(A2.cap, 'o bloco de CAP deveria existir');
  assert.strictEqual(A2.cap.anualRs, 273721090.24);
  assert.ok(Math.abs(A2.cap.saldoRs - (273721090.24 - A2.totais.consumoRs)) < 0.01);
  assert.ok(Math.abs(A2.cap.mensalRs - 273721090.24 / 12) < 0.01);
  assert.strictEqual(A2.cap.janelaLabel, 'Ago/25 a Jul/26', 'a janela do CAP é a de inventário');
});
check('CAP CBA é um teto NEGOCIADO, não o CAP × (1 − CBA)', () => {
  // 273.721.090,24 × 0,81 daria 221.714.083,09; o contratado é 221.713.323,43.
  assert.strictEqual(A2.cap.cba.anualRs, 221713323.43);
  // O relatório da CAIXA imprime 19,0002775335774% — a diferença para o nosso
  // 19,0002775322864% está na 10ª casa significativa, resíduo de arredondamento
  // da planilha de origem. O que importa é não ser 19% redondo.
  assert.ok(Math.abs(A2.cap.cba.descontoPct - 19.0002775335774) < 1e-6,
    `desconto implícito ${A2.cap.cba.descontoPct}`);
  assert.notStrictEqual(A2.cap.cba.descontoPct, 19);
  assert.ok(Math.abs(A2.cap.cba.saldoRs - (221713323.43 - A2.totais.comCbaRs)) < 0.01);
});
check('sem CAP cadastrado o bloco SOME (não vira saldo negativo)', () => {
  const semCap = visaoAnoMlc(VIEW, 0, { lag: 2, cadastro: CONTRATO.years[0] });
  assert.strictEqual(semCap.cap, null);
});
check('CAP sem o teto de CBA mostra o CAP e omite só a parte do CBA', () => {
  const so = visaoAnoMlc(VIEW, 1, { lag: 2, cadastro: { capAnualRs: 100, capCbaRs: 0 } });
  assert.ok(so.cap && so.cap.anualRs === 100);
  assert.strictEqual(so.cap.cba, null);
});
check('CAP estourado é marcado como tal', () => {
  const curto = visaoAnoMlc(VIEW, 1, { lag: 2, cadastro: { capAnualRs: 1000 } });
  assert.strictEqual(curto.cap.estourado, true);
  assert.ok(curto.cap.saldoRs < 0, 'o saldo negativo continua visível — mas rotulado');
});

console.log('\nMontagem da visão:');
check('sem ano escolhido, abre no último com SCRT', () => {
  const v = montarVisoes(VIEW, CONTRATO, { lag: 2 });
  assert.strictEqual(v.anoSelecionado, 2, 'o Ano 3 tem SCRT e é o mais recente');
  assert.strictEqual(v.anoMlc.label, 'Ano 3');
  assert.deepStrictEqual(v.anosDisponiveis.map((a) => a.mesesComScrt), [12, 12, 2]);
});
check('ano escolhido na query manda', () => {
  const v = montarVisoes(VIEW, CONTRATO, { lag: 2, ano: 1 });
  assert.strictEqual(v.anoSelecionado, 1);
  assert.strictEqual(v.anoMlc.label, 'Ano 2');
  assert.ok(v.anoMlc.cap, 'o Ano 2 tem CAP cadastrado');
});
check('ano fora da faixa cai no padrão em vez de estourar', () => {
  for (const ano of [-1, 99]) {
    assert.strictEqual(montarVisoes(VIEW, CONTRATO, { lag: 2, ano }).anoSelecionado, 2);
  }
});
check('contrato sem anos não quebra nada', () => {
  const vazio = computeMlcView({ startPeriodKey: '2024-06', years: [] }, {});
  assert.strictEqual(montarVisoes(vazio, { years: [] }, {}).anoMlc, null);
});

console.log(failures === 0 ? '\nVISÃO MLC: TODOS OS TESTES PASSARAM' : `\nVISÃO MLC: ${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
