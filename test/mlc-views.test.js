'use strict';

/*
 * As três visões do MLC. Os números vêm do relatório real que vai à CAIXA — se
 * um deles mudar, é porque a conta mudou, e isso tem de doer aqui antes de doer
 * na reunião.
 *
 * O que mais importa neste arquivo:
 *   - a defasagem Med/Inv é ROTULAGEM: o total confrontado com o CAP é o dos
 *     meses MEDIDOS, e não pode escorregar com o lag;
 *   - CAP não cadastrado some da visão em vez de virar saldo negativo;
 *   - ano em curso é completado com o PLANEJADO, não com projeção estatística;
 *   - a conclusão automática nunca afirma o que os números não sustentam.
 */

const assert = require('assert');
const { computeMlcView } = require('../src/mlc');
const {
  montarVisoes, visaoAnoMlc, visaoComparativoAnos, visaoPlanejadoVsContratado,
  mesDeInventario, baselineZotcDoAno, rotuloCba,
} = require('../src/mlcViews');

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

console.log('\nVisão 2 — comparativo de anos (MSU):');
const CMP = visaoComparativoAnos(VIEW, OPTS);
check('cada ano vira uma série de 12 posições, alinhada pela posição no ano', () => {
  assert.strictEqual(CMP.anos.length, 3);
  assert.deepStrictEqual(CMP.anos.map((a) => a.label), ['Ano 1', 'Ano 2', 'Ano 3']);
  for (const a of CMP.anos) assert.strictEqual(a.pontos.length, 12);
  assert.strictEqual(CMP.anos[0].pontos[0], 16593757);
  assert.strictEqual(CMP.anos[1].pontos[0], 17949583);
  assert.strictEqual(CMP.anos[2].pontos[0], 22040571);
});
check('ano em curso é completado com o planejado, e o medido fica separado', () => {
  const a3 = CMP.anos[2];
  assert.strictEqual(a3.mesesComDado, 2);
  assert.strictEqual(a3.emCurso, true);
  assert.strictEqual(a3.posicaoUltimoReal, 2);
  // `reais` guarda só o que veio do SCRT; `pontos` é o que o gráfico desenha.
  assert.strictEqual(a3.reais[2], null);
  assert.ok(Math.abs(a3.pontos[2] - 232399859 / 12) < 1e-6, `${a3.pontos[2]}`);
  assert.strictEqual(a3.mesesPlanejados, 10);
  assert.strictEqual(a3.ultimo.posicao, 12);
  assert.strictEqual(a3.ultimo.planejado, true);
});
check('sem planejado cadastrado, a linha PARA no último SCRT', () => {
  const semPlano = visaoComparativoAnos(VIEW, {
    anosCadastro: [CONTRATO.years[0], CONTRATO.years[1], { ...CONTRATO.years[2], plannedAnnualMsu: 0 }],
    baselinePadraoAnual: 0,
  });
  const a3 = semPlano.anos[2];
  assert.strictEqual(a3.pontos[2], null);
  assert.strictEqual(a3.mesesPlanejados, 0);
  assert.deepStrictEqual(
    { posicao: a3.ultimo.posicao, valor: a3.ultimo.valor },
    { posicao: 2, valor: 22197042 }
  );
});
check('mês sem SCRT no MEIO do ano não é preenchido pelo planejado', () => {
  // Buraco de SCRT é ausência de medição, não futuro: completar seria inventar
  // um mês que já passou.
  const comBuraco = { ...CONSUMO };
  delete comBuraco['2025-09'];
  const v = computeMlcView(CONTRATO, comBuraco);
  const c = visaoComparativoAnos(v, OPTS);
  assert.strictEqual(c.anos[1].pontos[3], null, 'set/25 é buraco e tem de continuar buraco');
  assert.strictEqual(c.anos[1].reais[3], null);
});
check('a régua de baseline é a do ano MAIS RECENTE com dado', () => {
  assert.ok(CMP.baseline);
  assert.strictEqual(CMP.baseline.anualMsu, 238017484);
  assert.ok(Math.abs(CMP.baseline.mensalMsu - 238017484 / 12) < 1e-6);
  assert.ok(/Ano 3/.test(CMP.baseline.label));
});
check('baseline do ano cai no teto do cliente quando não é cadastrado', () => {
  assert.strictEqual(baselineZotcDoAno({ baselineZotcAnualMsu: 0 }, 232399860), 232399860);
  assert.strictEqual(baselineZotcDoAno({ baselineZotcAnualMsu: 238017484 }, 232399860), 238017484);
  assert.strictEqual(baselineZotcDoAno(undefined, 232399860), 232399860);
});
check('"estouro" é quando o ACUMULADO passa do baseline anual, não a média mensal', () => {
  // O Ano 2 fecha 238.021.966 contra um baseline de 232.399.860: estoura, e no
  // mês em que o acumulado cruza — o mês 12, não o mês 1 (que já está acima da média).
  const so2 = computeMlcView(
    { startPeriodKey: '2025-06', years: [CONTRATO.years[1]] },
    serieDe('2025-06', CONSUMO_ANO2)
  );
  const c = visaoComparativoAnos(so2, { anosCadastro: [CONTRATO.years[1]], baselinePadraoAnual: 0 });
  assert.ok(c.estouro, 'o Ano 2 estoura o baseline e o mês deveria ser apontado');
  assert.strictEqual(c.estouro.posicao, 12);
  assert.ok(c.estouro.acumuladoMsu > 232399860);
  const ate11 = CONSUMO_ANO2.slice(0, 11).reduce((a, b) => a + b, 0);
  assert.ok(ate11 <= 232399860, 'o mês anterior ainda estava dentro do baseline');
});
check('ano que não estoura não inventa anotação', () => {
  const folgado = computeMlcView(
    { startPeriodKey: '2024-06', years: [{ ...CONTRATO.years[0], baselineZotcAnualMsu: 999999999 }] },
    serie(CONSUMO_ANO1)
  );
  const c = visaoComparativoAnos(folgado, { anosCadastro: [{ baselineZotcAnualMsu: 999999999 }], baselinePadraoAnual: 0 });
  assert.strictEqual(c.estouro, null);
});
check('sem baseline nenhum, não há régua nem anotação (em vez de dividir por zero)', () => {
  const c = visaoComparativoAnos(VIEW, { anosCadastro: [{}, {}, {}], baselinePadraoAnual: 0 });
  assert.strictEqual(c.baseline, null);
  assert.strictEqual(c.estouro, null);
});

