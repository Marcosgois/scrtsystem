'use strict';

/* Trilha de auditoria: captura automática de mutações (create/update/delete com
   diff), login/logout, negações, sanitização de senha, filtros e CSV. */

const assert = require('assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}/api`;

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function session() {
  let cookie = '';
  const req = async (pathname, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    const res = await fetch(`${BASE}${pathname}`, { method: opts.method, headers, body: opts.body });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };
  return { req };
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('tfpsystem-audit');
  process.env.PORT = String(PORT);
  process.env.LOG_REQUESTS = 'off'; process.env.LOG_FILE = '0'; process.env.LOG_AUTH = '0';
  const { connectDb } = require('../src/db');
  const { app } = require('../server');
  await connectDb(process.env.MONGODB_URI);
  const server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));

  const admin = session();
  await admin.req('/auth/setup', { method: 'POST', json: { name: 'Admin', email: 'admin@x.com', password: 'admin123456' } });

  // cria cliente, edita, cria máquina, edita, apaga máquina
  const caixa = (await admin.req('/clients', { method: 'POST', json: { name: 'CAIXA' } })).body;
  await admin.req(`/clients/${caixa._id}`, { method: 'PATCH', json: { monthlyBaselineMsu: 500 } });
  const maq = (await admin.req(`/clients/${caixa._id}/infra/machines`, { method: 'POST', json: { model: '3931-7C6', serial: 'ABC123' } })).body;
  await admin.req(`/clients/${caixa._id}/infra/machines/${maq._id}`, { method: 'PUT', json: { cps: 4 } });
  await admin.req(`/clients/${caixa._id}/infra/machines/${maq._id}`, { method: 'DELETE' });

  // cria um usuário view (para testar negação e sanitização de senha)
  await admin.req('/admin/users', { method: 'POST', json: { name: 'Vera', email: 'vera@x.com', password: 'vera123456', role: 'user', access: [] } });
  const vera = session();
  await vera.req('/auth/login', { method: 'POST', json: { email: 'vera@x.com', password: 'vera123456' } });
  await vera.req(`/clients/${caixa._id}`, { method: 'PATCH', json: { monthlyBaselineMsu: 9 } }); // deve dar 403 (negado)
  await vera.req('/auth/logout', { method: 'POST' });

  await sleep(500); // deixa as gravações assíncronas (res 'finish') caírem

  const all = (await admin.req('/admin/audit?limit=500')).body;
  const items = all.items || [];
  const byAction = (a) => items.filter((e) => e.action === a);

  check('há entradas na trilha', items.length >= 8, items.length);
  check('setup do 1º admin registrado', byAction('setup').some((e) => e.actor && e.actor.email === 'admin@x.com'));
  check('login registrado com o e-mail certo', byAction('login').some((e) => e.actor && e.actor.email === 'vera@x.com'));
  check('logout registrado', byAction('logout').some((e) => e.actor && e.actor.email === 'vera@x.com'));

  const criouCliente = byAction('create').find((e) => e.entity && e.entity.type === 'Client' && e.entity.label === 'CAIXA');
  check('criação do cliente registrada com rótulo', !!criouCliente);

  const editouCliente = byAction('update').find((e) => e.entity && e.entity.type === 'Client');
  check('edição do cliente tem diff do campo', !!(editouCliente && editouCliente.changes && editouCliente.changes.find((c) => c.field === 'monthlyBaselineMsu' && c.to === 500)), editouCliente && editouCliente.changes);

  const editouMaq = byAction('update').find((e) => e.entity && e.entity.type === 'InfraMachine');
  check('edição da máquina tem diff (cps 4)', !!(editouMaq && editouMaq.changes && editouMaq.changes.find((c) => c.field === 'cps' && c.to === 4)), editouMaq && editouMaq.changes);

  const apagou = byAction('delete').find((e) => e.entity && e.entity.type === 'InfraMachine');
  check('exclusão da máquina guarda o "antes"', !!(apagou && apagou.before && apagou.before.serial === 'ABC123'), apagou && apagou.before);

  const negado = byAction('negado');
  check('tentativa negada registrada', negado.some((e) => e.actor && e.actor.email === 'vera@x.com'), negado.length);

  // sanitização: nenhuma entrada pode conter senha/hash/salt em lugar nenhum
  const bruto = JSON.stringify(items);
  check('nunca vaza senha (password)', !/vera123456|admin123456/.test(bruto));
  check('nunca vaza passwordHash/Salt', !/passwordHash|passwordSalt/.test(bruto));
  const criouUser = byAction('create').find((e) => e.entity && e.entity.type === 'User');
  check('criação de usuário registrada (sem senha)', !!criouUser && !/password/i.test(JSON.stringify(criouUser)));

  // filtros
  const soCreate = (await admin.req('/admin/audit?action=create')).body.items;
  check('filtro por ação=create', soCreate.length > 0 && soCreate.every((e) => e.action === 'create'));
  const soCaixa = (await admin.req(`/admin/audit?client=${caixa._id}`)).body.items;
  check('filtro por cliente', soCaixa.length > 0 && soCaixa.every((e) => e.client && String(e.client.id) === String(caixa._id)));

  // CSV
  const csv = await fetch(`${BASE}/admin/audit.csv`, { headers: { Cookie: 'zcd_session=' } }); // sem cookie → 401
  check('CSV exige admin (sem sessão -> 401)', csv.status === 401, csv.status);
  const csvOk = await admin.req('/admin/audit.csv');
  check('CSV do admin traz cabeçalho', typeof csvOk.body === 'string' && csvOk.body.includes('data_hora,quem,acao'), String(csvOk.body).slice(0, 40));

  await server.close();
  await mongod.stop();
  if (failures) { console.error(`\nAUDITORIA: ${failures} FALHA(S)`); process.exit(1); }
  console.log('\nAUDITORIA: TODOS OS TESTES PASSARAM');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
