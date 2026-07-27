'use strict';

/* Autenticação e autorização: setup do 1º admin, criação de usuários pelo admin,
   e a matriz de acesso (admin vê tudo; 'edit' edita só o seu cliente; 'view' só
   lê o seu cliente; ninguém acessa cliente sem permissão nem a área de admin). */

const assert = require('assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}/api`;

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

// Cada "sessão" carrega seu próprio cookie.
function session() {
  let cookie = '';
  const req = async (pathname, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    const res = await fetch(`${BASE}${pathname}`, { method: opts.method, headers, body: opts.body });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };
  return { req, hasCookie: () => /zcd_session=/.test(cookie) };
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('tfpsystem-auth');
  process.env.PORT = String(PORT);

  process.env.LOG_REQUESTS = 'off';   // teste não precisa do log de acesso
  process.env.LOG_FILE = '0';
  process.env.LOG_AUTH = '0';
  const { connectDb } = require('../src/db');
  const { app } = require('../server');
  await connectDb(process.env.MONGODB_URI);
  const server = app.listen(PORT);

  try {
    // ── Setup do primeiro admin ──
    const admin = session();
    let r = await admin.req('/auth/status');
    check('status inicial: needsSetup', r.body.needsSetup === true, r.body);

    r = await admin.req('/clients');
    check('sem login: /clients -> 401', r.status === 401, r.status);

    r = await admin.req('/auth/setup', { method: 'POST', json: { name: 'Admin', email: 'admin@x.com', password: 'admin123' } });
    check('setup cria admin e loga', r.status === 201 && r.body.role === 'admin' && admin.hasCookie(), r.body);

    r = await admin.req('/auth/setup', { method: 'POST', json: { name: 'Outro', email: 'outro@x.com', password: 'x123456' } });
    check('setup de novo -> 409 (já há usuários)', r.status === 409, r.status);

    // ── Admin cria clientes ──
    const caixa = (await admin.req('/clients', { method: 'POST', json: { name: 'CAIXA' } })).body;
    const bb = (await admin.req('/clients', { method: 'POST', json: { name: 'BB' } })).body;
    check('admin cria 2 clientes', !!caixa._id && !!bb._id, { caixa: caixa._id, bb: bb._id });

    r = await admin.req('/clients');
    check('admin vê todos os clientes com accessLevel=admin',
      r.body.length === 2 && r.body.every((c) => c.accessLevel === 'admin'), r.body.map((c) => c.accessLevel));

    // ── Admin cria usuários (view e edit) ──
    r = await admin.req('/admin/users', { method: 'POST', json: {
      name: 'Vera View', email: 'view@x.com', password: 'view123', role: 'user',
      access: [{ client: caixa._id, level: 'view' }],
    } });
    check('cria usuário view (CAIXA)', r.status === 201 && r.body.access.length === 1 && r.body.access[0].level === 'view', r.body);

    r = await admin.req('/admin/users', { method: 'POST', json: {
      name: 'Edu Edit', email: 'edit@x.com', password: 'edit123', role: 'user',
      access: [{ client: caixa._id, level: 'edit' }],
    } });
    check('cria usuário edit (CAIXA)', r.status === 201 && r.body.access[0].level === 'edit', r.body);

    r = await admin.req('/admin/users', { method: 'POST', json: { name: 'X', email: 'view@x.com', password: 'y12345', role: 'user' } });
    check('e-mail duplicado -> 409', r.status === 409, r.status);

    r = await admin.req('/admin/users');
    check('admin lista 3 usuários', r.body.length === 3, r.body.length);

    // ── Sessão VIEW ──
    const view = session();
    r = await view.req('/auth/login', { method: 'POST', json: { email: 'view@x.com', password: 'errada' } });
    check('login com senha errada -> 401', r.status === 401, r.status);

    r = await view.req('/auth/login', { method: 'POST', json: { email: 'view@x.com', password: 'view123' } });
    check('view faz login', r.status === 200 && view.hasCookie(), r.body);

    r = await view.req('/clients');
    check('view só enxerga a CAIXA (accessLevel=view)',
      r.body.length === 1 && r.body[0]._id === caixa._id && r.body[0].accessLevel === 'view', r.body);

    r = await view.req(`/clients/${caixa._id}/dashboard`);
    check('view LÊ o dashboard da CAIXA', r.status === 200, r.status);

    r = await view.req(`/clients/${caixa._id}`, { method: 'PATCH', json: { monthlyBaselineMsu: 1 } });
    check('view NÃO edita a CAIXA -> 403', r.status === 403, r.status);

    r = await view.req(`/clients/${bb._id}/dashboard`);
    check('view NÃO acessa a BB -> 403', r.status === 403, r.status);

    r = await view.req('/clients', { method: 'POST', json: { name: 'Nova' } });
    check('view NÃO cria cliente -> 403', r.status === 403, r.status);

    r = await view.req('/admin/users');
    check('view NÃO acessa /admin -> 403', r.status === 403, r.status);

    // ── Sessão EDIT ──
    const edit = session();
    await edit.req('/auth/login', { method: 'POST', json: { email: 'edit@x.com', password: 'edit123' } });
    r = await edit.req(`/clients/${caixa._id}`, { method: 'PATCH', json: { monthlyBaselineMsu: 123 } });
    check('edit EDITA a CAIXA -> 200', r.status === 200, { status: r.status, err: r.body && r.body.error });

    r = await edit.req(`/clients/${caixa._id}`, { method: 'DELETE' });
    check('edit NÃO exclui cliente (só admin) -> 403', r.status === 403, r.status);

    r = await edit.req(`/clients/${bb._id}`, { method: 'PATCH', json: { monthlyBaselineMsu: 9 } });
    check('edit NÃO edita a BB -> 403', r.status === 403, r.status);

    // ── Admin edita acesso do view: promove a edit na BB ──
    const viewUser = (await admin.req('/admin/users')).body.find((u) => u.email === 'view@x.com');
    r = await admin.req(`/admin/users/${viewUser._id}`, { method: 'PUT', json: {
      access: [{ client: caixa._id, level: 'view' }, { client: bb._id, level: 'edit' }],
    } });
    check('admin concede à Vera acesso edit na BB', r.status === 200 && r.body.access.length === 2, r.body.access);

    r = await view.req(`/clients/${bb._id}`, { method: 'PATCH', json: { monthlyBaselineMsu: 7 } });
    check('agora a Vera EDITA a BB -> 200', r.status === 200, r.status);

    // ── Proteções de admin ──
    r = await admin.req(`/admin/users/${(await admin.req('/admin/users')).body.find((u) => u.email === 'admin@x.com')._id}`, { method: 'DELETE' });
    check('admin não exclui a si mesmo -> 422', r.status === 422, r.status);

    // ── Logout ──
    r = await view.req('/auth/logout', { method: 'POST' });
    check('logout ok', r.status === 200, r.status);
    r = await view.req('/clients');
    check('após logout: /clients -> 401', r.status === 401, r.status);

  } catch (e) {
    failures++;
    console.error('  ✗ exceção', e && e.message);
  } finally {
    server.close();
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    await mongod.stop();
  }

  console.log(failures ? `\nAUTH: ${failures} FALHA(S)` : '\nAUTH: TODOS OS TESTES PASSARAM');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