console.log('\nVisão 3 — planejado × contratado:');
const PLAN = visaoPlanejadoVsContratado(VIEW, OPTS);
check('uma linha por ano, com os três números do relatório', () => {
  assert.strictEqual(PLAN.anos.length, 3);
  const a1 = PLAN.anos[0];
  assert.strictEqual(a1.planejadoMsu, 197697049);
  assert.strictEqual(a1.baselineZotcMsu, 232399860);
  assert.strictEqual(a1.consumidasMsu, CONSUMO_ANO1.reduce((a, b) => a + b, 0));
  assert.ok(Math.abs(a1.vsPlanejadoPct - 106.66) < 0.05, `vsPlanejado ${a1.vsPlanejadoPct}`);
  assert.ok(Math.abs(a1.vsContratadoPct - 90.73) < 0.05, `vsContratado ${a1.vsContratadoPct}`);
});
check('ano em curso é completado com o PLANEJADO, e marcado como estimado', () => {
  const a3 = PLAN.anos[2];
  assert.strictEqual(a3.mesesReais, 2);
  assert.strictEqual(a3.mesesPlanejados, 10);
  assert.strictEqual(a3.estimado, true);
  assert.strictEqual(a3.fechado, false);
  const esperado = 22040571 + 22197042 + (232399859 / 12) * 10;
  assert.ok(Math.abs(a3.consumidasMsu - esperado) < 0.01, `${a3.consumidasMsu} ≠ ${esperado}`);
});
check('ano em curso SEM planejado cadastrado fica parcial, não estimado', () => {
  const semPlano = visaoPlanejadoVsContratado(VIEW, {
    anosCadastro: [CONTRATO.years[0], CONTRATO.years[1], { ...CONTRATO.years[2], plannedAnnualMsu: 0 }],
    baselinePadraoAnual: 0,
  });
  const a3 = semPlano.anos[2];
  assert.strictEqual(a3.estimado, false);
  assert.strictEqual(a3.parcialSemPlanejado, true);
  assert.strictEqual(a3.consumidasMsu, 22040571 + 22197042);
});
check('destaque verde: o baseline do ano é o consumo do ano anterior', () => {
  const consumoA2 = CONSUMO_ANO2.reduce((a, b) => a + b, 0);   // 238.021.966
  const ajustado = visaoPlanejadoVsContratado(VIEW, {
    anosCadastro: [CONTRATO.years[0], CONTRATO.years[1], { ...CONTRATO.years[2], baselineZotcAnualMsu: consumoA2 }],
    baselinePadraoAnual: 0,
  });
  assert.strictEqual(ajustado.anos[2].baselineIgualConsumoAnterior, true);
  // O caso REAL: o aditivo da CAIXA fixou 238.017.484 para um consumo de
  // 238.021.966 — 0,0019% de diferença. Exigir igualdade ao MSU faria o destaque
  // nunca aparecer justo no caso que ele existe para mostrar.
  assert.strictEqual(PLAN.anos[2].baselineZotcMsu, 238017484);
  assert.strictEqual(PLAN.anos[2].baselineIgualConsumoAnterior, true);
});
check('baseline claramente diferente do ano anterior NÃO pinta', () => {
  const outro = visaoPlanejadoVsContratado(VIEW, {
    anosCadastro: [CONTRATO.years[0], CONTRATO.years[1], { ...CONTRATO.years[2], baselineZotcAnualMsu: 300000000 }],
    baselinePadraoAnual: 0,
  });
  assert.strictEqual(outro.anos[2].baselineIgualConsumoAnterior, false);
});

