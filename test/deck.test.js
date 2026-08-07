'use strict';

/*
 * Fechamento anual do capacity planning (calendário × contratual) e o .pptx que
 * vai para a reunião.
 *
 * O que este teste protege, em ordem de importância:
 *   1. O slide não pode discordar da tela — os dois consomem o mesmo payload, e
 *      aqui isso é verificado somando as linhas.
 *   2. O ano contratual respeita a janela do CONTRATO, não os meses que têm dado.
 *   3. O .pptx é um pacote OOXML válido: todas as partes bem formadas, as
 *      relações fechadas e a tabela com a URI certa (com a errada o PowerPoint
 *      abre e mostra um quadro vazio, sem erro nenhum — o pior dos mundos).
 */

const assert = require('assert');
const { unzipSync, strFromU8 } = require('fflate');
const {
  serieUnificada, porAnoCalendario, porAnoContratual, rotuloCurto,
} = require('../src/forecastYears');
const { deckCapacityPlanning, composicao, passoBonito } = require('../src/deckCapacity');
const { buildPptx } = require('../src/pptx');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

/* Série mensal sintética a partir de uma chave inicial. */
function meses(n, inicio, valor) {
  let [y, m] = inicio.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ periodKey: `${y}-${String(m).padStart(2, '0')}`, totalMsuConsumed: valor(i), year: y });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
const comoProjecao = (arr) => arr.map((s) => ({ periodKey: s.periodKey, year: s.year, value: s.totalMsuConsumed, lower: s.totalMsuConsumed * 0.9, upper: s.totalMsuConsumed * 1.1 }));

// jun/24 .. mai/26 reais (24 meses de 100) + jun/26 .. mai/27 projetados (12 de 120)
const HIST = meses(24, '2024-06', () => 100);
const PROJ = comoProjecao(meses(12, '2026-06', () => 120));
const SERIE = serieUnificada(HIST, PROJ);
const BASELINE = 100; // 1.200 MSU/ano

console.log('Ano-calendário:');
const CAL = porAnoCalendario(SERIE, BASELINE);
check('agrupa por ano e marca o parcial', () => {
  assert.deepStrictEqual(CAL.map((a) => a.year), [2024, 2025, 2026, 2027]);
  assert.deepStrictEqual(CAL.map((a) => a.months), [7, 12, 12, 5]);
  assert.deepStrictEqual(CAL.map((a) => a.complete), [false, true, true, false]);
});
check('separa meses reais de projetados no mesmo ano', () => {
  const a2026 = CAL.find((a) => a.year === 2026);
  assert.strictEqual(a2026.realMonths, 5);   // jan..mai/26
  assert.strictEqual(a2026.projMonths, 7);   // jun..dez/26
  assert.strictEqual(a2026.totalMsu, 5 * 100 + 7 * 120);
});
check('crescimento só entre anos COMPLETOS', () => {
  assert.strictEqual(CAL[0].growthPct, null, '2024 é parcial: não tem base');
  assert.strictEqual(CAL[1].growthPct, null, '2024 parcial não serve de base para 2025');
  assert.ok(CAL[2].growthPct > 0, '2025→2026 são completos e devem comparar');
  assert.strictEqual(CAL[3].growthPct, null, '2027 é parcial');
});
check('% do baseline usa o baseline ANUAL', () => {
  const a2025 = CAL.find((a) => a.year === 2025);
  assert.strictEqual(a2025.annualBaselineMsu, 1200);
  assert.strictEqual(Math.round(a2025.vsBaselinePct), 100);
});
check('sem baseline cadastrado, % fica nulo (não zero)', () => {
  const semBase = porAnoCalendario(SERIE, null);
  assert.strictEqual(semBase[0].annualBaselineMsu, null);
  assert.strictEqual(semBase[0].vsBaselinePct, null);
});

console.log('\nAno contratual:');
const CONTRATOS = [
  { _id: 'c1', name: 'ACME 2024', startPeriodKey: '2024-06', endPeriodKey: '2027-05' },
  { _id: 'c2', name: 'ACME 2027', startPeriodKey: '2027-06', endPeriodKey: null },
];
const CT = porAnoContratual(SERIE, CONTRATOS, BASELINE);

