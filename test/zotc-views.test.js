'use strict';

/*
 * As visões de CONSUMO (MSU) por ano contratual — a análise da tela de zOTC.
 * Os números vêm do relatório real que vai à CAIXA: se um deles mudar, é porque
 * a conta mudou, e isso tem de doer aqui antes de doer na reunião.
 *
 * O que mais importa neste arquivo:
 *   - o ano em curso é completado com o CONSUMO PLANEJADO cadastrado, nunca com
 *     projeção estatística, e só DEPOIS do último mês medido;
 *   - "estouro" é o mês em que o ACUMULADO passa do baseline anual;
 *   - a conclusão automática nunca afirma o que os números não sustentam;
 *   - sem contrato de MLC cadastrado as visões continuam funcionando: para o
 *     zOTC basta o mês de início do ano contratual.
 */

const assert = require('assert');
const {
  montarVisoesZotc, anosDeConsumo, visaoComparativoAnos, visaoPlanejadoVsContratado,
  baselineZotcDoAno,
} = require('../src/zotcViews');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

/* ── Cenário: CAIXA, contrato de jun/2024, três anos ─────────────────────── */

const CONTRATO = {
  startPeriodKey: '2024-06',
  years: [
    { label: 'Ano 1', baselineZotcAnualMsu: 232399860, plannedAnnualMsu: 197697049 },
    { label: 'Ano 2', baselineZotcAnualMsu: 232399860, plannedAnnualMsu: 215048454 },
    { label: 'Ano 3', baselineZotcAnualMsu: 238017484, plannedAnnualMsu: 232399859 },
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
const OPTS = { baselinePadraoAnual: 19366655 * 12 };

const anos = (contrato = CONTRATO, consumo = CONSUMO) => anosDeConsumo(contrato, consumo);
const ANOS = anos();
const CMP = visaoComparativoAnos(ANOS, OPTS);
const PLAN = visaoPlanejadoVsContratado(ANOS, OPTS);

console.log('Anos de consumo:');
check('sem contrato de MLC, o ano contratual sai só do mês-âncora', () => {
  const semPrecos = anosDeConsumo({ startPeriodKey: '2024-06' }, CONSUMO);
  assert.strictEqual(semPrecos.length, 3, 'três anos cobrem o consumo carregado');
  assert.deepStrictEqual(semPrecos.map((a) => a.label), ['Ano 1', 'Ano 2', 'Ano 3']);
  assert.strictEqual(semPrecos[0].months.length, 12);
  assert.strictEqual(semPrecos[0].totals.consumedMsu, CONSUMO_ANO1.reduce((a, b) => a + b, 0));
});
check('sem mês-âncora não há ano contratual nenhum', () => {
  assert.deepStrictEqual(anosDeConsumo({ startPeriodKey: null }, CONSUMO), []);
  assert.deepStrictEqual(anosDeConsumo({ startPeriodKey: 'lixo' }, CONSUMO), []);
});
check('cada ano tem 12 casas fixas, com null onde não houve SCRT', () => {
  const a3 = ANOS[2];
  assert.strictEqual(a3.months.length, 12);
  assert.strictEqual(a3.months[0].consumedMsu, 22040571);
  assert.strictEqual(a3.months[2].consumedMsu, null);
  assert.strictEqual(a3.totals.monthsWithScrt, 2);
});

console.log('\nComparativo de anos:');
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
  const semPlano = visaoComparativoAnos(
    anos({ ...CONTRATO, years: [CONTRATO.years[0], CONTRATO.years[1], { ...CONTRATO.years[2], plannedAnnualMsu: 0 }] }),
    { baselinePadraoAnual: 0 });
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
  const v = anos(CONTRATO, comBuraco);
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
  const so2 = anosDeConsumo(
    { startPeriodKey: '2025-06', years: [CONTRATO.years[1]] },
    serieDe('2025-06', CONSUMO_ANO2)
  );
  const c = visaoComparativoAnos(so2, { baselinePadraoAnual: 0 });
  assert.ok(c.estouro, 'o Ano 2 estoura o baseline e o mês deveria ser apontado');
  assert.strictEqual(c.estouro.posicao, 12);
  assert.ok(c.estouro.acumuladoMsu > 232399860);
  const ate11 = CONSUMO_ANO2.slice(0, 11).reduce((a, b) => a + b, 0);
  assert.ok(ate11 <= 232399860, 'o mês anterior ainda estava dentro do baseline');
});
check('ano que não estoura não inventa anotação', () => {
  const folgado = anosDeConsumo(
    { startPeriodKey: '2024-06', years: [{ ...CONTRATO.years[0], baselineZotcAnualMsu: 999999999 }] },
    serie(CONSUMO_ANO1)
  );
  const c = visaoComparativoAnos(folgado, { baselinePadraoAnual: 0 });
  assert.strictEqual(c.estouro, null);
});
check('sem baseline nenhum, não há régua nem anotação (em vez de dividir por zero)', () => {
  const c = visaoComparativoAnos(anos({ startPeriodKey: '2024-06' }), { baselinePadraoAnual: 0 });
  assert.strictEqual(c.baseline, null);
  assert.strictEqual(c.estouro, null);
});