console.log('\nConclusão automática:');
check('aponta o ano fechado que estourou o baseline, com os números', () => {
  const t = PLAN.conclusoes.join('\n');
  assert.ok(/Ano 2/.test(t), `faltou o Ano 2:\n${t}`);
  assert.ok(/aditivo/i.test(t), `faltou falar de aditivo:\n${t}`);
  assert.ok(/238\.021\.966/.test(t), `faltou o consumo do Ano 2:\n${t}`);
});
check('não afirma estouro quando não houve', () => {
  const folgado = visaoPlanejadoVsContratado(VIEW, {
    anosCadastro: CONTRATO.years.map((y) => ({ ...y, baselineZotcAnualMsu: 999999999 })),
    baselinePadraoAnual: 0,
  });
  const t = folgado.conclusoes.join('\n');
  assert.ok(/Nenhum ano fechado ultrapassou/.test(t), t);
  assert.ok(!/aditivo/i.test(t), `não deveria pedir aditivo:\n${t}`);
});
check('fala do crescimento entre os dois últimos anos FECHADOS', () => {
  const t = PLAN.conclusoes.join('\n');
  assert.ok(/cresceu/.test(t), t);
  assert.ok(/210\.855\.792 → 238\.021\.966/.test(t), `esperava o par Ano1→Ano2:\n${t}`);
});
check('sem ano nenhum, não escreve conclusão nenhuma', () => {
  const vazio = visaoPlanejadoVsContratado({ years: [] }, {});
  assert.deepStrictEqual(vazio.conclusoes, []);
  assert.deepStrictEqual(vazio.anos, []);
});
/* Achados da revisão adversarial — cada um destes já saiu errado uma vez. */
console.log('\nConclusão: o que ela NÃO pode afirmar:');
check('sem baseline cadastrado, não afirma conformidade nem imprime 0,00%', () => {
  const semBase = visaoPlanejadoVsContratado(VIEW, {
    anosCadastro: CONTRATO.years.map((y) => ({ ...y, baselineZotcAnualMsu: 0 })),
    baselinePadraoAnual: 0,   // e o cliente também não tem teto global
  });
  const t = semBase.conclusoes.join('\n');
  assert.ok(!/0,00%/.test(t), `imprimiu 0,00% de uso:\n${t}`);
  assert.ok(!/Nenhum ano fechado ultrapassou/.test(t), `deu conformidade sem baseline:\n${t}`);
  assert.ok(/[Nn]ão há baseline zOTC cadastrado/.test(t), `deveria dizer que falta o baseline:\n${t}`);
});
check('ano em curso sem baseline fecha a frase sem porcentagem inventada', () => {
  const semBase = visaoPlanejadoVsContratado(VIEW, {
    anosCadastro: CONTRATO.years.map((y) => ({ ...y, baselineZotcAnualMsu: 0 })),
    baselinePadraoAnual: 0,
  });
  const t = semBase.conclusoes.join('\n');
  assert.ok(/Sem baseline zOTC cadastrado, não há teto para comparar/.test(t), t);
});
check('concordância: 1 mês que falta, 2 meses que faltam', () => {
  const umMes = { ...CONTRATO.years[2], plannedAnnualMsu: 120000000 };
  const onzeMeses = computeMlcView(
    { startPeriodKey: '2026-06', years: [umMes] },
    serieDe('2026-06', CONSUMO_ANO2.slice(0, 11))
  );
  const r = visaoPlanejadoVsContratado(onzeMeses, { anosCadastro: [umMes], baselinePadraoAnual: 999999999 });
  const t = r.conclusoes.join('\n');
  assert.ok(/1 mês que falta/.test(t), `esperava singular:\n${t}`);
  assert.ok(!/1 meses/.test(t), t);
  assert.ok(/10 meses que faltam/.test(PLAN.conclusoes.join('\n')), 'e o plural continua plural');
});

