'use strict';

/*
 * Reproduz um banco criado por versão anterior do TFPSystem (índice único
 * {client, periodKey} e relatórios sem sourceKey) e verifica que a conexão
 * migra a base para o modelo atual, no qual um mês pode ter vários SCRTs.
 */

const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SCN = path.join(__dirname, '..', 'SCRT', 'BRB', 'SCRT - Janeiro 2026 - SCN.csv');
const SIG = path.join(__dirname, '..', 'SCRT', 'BRB', 'SCRT - Janeiro 2026 - SIG.csv');
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}/api`;

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

async function api(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, opts);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function uploadForm(filePath, fileName) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), fileName);
  return form;
}

async function main() {
  console.log('Preparando banco no formato ANTIGO…');
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri('tfpsystem-migracao');
  process.env.MONGODB_URI = uri;
  process.env.PORT = String(PORT);

  const mongoose = require('mongoose');
  const { MongoClient, ObjectId } = require('mongodb');

  // 1) Estado legado: índice único por cliente+mês e um relatório sem sourceKey.
  const raw = new MongoClient(uri);
  await raw.connect();
  const db = raw.db();
  const clientId = new ObjectId();
  await db.collection('clients').insertOne({ _id: clientId, name: 'BRB', lparGroups: [] });
  await db.collection('scrtreports').createIndex({ client: 1, periodKey: 1 }, { unique: true });
  await db.collection('scrtreports').insertOne({
    client: clientId,
    periodKey: '2026-01',
    periodLabel: 'Jan/2026',
    totalMsuConsumed: 82576,
    machines: [{ identifier: '82-967B8', serialNumber: '82-967B8' }],
    lpars: [],
    containers: [],
    warnings: [],
    sourceFileName: 'SCRT - Janeiro 2026 - SCN.csv',
  });
  const antes = await db.collection('scrtreports').indexes();
  check('cenário: banco tem o índice antigo client_1_periodKey_1',
    antes.some((i) => i.name === 'client_1_periodKey_1'), antes.map((i) => i.name));
  await raw.close();

  // 2) Conexão da aplicação: deve migrar a base.
  const { connectDb } = require('../src/db');
  const { app } = require('../server');
  await connectDb(uri);
  const server = app.listen(PORT);

  try {
    const indexes = await mongoose.connection.db.collection('scrtreports').indexes();
    check('migração: índice antigo removido',
      !indexes.some((i) => i.name === 'client_1_periodKey_1'), indexes.map((i) => i.name));
    check('migração: índice novo {client, periodKey, sourceKey} criado',
      indexes.some((i) => i.key && i.key.client === 1 && i.key.periodKey === 1 && i.key.sourceKey === 1),
      indexes.map((i) => i.name));

    const legado = await mongoose.connection.db.collection('scrtreports').findOne({ periodKey: '2026-01' });
    check('migração: relatório antigo recebeu sourceKey pelas máquinas',
      legado.sourceKey === '82-967B8', legado.sourceKey);

    // 3) O caso que quebrava: subir o segundo SCRT do mesmo mês.
    let r = await api(`/clients/${clientId}/reports`, { method: 'POST', body: uploadForm(SIG, 'SCRT - Janeiro 2026 - SIG.csv') });
    check('2º SCRT do mesmo mês agora é aceito (sem E11000)',
      r.status === 201, { status: r.status, erro: r.body && r.body.error });
    check('mês soma as duas origens: 82.576 + 520.762 = 603.338',
      r.body.month && r.body.month.totalMsuConsumed === 603338, r.body.month);
    check('mês passa a ter 2 origens', r.body.month && r.body.month.sourceCount === 2);

    // 4) Reenvio do relatório legado continua substituindo (não duplica).
    r = await api(`/clients/${clientId}/reports`, { method: 'POST', body: uploadForm(SCN, 'SCRT - Janeiro 2026 - SCN.csv') });
    check('reenvio do SCRT legado substitui a origem, mantendo 2 no mês',
      r.status === 200 && r.body.replaced === true && r.body.month.sourceCount === 2 &&
      r.body.month.totalMsuConsumed === 603338,
      { status: r.status, replaced: r.body.replaced, n: r.body.month && r.body.month.sourceCount });

    // 5) Rodar a migração de novo (restart do servidor) não deve quebrar nada.
    await connectDb(uri);
    check('migração é idempotente (2ª execução sem erro)', true);
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }

  console.log(failures === 0 ? '\nMIGRAÇÃO: TODOS OS TESTES PASSARAM' : `\nMIGRAÇÃO: ${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
