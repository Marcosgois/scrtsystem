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

    // A carga é RECONCILIAÇÃO, não "apaga e insere". Duas consequências que
    // precisam ficar travadas:
    const { LsprModel } = require('../src/models');

    // 1. Tabela parcial (import que morreu no meio) se conserta sozinha na
    //    próxima subida. Com o guard antigo `count > 0`, 5 documentos bloqueavam
    //    igual a 3 mil e a tabela ficava capenga em silêncio.
    const cheio = seedRes.count;
    await LsprModel.deleteMany({ machineType: '2094' });
    const parcial = await LsprModel.countDocuments();
    const repara = await seedLspr({ log: () => {} });
    check('tabela parcial é reparada no start (não fica capenga em silêncio)',
      parcial < cheio && repara.seeded === true && repara.count === cheio, { cheio, parcial, depois: repara.count });

    // 2. Reimportar NUNCA esvazia a coleção: se esvaziasse, um contrato ou MO/MES
    //    criado nessa janela congelaria msu/mips nulos num snapshot histórico.
    let vazioEmAlgumMomento = false;
    const vigia = setInterval(async () => {
      if ((await LsprModel.countDocuments()) === 0) vazioEmAlgumMomento = true;
    }, 2);
    await seedLspr({ replace: true, log: () => {} });
    clearInterval(vigia);
    await new Promise((r) => setTimeout(r, 20));
    check('reimportação nunca deixa a tabela vazia', vazioEmAlgumMomento === false);
    check('reimportação mantém o total', (await LsprModel.countDocuments()) === cheio);

    // 3. Contagem não basta como assinatura: uma revisão de VALOR pela IBM (um MSU
    //    corrigido, mesma quantidade de modelos) mudaria o arquivo sem mudar o
    //    total, e o banco ficaria com o número velho para sempre. Por isso a
    //    assinatura é o CONTEÚDO do arquivo, e ela tem de enxergar essa mudança.
    const { digital, CHAVE_META } = require('../src/lsprSeed');
    const base = [{ model: '3931-705', mips: 10129, msu: 1232, cps: 5, machineType: '3931', generation: 'z16', family: 'IBM Z z16/700' }];
    const revisado = [{ ...base[0], msu: 1233 }];
    check('digital muda quando um VALOR muda (mesma quantidade de modelos)',
      digital(base) !== digital(revisado));
    check('digital é estável para o mesmo conteúdo', digital(base) === digital(base.map((m) => ({ ...m }))));

    // 4. Ponta a ponta: é assim que um deploy com arquivo revisado se comporta —
    //    a digital gravada não bate com a do arquivo, então a carga refaz sozinha.
    const { AppMeta } = require('../src/models');
    await AppMeta.updateOne({ key: CHAVE_META }, { $set: { value: 'digital-de-uma-versão-anterior' } }, { upsert: true });
    const revisao = await seedLspr({ log: () => {} });
    check('arquivo revisado (digital diferente) reconcilia sozinho no start',
      revisao.seeded === true && revisao.count === cheio, revisao);
    check('depois de reconciliar, volta a ser no-op', (await seedLspr({ log: () => {} })).seeded === false);
    check('valor de referência intacto após tudo isso',
      (await LsprModel.findOne({ model: '3931-705' }).lean()).msu === 1232);

    // 5. A tabela publicada conhece o z17 ME2 (type 9176), que entrou no zPCR em
    //    ago/2026 — é o caso concreto que motivou trocar o guard.
    const t9176 = await LsprModel.countDocuments({ machineType: '9176' });
    check('referência inclui o type 9176 (z17 ME2 / Rockhopper 5)', t9176 > 0, t9176);

    // ── Login admin ──
    const setup = await fetch(`${BASE}/auth/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', email: 'a@x.com', password: 'admin12399' }),
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
    r = await api(`/clients/${caixaId}/infra/machines/${mId}`, { method: 'PUT', json: { cps: 6, ziips: 2, iflsActive: 4, memoryTB: 8, vfmTB: 2, icfs: 99 } });
    check('PUT grava CP/zIIP/IFL, memória e VFM',
      r.status === 200 && r.body.cps === 6 && r.body.ziips === 2 && r.body.iflsActive === 4 && r.body.memoryTB === 8 && r.body.vfmTB === 2,
      r.body);
    // O ICF saiu do formulário mas o VALOR de produção é preservado: uma
    // requisição direta não pode alterá-lo (14 máquinas têm ICF lá).
    check('campo legado (icfs) NÃO é alterado por requisição direta',
      (r.body.icfs || 0) !== 99, r.body.icfs);

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
