'use strict';

/* Valida o motor de projeção contra séries sintéticas de comportamento conhecido. */

const assert = require('assert');
const { forecast, MIN_FOR_SEASONAL } = require('../src/forecast');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

/** Monta um histórico mensal a partir de valores, começando em 2024-01. */
function hist(values, startKey = '2024-01') {
  let [y, m] = startKey.split('-').map(Number);
  return values.map((v) => {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    return { periodKey: key, totalMsuConsumed: v };
  });
}

console.log('Regressão linear:');
check('tendência exata é continuada (série 100, 110, 120 … projeta 20 meses)', () => {
  const values = Array.from({ length: 24 }, (_, i) => 100 + 10 * i);
  const r = forecast(hist(values), { method: 'linear', months: 20 });
  assert.strictEqual(r.method, 'linear');
  assert.strictEqual(r.points.length, 20);
  // próximo ponto deve ser 100 + 10*24 = 340
  assert.ok(Math.abs(r.points[0].value - 340) <= 1, `esperado ~340, veio ${r.points[0].value}`);
  assert.ok(Math.abs(r.points[19].value - 530) <= 1, `esperado ~530, veio ${r.points[19].value}`);
  assert.ok(r.model.r2 > 0.999, `R² deveria ser ~1, veio ${r.model.r2}`);
});
check('rótulos e chaves de período avançam corretamente (vira o ano)', () => {
  const r = forecast(hist([10, 20, 30, 40], '2026-10'), { method: 'linear', months: 5 });
  assert.deepStrictEqual(r.points.map((p) => p.periodKey), ['2027-02', '2027-03', '2027-04', '2027-05', '2027-06']);
  assert.strictEqual(r.points[0].periodLabel, 'Fev/2027');
  assert.strictEqual(r.points[0].year, 2027);
});
check('intervalo contém a projeção e alarga com o horizonte', () => {
  const values = Array.from({ length: 18 }, (_, i) => 1000 + 5 * i + (i % 3) * 40);
  const r = forecast(hist(values), { method: 'linear', months: 12 });
  for (const p of r.points) {
    assert.ok(p.lower <= p.value && p.value <= p.upper, `intervalo inválido em ${p.periodKey}`);
  }
  const larguraInicio = r.points[0].upper - r.points[0].lower;
  const larguraFim = r.points[11].upper - r.points[11].lower;
  assert.ok(larguraFim > larguraInicio, 'a incerteza deveria crescer com o horizonte');
});
check('projeção nunca fica negativa', () => {
  const values = Array.from({ length: 12 }, (_, i) => Math.max(0, 500 - 45 * i));
  const r = forecast(hist(values), { method: 'linear', months: 24 });
  assert.ok(r.points.every((p) => p.value >= 0 && p.lower >= 0), 'houve valor negativo');
});

console.log('\nSARIMA:');
check('série sazonal com 36 meses: sazonalidade é estimada e reproduzida', () => {
  // nível + tendência suave + padrão sazonal forte de 12 meses
  const sazonal = [0, 200, 400, 300, 100, -100, -300, -200, 0, 300, 500, 250];
  const values = Array.from({ length: 36 }, (_, i) => 5000 + 20 * i + sazonal[i % 12]);
  const r = forecast(hist(values), { method: 'sarima', months: 12 });
  assert.strictEqual(r.method, 'sarima');
  assert.strictEqual(r.model.seasonal, true, 'deveria ter estimado a parte sazonal');
  assert.ok(/^SARIMA\(/.test(r.model.order), `ordem inesperada: ${r.model.order}`);
  // O pico sazonal (índice 10 do ciclo) deve continuar sendo o maior dos 12 meses projetados
  const idxMax = r.points.reduce((best, p, i) => (p.value > r.points[best].value ? i : best), 0);
  const cicloEsperado = (36 + idxMax) % 12;
  assert.strictEqual(cicloEsperado, 10, `pico projetado no mês de ciclo ${cicloEsperado}, esperado 10`);
});
check('série sazonal: erro médio da projeção é pequeno (holdout dos últimos 12 meses)', () => {
  const sazonal = [0, 200, 400, 300, 100, -100, -300, -200, 0, 300, 500, 250];
  const todos = Array.from({ length: 48 }, (_, i) => 5000 + 20 * i + sazonal[i % 12]);
  const treino = todos.slice(0, 36);
  const teste = todos.slice(36);
  const r = forecast(hist(treino), { method: 'sarima', months: 12 });
  const mape = r.points.reduce((a, p, i) => a + Math.abs(p.value - teste[i]) / teste[i], 0) / 12 * 100;
  assert.ok(mape < 6, `MAPE de ${mape.toFixed(2)}% — esperado abaixo de 6%`);
});
check('histórico curto (13 meses): sazonalidade é desligada, com aviso explícito', () => {
  const values = Array.from({ length: 13 }, (_, i) => 1000 + 30 * i);
  const r = forecast(hist(values), { method: 'sarima', months: 12 });
  assert.strictEqual(r.method, 'sarima');
  assert.strictEqual(r.model.seasonal, false);
  assert.ok(/^ARIMA\(/.test(r.model.order), `deveria ser ARIMA não sazonal, veio ${r.model.order}`);
  assert.ok(r.notes.some((n) => n.includes(String(MIN_FOR_SEASONAL))), 'faltou o aviso sobre sazonalidade');
});
check('histórico muito curto (4 meses): cai para linear, avisando', () => {
  const r = forecast(hist([100, 120, 140, 160]), { method: 'sarima', months: 6 });
  assert.strictEqual(r.method, 'linear');
  assert.strictEqual(r.requestedMethod, 'sarima');
  assert.ok(r.notes.some((n) => n.toLowerCase().includes('sarima')), 'faltou o aviso da troca de método');
});
check('SARIMA em série com tendência linear pura projeta perto da tendência', () => {
  const values = Array.from({ length: 30 }, (_, i) => 2000 + 50 * i);
  const r = forecast(hist(values), { method: 'sarima', months: 6 });
  // continuação da tendência: 2000 + 50*30 = 3500
  assert.ok(Math.abs(r.points[0].value - 3500) < 250, `esperado ~3500, veio ${r.points[0].value}`);
});

console.log('\nValidações:');
check('menos de 3 meses é recusado com 422', () => {
  assert.throws(
    () => forecast(hist([100, 200]), { method: 'linear', months: 12 }),
    (e) => e.status === 422 && /pelo menos/.test(e.message)
  );
});
check('buraco no histórico gera aviso', () => {
  const h = [
    { periodKey: '2025-01', totalMsuConsumed: 100 },
    { periodKey: '2025-02', totalMsuConsumed: 110 },
    { periodKey: '2025-06', totalMsuConsumed: 150 }, // faltam mar, abr, mai
    { periodKey: '2025-07', totalMsuConsumed: 160 },
  ];
  const r = forecast(h, { method: 'linear', months: 6 });
  assert.ok(r.notes.some((n) => n.includes('sem SCRT')), `avisos: ${JSON.stringify(r.notes)}`);
});

console.log(failures === 0 ? '\nPROJEÇÃO: TODOS OS TESTES PASSARAM' : `\nPROJEÇÃO: ${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