check('cliente sem contrato cadastrado devolve hasContracts=false', () => {
  const vazio = porAnoContratual(SERIE, [], BASELINE);
  assert.strictEqual(vazio.hasContracts, false);
  assert.deepStrictEqual(vazio.rows, []);
});
check('a contagem de anos REINICIA no contrato novo', () => {
  assert.deepStrictEqual(
    CT.rows.map((r) => `${r.contractName} ${r.label}`),
    ['ACME 2024 Ano 1', 'ACME 2024 Ano 2', 'ACME 2024 Ano 3']
  );
  // A série acaba em mai/27, último mês do contrato 1: o contrato 2 nem aparece.
  assert.ok(!CT.rows.some((r) => r.contractName === 'ACME 2027'));
});
check('a janela do ano vem do CONTRATO, não dos meses com dado', () => {
  assert.deepStrictEqual(CT.rows.map((r) => r.rangeLabel),
    ['Jun/24–Mai/25', 'Jun/25–Mai/26', 'Jun/26–Mai/27']);
});
check('ano contratual completo com meses projetados continua completo', () => {
  const ano3 = CT.rows[2]; // jun/26–mai/27: tudo projetado
  assert.strictEqual(ano3.months, 12);
  assert.strictEqual(ano3.complete, true);
  assert.strictEqual(ano3.realMonths, 0);
  assert.strictEqual(ano3.projMonths, 12);
});
check('meses antes do contrato viram linha PRÓPRIA, na posição cronológica', () => {
  const historicoAntigo = meses(3, '2024-03', () => 100); // mar–mai/24, antes do contrato
  const r = porAnoContratual(serieUnificada([...historicoAntigo, ...HIST], PROJ), CONTRATOS, BASELINE);
  const fora = r.rows[0];
  assert.strictEqual(fora.inContract, false);
  assert.strictEqual(fora.months, 3);
  assert.strictEqual(fora.rangeLabel, 'Mar/24–Mai/24');
  assert.strictEqual(fora.complete, false, 'fora de contrato nunca é "ano completo"');
  assert.ok(r.rows.slice(1).every((x) => x.inContract), 'o resto é tudo ano de contrato');
});
check('projeção que passa do fim do contrato não infla o último ano', () => {
  const soUmContrato = [{ _id: 'c1', name: 'ACME', startPeriodKey: '2024-06', endPeriodKey: '2026-05' }];
  const r = porAnoContratual(SERIE, soUmContrato, BASELINE);
  const anos = r.rows.filter((x) => x.inContract);
  assert.strictEqual(anos.length, 2, 'o contrato tem 2 anos e só eles podem aparecer');
  assert.ok(anos.every((a) => a.months === 12));
  const fora = r.rows.find((x) => !x.inContract);
  assert.strictEqual(fora.months, 12, 'os 12 meses projetados depois do fim ficam de fora');
  assert.strictEqual(r.rows[r.rows.length - 1], fora, 'o que sobra vem depois do último ano');
});
check('antes e depois do contrato NÃO se fundem numa linha só', () => {
  // Sem isso a linha sairia "Fora de contrato · Mar/24–Mai/27": um intervalo que
  // atravessa o contrato inteiro e não descreve nada.
  const antes = meses(3, '2024-03', () => 100);
  const soUmContrato = [{ _id: 'c1', name: 'ACME', startPeriodKey: '2024-06', endPeriodKey: '2026-05' }];
  const r = porAnoContratual(serieUnificada([...antes, ...HIST], PROJ), soUmContrato, BASELINE);
  const foras = r.rows.filter((x) => !x.inContract);
  assert.strictEqual(foras.length, 2, 'um trecho antes e um depois');
  assert.strictEqual(foras[0].rangeLabel, 'Mar/24–Mai/24');
  assert.strictEqual(foras[1].rangeLabel, 'Jun/26–Mai/27');
});

