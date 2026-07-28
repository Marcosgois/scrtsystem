'use strict';

/*
 * Sincroniza o banco entre o servidor (fonte da verdade) e esta máquina (cópia).
 *
 *   npm run db:status   # compara os dois lados, não escreve nada
 *   npm run db:pull     # servidor  → local   (mantém a cópia local em dia)
 *   npm run db:push     # local     → servidor (só para a carga inicial)
 *
 * Por que não um replica set de verdade: um membro secundário precisa ser
 * alcançável PELO primário. Um notebook atrás de NAT, que passa a maior parte do
 * tempo desligado, não é — e um secundário inalcançável só atrapalha o primário.
 * Cópia periódica por pull resolve o que se quer aqui (ter sempre uma cópia) sem
 * fragilizar o servidor.
 *
 * ATENÇÃO: isto copia apenas o BANCO. Os PDFs de contrato e os SCRTs originais
 * ficam em data/contract-files e data/scrt-files, no disco — veja o README para
 * o rsync que acompanha.
 *
 * Credenciais só via ambiente (.env, que não é versionado):
 *   SYNC_REMOTE_URI=mongodb://usuario:senha@host:27017/?authSource=admin
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const DB = process.env.SYNC_DB_NAME || 'tfpsystem';
const REMOTA = process.env.SYNC_REMOTE_URI || '';
const LOCAL = process.env.SYNC_LOCAL_URI
  || `mongodb://127.0.0.1:${process.env.LOCAL_DB_PORT || 27017}`;

const args = process.argv.slice(2);
const tem = (f) => args.includes(f);
const LOTE = 500;

/** Esconde a senha ao mostrar a URI. */
const seguro = (uri) => String(uri).replace(/\/\/[^@]*@/, '//***@');

function abortar(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function inventario(client) {
  const db = client.db(DB);
  const cols = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();
  const out = [];
  for (const nome of cols) out.push({ nome, n: await db.collection(nome).countDocuments() });
  return out;
}

function tabela(origem, destino) {
  const nomes = [...new Set([...origem, ...destino].map((c) => c.nome))].sort();
  const conta = (lista, nome) => (lista.find((c) => c.nome === nome) || { n: 0 }).n;
  console.log(`\n  ${'coleção'.padEnd(20)} ${'origem'.padStart(8)} ${'destino'.padStart(9)}`);
  console.log(`  ${'-'.repeat(20)} ${'-'.repeat(8)} ${'-'.repeat(9)}`);
  for (const nome of nomes) {
    const o = conta(origem, nome);
    const d = conta(destino, nome);
    const marca = o === d ? ' ' : '≠';
    console.log(`  ${nome.padEnd(20)} ${String(o).padStart(8)} ${String(d).padStart(9)}  ${marca}`);
  }
  const to = origem.reduce((a, c) => a + c.n, 0);
  const td = destino.reduce((a, c) => a + c.n, 0);
  console.log(`  ${'TOTAL'.padEnd(20)} ${String(to).padStart(8)} ${String(td).padStart(9)}\n`);
  return { to, td };
}

/** Copia coleção a coleção, substituindo o destino. Nunca escreve na origem. */
async function copiar(cliOrigem, cliDestino) {
  const dbO = cliOrigem.db(DB);
  const dbD = cliDestino.db(DB);
  const cols = await inventario(cliOrigem);
  for (const { nome, n } of cols) {
    process.stdout.write(`  ${nome.padEnd(20)} `);
    await dbD.collection(nome).deleteMany({});          // substitui, não mescla
    let copiados = 0;
    const cursor = dbO.collection(nome).find({});
    let lote = [];
    for await (const doc of cursor) {
      lote.push(doc);
      if (lote.length >= LOTE) {
        await dbD.collection(nome).insertMany(lote, { ordered: false });
        copiados += lote.length; lote = [];
        process.stdout.write('.');
      }
    }
    if (lote.length) { await dbD.collection(nome).insertMany(lote, { ordered: false }); copiados += lote.length; }
    console.log(` ${copiados}/${n}`);
  }
  // Índices são recriados pela aplicação no start (connectDb faz .init()).
  return cols.reduce((a, c) => a + c.n, 0);
}

async function main() {
  const modo = tem('--pull') ? 'pull' : tem('--push') ? 'push' : tem('--status') ? 'status' : null;
  if (!modo) abortar('Escolha a direção: --status, --pull (servidor→local) ou --push (local→servidor).');
  if (!REMOTA) abortar('Defina SYNC_REMOTE_URI no .env (a URI do servidor). Ele não é versionado.');

  const cliR = new MongoClient(REMOTA, { serverSelectionTimeoutMS: 12000 });
  const cliL = new MongoClient(LOCAL, { serverSelectionTimeoutMS: 8000 });
  try {
    await cliR.connect().catch((e) => abortar(`Não conectou no servidor (${seguro(REMOTA)}): ${e.message}`));
    await cliL.connect().catch((e) => abortar(`Não conectou no banco local (${LOCAL}). O servidor local está no ar? ${e.message}`));

    // Trava de segurança: origem e destino não podem ser o mesmo servidor.
    const [hR, hL] = await Promise.all([
      cliR.db().admin().serverStatus().then((s) => s.host).catch(() => 'remoto'),
      cliL.db().admin().serverStatus().then((s) => s.host).catch(() => 'local'),
    ]);
    if (hR === hL) abortar(`Origem e destino são o MESMO servidor (${hR}). Confira SYNC_REMOTE_URI.`);

    console.log(`\n  servidor : ${seguro(REMOTA)}  [${hR}]`);
    console.log(`  local    : ${LOCAL}  [${hL}]`);
    console.log(`  banco    : ${DB}`);

    const [invR, invL] = await Promise.all([inventario(cliR), inventario(cliL)]);

    if (modo === 'status') {
      console.log('\n  Comparação (servidor × local):');
      tabela(invR, invL);
      console.log('  Nada foi alterado.\n');
      return;
    }

    const puxando = modo === 'pull';
    const [origem, destino] = puxando ? [invR, invL] : [invL, invR];
    const [cliOrigem, cliDestino] = puxando ? [cliR, cliL] : [cliL, cliR];
    console.log(`\n  Direção: ${puxando ? 'SERVIDOR → LOCAL' : 'LOCAL → SERVIDOR'}`);
    const { to, td } = tabela(origem, destino);

    // Não deixa uma origem vazia apagar um destino com dados por engano.
    if (to === 0 && td > 0 && !tem('--force')) {
      abortar(`A origem está vazia e o destino tem ${td} documento(s). Isso apagaria tudo.\n`
        + '  Se é mesmo o que você quer, repita com --force.');
    }
    if (!tem('--yes')) {
      console.log(`  Isto SUBSTITUI as coleções do destino (${td} doc) pelas da origem (${to} doc).`);
      console.log('  Nada foi feito. Repita com --yes para executar.\n');
      return;
    }

    console.log('');
    const total = await copiar(cliOrigem, cliDestino);
    const confere = await inventario(cliDestino);
    const fim = confere.reduce((a, c) => a + c.n, 0);
    console.log(`\n  ✓ ${total} documento(s) copiados · destino agora com ${fim}.`);
    if (fim !== to) console.log(`  ⚠ origem tinha ${to} — confira acima.`);
    console.log('  Lembre dos arquivos em data/scrt-files e data/contract-files (ver README).\n');
  } finally {
    await cliR.close().catch(() => {});
    await cliL.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
