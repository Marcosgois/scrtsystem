'use strict';

/* LSPR (referência de capacidade) + importação de máquinas do SCRT para a infra. */

const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

const CAIXA_SCRT = path.join(__dirname, '..', 'SCRT', 'CAIXA', '#JUN2026.csv');
const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}/api`;

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

let authCookie = '';
async function api(pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (authCookie) headers.Cookie = authCookie;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(`${BASE}${pathname}`, { method: opts.method, headers, body: opts.body });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
function uploadForm(filePath, fileName) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), fileName);
  return form;
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('tfpsystem-lspr');
  process.env.PORT = String(PORT);
  process.env.SCRT_FILES_DIR = path.join(require('os').tmpdir(), `scrt-lspr-${process.pid}`);

  process.env.LOG_REQUESTS = 'off';   // teste não precisa do log de acesso
  process.env.LOG_FILE = '0';
  process.env.LOG_AUTH = '0';
  const { connectDb } = require('../src/db');
  const { app } = require('../server');
  const { seedLspr } = require('../src/lsprSeed');
  await connectDb(process.env.MONGODB_URI);
  const server = app.listen(PORT);

  try {
    // ── Seed da referência LSPR ──
    const seedRes = await seedLspr({ log: () => {} });
    check('seed LSPR popula a coleção', seedRes.seeded && seedRes.count > 2000, seedRes);
    const seedAgain = await seedLspr({ log: () => {} });
    check('seed é idempotente (não repopula)', seedAgain.seeded === false, seedAgain);

    // ── Login admin ──
    const setup = await fetch(`${BASE}/auth/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', email: 'a@x.com', password: 'admin123' }),
    });
    authCookie = (setup.headers.get('set-cookie') || '').split(';')[0];
    check('admin logado', setup.status === 201 && /zcd_session=/.test(authCookie), setup.status);

    // ── Consulta LSPR ──
    let r = await api('/lspr/meta');
    check('GET /lspr/meta traz total e gerações', r.body.total > 2000 && r.body.generations.includes('z16'), r.body);

    r = await api('/lspr/3931-705');
    check('GET /lspr/:model devolve MIPS/MSU/CPs', r.status === 200 && r.body.msu === 1232 && r.body.cps === 5, r.body);

    r = await api('/lspr/9999-999');
    check('GET /lspr/:model inexistente -> 404', r.status === 404, r.status);

    r = await api('/lspr?type=9175&limit=5');
    check('GET /lspr?type filtra por machineType', r.body.length === 5 && r.body.every((m) => m.machineType === '9175'), r.body.map((m) => m.model));

    r = await api('/lspr?q=9175-760');
    check('GET /lspr?q busca por modelo', r.body.some((m) => m.model === '9175-760'), r.body.length);

    // ── Cliente + SCRT ──
    r = await api('/clients', { method: 'POST', json: { name: 'CAIXA' } });
    const caixaId = r.body._id;
    r = await api(`/clients/${caixaId}/reports`, { method: 'POST', body: uploadForm(CAIXA_SCRT, '#JUN2026.csv') });
    check('SCRT carregado (6 máquinas)', r.status === 201 && r.body.report.machines.length === 6, r.body && r.status);

    // ── Import: sem máquinas ainda ──
    r = await api(`/clients/${caixaId}/infra/machines`);
    check('infra começa sem máquinas', r.body.length === 0, r.body.length);

    r = await api(`/clients/${caixaId}/infra/machines/import-scrt`, { method: 'POST' });
    check('import cria máquinas do SCRT', r.status === 200 && r.body.created > 0, r.body);
    check('import liga ao LSPR pelo type-model', r.body.linked > 0, r.body);
    const importInfo = r.body;

    r = await api(`/clients/${caixaId}/infra/machines`);
    const machines = r.body;
    check('máquinas importadas aparecem na infra', machines.length === importInfo.created, { got: machines.length, created: importInfo.created });
    const withLspr = machines.filter((m) => m.lspr);
    check('máquina importada traz referência LSPR (m.lspr)', withLspr.length > 0, withLspr.length);
    const sample = withLspr[0];
    check('LSPR anexado tem MSU/MIPS/CPs', sample.lspr && sample.lspr.msu > 0 && sample.lspr.mips > 0, sample && sample.lspr);
    check('serial normalizado em maiúsculas', machines.every((m) => m.serial === m.serial.toUpperCase()), machines.map((m) => m.serial));

    // ── Re-import: idempotente (não duplica) ──
    r = await api(`/clients/${caixaId}/infra/machines/import-scrt`, { method: 'POST' });
    check('reimport não cria duplicatas', r.status === 200 && r.body.created === 0, r.body);
    r = await api(`/clients/${caixaId}/infra/machines`);
    check('total de máquinas estável após reimport', r.body.length === machines.length, { after: r.body.length, before: machines.length });

    // ── Ajuste manual do vínculo LSPR ──
    const mId = machines[0]._id;
    r = await api(`/clients/${caixaId}/infra/machines/${mId}`, { method: 'PUT', json: { lsprModel: '3931-705' } });
    check('PUT grava lsprModel manual', r.status === 200 && r.body.lsprModel === '3931-705', r.body && r.body.lsprModel);
    r = await api(`/clients/${caixaId}/infra/machines/${mId}`);
    check('GET máquina reflete o novo LSPR (3931-705)', r.body.lspr && r.body.lspr.msu === 1232, r.body && r.body.lspr);

    // ── Processadores (CP/zIIP/IFL/CF) e memória ──
    r = await api(`/clients/${caixaId}/infra/machines/${mId}`, { method: 'PUT', json: { cps: 6, ziips: 2, iflsActive: 4, icfs: 1, memoryTB: 8, memoryAddTB: 2 } });
    check('PUT grava CP/zIIP/IFL/CF e memória',
      r.status === 200 && r.body.cps === 6 && r.body.ziips === 2 && r.body.iflsActive === 4 && r.body.icfs === 1 && r.body.memoryTB === 8 && r.body.memoryAddTB === 2,
      r.body);

    // ── Cliente sem SCRT ──
    r = await api('/clients', { method: 'POST', json: { name: 'VAZIO' } });
    const vazioId = r.body._id;
    r = await api(`/clients/${vazioId}/infra/machines/import-scrt`, { method: 'POST' });
    check('import sem SCRT -> 422', r.status === 422, r.status);

  } catch (e) {
    failures++;
    console.error('  ✗ exceção', e && e.stack || e);
  } finally {
    server.close();
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    await mongod.stop();
  }

  console.log(failures ? `\nINFRA/LSPR: ${failures} FALHA(S)` : '\nINFRA/LSPR: TODOS OS TESTES PASSARAM');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