console.log('\nCoerência entre as duas visões:');
check('as duas fecham o MESMO total de MSU da série', () => {
  const total = SERIE.reduce((a, s) => a + s.totalMsuConsumed, 0);
  assert.strictEqual(CAL.reduce((a, r) => a + r.totalMsu, 0), total);
  assert.strictEqual(CT.rows.reduce((a, r) => a + r.totalMsu, 0), total);
});
check('as duas contam o MESMO número de meses', () => {
  assert.strictEqual(CAL.reduce((a, r) => a + r.months, 0), SERIE.length);
  assert.strictEqual(CT.rows.reduce((a, r) => a + r.months, 0), SERIE.length);
});
check('rotuloCurto encurta o mês sem inventar', () => {
  assert.strictEqual(rotuloCurto('2026-06'), 'Jun/26');
  assert.strictEqual(rotuloCurto('2024-12'), 'Dez/24');
});
check('composição em texto acerta o singular', () => {
  assert.strictEqual(composicao({ realMonths: 1, projMonths: 0 }), '1 mês real');
  assert.strictEqual(composicao({ realMonths: 0, projMonths: 1 }), '1 mês projetado');
  assert.strictEqual(composicao({ realMonths: 1, projMonths: 11 }), '1 real + 11 projetados');
  assert.strictEqual(composicao({ realMonths: 12, projMonths: 0 }), '12 meses reais');
});
check('passo da grade é redondo', () => {
  assert.strictEqual(passoBonito(2100000), 2500000);
  assert.strictEqual(passoBonito(0.9), 1);
  assert.strictEqual(passoBonito(0), 1, 'série constante não pode dividir por zero');
});

/* ── O pacote .pptx ─────────────────────────────────────────────────────── */

const PAYLOAD = {
  client: { _id: 'x', name: 'ACME S/A', monthlyBaselineMsu: BASELINE },
  history: HIST.map((h) => ({ ...h, periodLabel: h.periodKey })),
  forecast: PROJ.map((p) => ({ ...p, periodLabel: p.periodKey })),
  method: 'sarima',
  requestedMethod: 'sarima',
  model: { method: 'sarima', order: 'SARIMA(1,1,1)(0,1,0)[12]', aicc: 257.5, sigma: 112100, observationsUsed: 11 },
  notes: ['Aviso de teste.'],
  years: CAL,
  contractYears: CT.rows,
  hasContractPeriods: true,
  horizonMonths: 12,
};

const abrir = (buf) => {
  const partes = unzipSync(new Uint8Array(buf));
  const texto = {};
  for (const nome of Object.keys(partes)) texto[nome] = strFromU8(partes[nome]);
  return texto;
};

console.log('\nPacote .pptx:');
const gerado = deckCapacityPlanning(PAYLOAD, { hoje: new Date('2026-08-06T12:00:00Z') });
const PARTES = abrir(gerado.buffer);