console.log('\nConsumido × planejado × contratado:');
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
  const semPlano = visaoPlanejadoVsContratado(
    anos({ ...CONTRATO, years: [CONTRATO.years[0], CONTRATO.years[1], { ...CONTRATO.years[2], plannedAnnualMsu: 0 }] }),
    { baselinePadraoAnual: 0 });
  const a3 = semPlano.anos[2];
  assert.strictEqual(a3.estimado, false);
  assert.strictEqual(a3.parcialSemPlanejado, true);
  assert.strictEqual(a3.consumidasMsu, 22040571 + 22197042);
});
check('destaque verde: o baseline do ano é o consumo do ano anterior', () => {
  const consumoA2 = CONSUMO_ANO2.reduce((a, b) => a + b, 0);   // 238.021.966
  const ajustado = visaoPlanejadoVsContratado(
    anos({ ...CONTRATO, years: [CONTRATO.years[0], CONTRATO.years[1], { ...CONTRATO.years[2], baselineZotcAnualMsu: consumoA2 }] }),
    { baselinePadraoAnual: 0 });
  assert.strictEqual(ajustado.anos[2].baselineIgualConsumoAnterior, true);
  // O caso REAL: o aditivo da CAIXA fixou 238.017.484 para um consumo de
  // 238.021.966 — 0,0019% de diferença. Exigir igualdade ao MSU faria o destaque
  // nunca aparecer justo no caso que ele existe para mostrar.
  assert.strictEqual(PLAN.anos[2].baselineZotcMsu, 238017484);
  assert.strictEqual(PLAN.anos[2].baselineIgualConsumoAnterior, true);
});
check('baseline claramente diferente do ano anterior NÃO pinta', () => {
  const outro = visaoPlanejadoVsContratado(
    anos({ ...CONTRATO, years: [CONTRATO.years[0], CONTRATO.years[1], { ...CONTRATO.years[2], baselineZotcAnualMsu: 300000000 }] }),
    { baselinePadraoAnual: 0 });
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
  const folgado = visaoPlanejadoVsContratado(
    anos({ ...CONTRATO, years: CONTRATO.years.map((y) => ({ ...y, baselineZotcAnualMsu: 999999999 })) }),
    { baselinePadraoAnual: 0 });
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
  const vazio = visaoPlanejadoVsContratado([], {});
  assert.deepStrictEqual(vazio.conclusoes, []);
  assert.deepStrictEqual(vazio.anos, []);
});
/* Achados da revisão adversarial — cada um destes já saiu errado uma vez. */
console.log('\nConclusão: o que ela NÃO pode afirmar:');
check('sem baseline cadastrado, não afirma conformidade nem imprime 0,00%', () => {
  const semBase = visaoPlanejadoVsContratado(
    anos({ ...CONTRATO, years: CONTRATO.years.map((y) => ({ ...y, baselineZotcAnualMsu: 0 })) }),
    { baselinePadraoAnual: 0 });   // e o cliente também não tem teto global
  const t = semBase.conclusoes.join('\n');
  assert.ok(!/0,00%/.test(t), `imprimiu 0,00% de uso:\n${t}`);
  assert.ok(!/Nenhum ano fechado ultrapassou/.test(t), `deu conformidade sem baseline:\n${t}`);
  assert.ok(/[Nn]ão há baseline zOTC cadastrado/.test(t), `deveria dizer que falta o baseline:\n${t}`);
});
check('ano em curso sem baseline fecha a frase sem porcentagem inventada', () => {
  const semBase = visaoPlanejadoVsContratado(
    anos({ ...CONTRATO, years: CONTRATO.years.map((y) => ({ ...y, baselineZotcAnualMsu: 0 })) }),
    { baselinePadraoAnual: 0 });
  const t = semBase.conclusoes.join('\n');
  assert.ok(/Sem baseline zOTC cadastrado, não há teto para comparar/.test(t), t);
});
check('concordância: 1 mês que falta, 2 meses que faltam', () => {
  const umMes = { ...CONTRATO.years[2], plannedAnnualMsu: 120000000 };
  const onzeMeses = anosDeConsumo(
    { startPeriodKey: '2026-06', years: [umMes] },
    serieDe('2026-06', CONSUMO_ANO2.slice(0, 11))
  );
  const r = visaoPlanejadoVsContratado(onzeMeses, { baselinePadraoAnual: 999999999 });
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
  const v = anos(CONTRATO, comBuraco);
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
  const p = visaoPlanejadoVsContratado(anos(CONTRATO, comBuraco), OPTS);
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

console.log('\nMontagem das duas de uma vez:');
check('montarVisoesZotc devolve as duas visões coerentes entre si', () => {
  const v = montarVisoesZotc(CONTRATO, CONSUMO, OPTS);
  assert.strictEqual(v.temAnoContratual, true);
  assert.strictEqual(v.comparativo.anos.length, 3);
  assert.strictEqual(v.planejado.anos.length, 3);
  // O total do Ano 2 tem de ser o mesmo nas duas leituras.
  const doGrafico = v.comparativo.anos[1].pontos.reduce((a, b) => a + (b || 0), 0);
  assert.strictEqual(doGrafico, v.planejado.anos[1].consumidasMsu);
});
check('cliente sem mês-âncora não quebra nada', () => {
  const v = montarVisoesZotc({ startPeriodKey: null }, CONSUMO, OPTS);
  assert.strictEqual(v.temAnoContratual, false);
  assert.deepStrictEqual(v.comparativo.anos, []);
  assert.deepStrictEqual(v.planejado.anos, []);
  assert.deepStrictEqual(v.planejado.conclusoes, []);
});

console.log(failures === 0 ? '\nVISÕES zOTC: TODOS OS TESTES PASSARAM' : `\nVISÕES zOTC: ${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