console.log('\nBuraco de SCRT no meio do ano:');
check('mês perdido no meio NÃO é preenchido pelo planejado (visões 2 e 3 batem)', () => {
  // Ano 1 completo, menos set/24 — um SCRT que se perdeu, não um mês futuro.
  const comBuraco = { ...CONSUMO };
  delete comBuraco['2024-09'];
  const v = computeMlcView(CONTRATO, comBuraco);
  const p = visaoPlanejadoVsContratado(v, OPTS);
  const c = visaoComparativoAnos(v, OPTS);
  const a1 = p.anos[0];
  assert.strictEqual(a1.mesesReais, 11);
  assert.strictEqual(a1.mesesPlanejados, 0, 'buraco no meio não vira mês planejado');
  assert.strictEqual(a1.mesesSemScrt, 1);
  assert.strictEqual(a1.estimado, false);
  assert.strictEqual(a1.fechado, true, 'o ano acabou: o mês não "falta", ele se perdeu');
  // O total da tabela (visão 3) tem de ser o mesmo do gráfico (visão 2).
  const doGrafico = c.anos[0].pontos.reduce((s, x) => s + (x || 0), 0);
  assert.strictEqual(a1.consumidasMsu, doGrafico, `tabela ${a1.consumidasMsu} ≠ gráfico ${doGrafico}`);
});
check('o buraco é declarado numa nota, em vez de sumir calado', () => {
  const comBuraco = { ...CONSUMO };
  delete comBuraco['2024-09'];
  const p = visaoPlanejadoVsContratado(computeMlcView(CONTRATO, comBuraco), OPTS);
  const nota = p.notas.find((n) => n.tipo === 'buraco');
  assert.ok(nota, `sem nota do buraco: ${JSON.stringify(p.notas)}`);
  assert.ok(/Ano 1 \(1\)/.test(nota.texto), nota.texto);
});
check('ano em curso continua sendo completado (o buraco é só no MEIO)', () => {
  assert.strictEqual(PLAN.anos[2].mesesPlanejados, 10);
  assert.strictEqual(PLAN.anos[2].mesesSemScrt, 0);
});

check('notas de rodapé são numeradas em sequência', () => {
  assert.ok(PLAN.notas.length >= 1);
  assert.deepStrictEqual(PLAN.notas.map((n) => n.marca), PLAN.notas.map((_, i) => `(${i + 1})`));
  assert.ok(PLAN.notas.some((n) => n.tipo === 'estimado'));
});

console.log('\nMontagem das três de uma vez:');
check('sem ano escolhido, abre no último com SCRT', () => {
  const v = montarVisoes(VIEW, CONTRATO, { lag: 2, baselinePadraoAnual: 19366655 * 12 });
  assert.strictEqual(v.anoSelecionado, 2, 'o Ano 3 tem SCRT e é o mais recente');
  assert.strictEqual(v.anoMlc.label, 'Ano 3');
  assert.strictEqual(v.anosDisponiveis.length, 3);
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
    const v = montarVisoes(VIEW, CONTRATO, { lag: 2, ano });
    assert.strictEqual(v.anoSelecionado, 2);
  }
});
check('as três visões saem juntas e batem entre si', () => {
  const v = montarVisoes(VIEW, CONTRATO, { lag: 2, baselinePadraoAnual: 19366655 * 12, ano: 1 });
  // O consumo em MSU do Ano 2 tem de ser o mesmo nas três leituras.
  const doAnoMlc = v.anoMlc.totais.consumedMsu;
  const doComparativo = v.comparativo.anos[1].pontos.reduce((a, b) => a + (b || 0), 0);
  const doPlanejado = v.planejado.anos[1].consumidasMsu;
  assert.strictEqual(doAnoMlc, doComparativo);
  assert.strictEqual(doAnoMlc, doPlanejado);
});
check('contrato sem anos não quebra nada', () => {
  const vazio = computeMlcView({ startPeriodKey: '2024-06', years: [] }, {});
  const v = montarVisoes(vazio, { years: [] }, {});
  assert.strictEqual(v.anoMlc, null);
  assert.deepStrictEqual(v.comparativo.anos, []);
  assert.deepStrictEqual(v.planejado.anos, []);
});

console.log(failures === 0 ? '\nVISÕES MLC: TODOS OS TESTES PASSARAM' : `\nVISÕES MLC: ${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