check('nome do arquivo é legível e sem acento', () => {
  assert.strictEqual(gerado.fileName, 'capacity-planning-acme-s-a-2026-08-06.pptx');
});
check('[Content_Types].xml é a PRIMEIRA entrada do zip', () => {
  assert.strictEqual(Object.keys(PARTES)[0], '[Content_Types].xml');
});
check('tem as partes obrigatórias do PresentationML', () => {
  for (const p of ['_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
    'ppt/theme/theme1.xml', 'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideLayouts/slideLayout1.xml', 'docProps/core.xml']) {
    assert.ok(PARTES[p], `faltou ${p}`);
  }
});
check('todo XML declarado no Content_Types existe de verdade', () => {
  const alvos = [...PARTES['[Content_Types].xml'].matchAll(/PartName="\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(alvos.length >= 8, `poucos overrides: ${alvos.length}`);
  for (const a of alvos) assert.ok(PARTES[a], `declarado mas ausente: ${a}`);
});
check('toda relação aponta para uma parte existente', () => {
  for (const nome of Object.keys(PARTES).filter((n) => n.endsWith('.rels'))) {
    const base = nome.replace(/(^|.*\/)_rels\/[^/]*$/, '$1'); // pasta dona da parte
    for (const m of PARTES[nome].matchAll(/Target="([^"]+)"/g)) {
      // resolve o caminho relativo (…/../…) contra a pasta da parte dona
      const partes = (base + m[1]).split('/');
      const pilha = [];
      for (const p of partes) {
        if (p === '..') pilha.pop();
        else if (p !== '.' && p !== '') pilha.push(p);
      }
      const alvo = pilha.join('/');
      assert.ok(PARTES[alvo], `${nome} aponta para ${alvo}, que não existe`);
    }
  }
});
check('todo slide do sldIdLst tem r:id declarado nas relações', () => {
  const ids = [...PARTES['ppt/presentation.xml'].matchAll(/<p:sldId id="\d+" r:id="(rId\d+)"\/>/g)].map((m) => m[1]);
  assert.strictEqual(ids.length, 5, `capa + gráfico + 2 tabelas + premissas = 5 slides, veio ${ids.length}`);
  for (const id of ids) {
    assert.ok(PARTES['ppt/_rels/presentation.xml.rels'].includes(`Id="${id}"`), `${id} sem relação`);
  }
});
check('a tabela usa a URI de tabela do DrawingML', () => {
  // Com a URI errada o PowerPoint abre e mostra um quadro VAZIO, sem avisar.
  const s3 = PARTES['ppt/slides/slide3.xml'];
  assert.ok(s3.includes('uri="http://schemas.openxmlformats.org/drawingml/2006/table"'), 'URI da tabela errada');
  assert.ok(s3.includes('<a:tbl>') && s3.includes('<a:gridCol'), 'sem tabela no slide de consolidação');
});
check('o slide contratual existe e traz o nome do contrato', () => {
  assert.ok(PARTES['ppt/slides/slide4.xml'].includes('ACME 2024'), 'o nome do contrato não chegou ao slide');
  assert.ok(PARTES['ppt/slides/slide4.xml'].includes('Jun/24–Mai/25'), 'a janela do ano não chegou ao slide');
});
check('sem contrato cadastrado, o slide contratual não é gerado', () => {
  const p = { ...PAYLOAD, hasContractPeriods: false, contractYears: [] };
  const partes = abrir(deckCapacityPlanning(p, { hoje: new Date('2026-08-06T12:00:00Z') }).buffer);
  assert.ok(!partes['ppt/slides/slide5.xml'], 'deveria ter 4 slides');
  assert.ok(partes['ppt/slides/slide4.xml'].includes('Método e premissas'));
});
check('o gráfico é vetor: polilinhas com custGeom, banda preenchida e traço', () => {
  const s2 = PARTES['ppt/slides/slide2.xml'];
  assert.ok(s2.includes('<a:custGeom>'), 'sem geometria personalizada');
  assert.ok(s2.includes('fill="norm"'), 'sem a banda preenchida do intervalo de 95%');
  assert.ok(s2.includes('fill="none"'), 'sem polilinha de traço');
  assert.ok(/<a:srgbClr val="0F62FE"/.test(s2), 'sem a cor do consumo real');
});
check('texto com & e < é escapado (nome de cliente quebra o XML)', () => {
  const p = { ...PAYLOAD, client: { ...PAYLOAD.client, name: 'A & B <Ltda>' } };
  const partes = abrir(deckCapacityPlanning(p, { hoje: new Date('2026-08-06T12:00:00Z') }).buffer);
  assert.ok(partes['ppt/slides/slide1.xml'].includes('A &amp; B &lt;Ltda&gt;'));
  assert.ok(!/<a:t>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/.test(partes['ppt/slides/slide1.xml']));
});
check('tabela longa quebra em vários slides (nada é truncado em silêncio)', () => {
  const muitos = Array.from({ length: 30 }, (_, i) => ({
    year: 2000 + i, realMonths: 12, projMonths: 0, totalMsu: 1200, months: 12,
    complete: true, annualBaselineMsu: 1200, vsBaselinePct: 100, growthPct: 0,
  }));
  const p = { ...PAYLOAD, years: muitos, hasContractPeriods: false, contractYears: [] };
  const partes = abrir(deckCapacityPlanning(p, { hoje: new Date('2026-08-06T12:00:00Z') }).buffer);
  const slides = Object.keys(partes).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.strictEqual(slides.length, 6, `capa + gráfico + 3 páginas de tabela + premissas, veio ${slides.length}`);
  const juntos = slides.map((s) => partes[s]).join('');
  for (const a of muitos) assert.ok(juntos.includes(String(a.year)), `ano ${a.year} sumiu`);
});
check('apresentação sem slide é recusada, não gera zip quebrado', () => {
  assert.throws(() => buildPptx({ slides: [] }), /sem slides/i);
});
check('primitiva desconhecida falha alto', () => {
  assert.throws(() => buildPptx({ slides: [{ shapes: [{ t: 'bolha' }] }] }), /bolha/);
});

console.log(failures === 0 ? '\nDECK: TODOS OS TESTES PASSARAM' : `\nDECK: ${failures} FALHA(S)`);
process.exit(failures === 0 ? 0 : 1);
