'use strict';

/* Hierarquia de regiões: LA ⊃ Brasil ⊃ clientes, e LA soma os do Brasil mais os
   das outras filhas. Cada cliente pertence a no máximo UMA região, então somar
   irmãs nunca conta o mesmo MSU duas vezes. */

const R = require('../src/regions');

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

// LA ⊃ { Brasil ⊃ { Sul }, Chile }   ·   EMEA (solta)
const regions = [
  { _id: 'la', name: 'LA', parent: null },
  { _id: 'br', name: 'Brasil', parent: 'la' },
  { _id: 'sul', name: 'Sul', parent: 'br' },
  { _id: 'cl', name: 'Chile', parent: 'la' },
  { _id: 'emea', name: 'EMEA', parent: null },
];
const clients = [
  { _id: 'c1', name: 'CAIXA', region: 'br' },
  { _id: 'c2', name: 'BRB', region: 'br' },
  { _id: 'c3', name: 'Banrisul', region: 'sul' },
  { _id: 'c4', name: 'BancoEstado', region: 'cl' },
  { _id: 'c5', name: 'Deutsche', region: 'emea' },
  { _id: 'c6', name: 'SemRegiao', region: null },
];

const nomes = (l) => l.map((c) => c.name).sort();

// ── clientes por região, herdando das descendentes ──
check('Brasil traz os próprios + os do Sul',
  String(nomes(R.clientesDaRegiao(regions, clients, 'br'))) === String(['BRB', 'Banrisul', 'CAIXA'].sort()),
  nomes(R.clientesDaRegiao(regions, clients, 'br')));

check('LA herda Brasil, Sul e Chile',
  String(nomes(R.clientesDaRegiao(regions, clients, 'la'))) === String(['BRB', 'BancoEstado', 'Banrisul', 'CAIXA'].sort()),
  nomes(R.clientesDaRegiao(regions, clients, 'la')));

check('LA NÃO puxa cliente de EMEA', !nomes(R.clientesDaRegiao(regions, clients, 'la')).includes('Deutsche'));
check('cliente sem região não entra em nenhuma',
  !nomes(R.clientesDaRegiao(regions, clients, 'la')).includes('SemRegiao'));

// O ponto de "só uma região": somar irmãs dá o total do pai, sem repetição.
const somaIrmas = R.clientesDaRegiao(regions, clients, 'br').length + R.clientesDaRegiao(regions, clients, 'cl').length;
check('somar as irmãs (Brasil + Chile) dá exatamente o total de LA — sem contar duas vezes',
  somaIrmas === R.clientesDaRegiao(regions, clients, 'la').length, { somaIrmas, la: R.clientesDaRegiao(regions, clients, 'la').length });

// ── caminho ──
check('caminho do Sul é LA › Brasil › Sul',
  String(R.caminho(regions, 'sul')) === String(['LA', 'Brasil', 'Sul']), R.caminho(regions, 'sul'));

// ── árvore com contagem ──
const arvore = R.montarArvore(regions, clients);
const la = arvore.find((r) => r._id === 'la');
check('a árvore tem 2 raízes (LA e EMEA)', arvore.length === 2, arvore.map((r) => r.name));
check('LA conta 4 clientes no total e 0 diretos', la.totalClientes === 4 && la.clientesDiretos === 0,
  { total: la.totalClientes, diretos: la.clientesDiretos });
const br = la.filhas.find((f) => f._id === 'br');
check('Brasil conta 3 no total (2 diretos + 1 do Sul)', br.totalClientes === 3 && br.clientesDiretos === 2,
  { total: br.totalClientes, diretos: br.clientesDiretos });

// ── proteção contra ciclo (o que travaria o servidor) ──
check('não deixa a região ser pai dela mesma', !!R.validarPai(regions, 'br', 'br'));
check('não deixa LA virar filha do Brasil (que está dentro dela)', !!R.validarPai(regions, 'la', 'br'));
check('mover Chile para dentro do Brasil é permitido', R.validarPai(regions, 'cl', 'br') === null);

// Dado já corrompido no banco não pode travar o percurso.
const ciclo = [
  { _id: 'a', name: 'A', parent: 'b' },
  { _id: 'b', name: 'B', parent: 'a' },
];
const t0 = Date.now();
const desc = R.comDescendentes(ciclo, 'a');
const arv = R.montarArvore(ciclo, []);
const cam = R.caminho(ciclo, 'a');
check('ciclo A↔B não trava o percurso', Date.now() - t0 < 1000 && desc.length <= 2, { ms: Date.now() - t0, desc: desc.length });
check('ciclo não trava a árvore nem o caminho', Array.isArray(arv) && Array.isArray(cam), { arv: arv.length, cam });

if (failures) { console.error(`\nREGIÕES: ${failures} FALHA(S)`); process.exit(1); }
console.log('\nREGIÕES: TODOS OS TESTES PASSARAM');
