'use strict';

/*
 * Contratos (repositório, vínculos com máquinas e PIDs, arquivos) e o ciclo de
 * vida MO/MES das máquinas (proposta → contratado → executado, e o desfazer).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}/api`;
const FILES_DIR = path.join(os.tmpdir(), `contratos-test-${process.pid}`);

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

function session() {
  let cookie = '';
  const req = async (pathname, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    let body = opts.body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    const res = await fetch(`${BASE}${pathname}`, { method: opts.method || 'GET', headers, body });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed, headers: res.headers };
  };
  return { req, raw: (p, o = {}) => fetch(`${BASE}${p}`, { ...o, headers: { ...(o.headers || {}), Cookie: cookie } }) };
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('tfpsystem-contratos');
  process.env.PORT = String(PORT);
  process.env.CONTRACT_FILES_DIR = FILES_DIR;
  process.env.SCRT_FILES_DIR = path.join(os.tmpdir(), `contratos-scrt-${process.pid}`);

  process.env.LOG_REQUESTS = 'off';   // teste não precisa do log de acesso
  process.env.LOG_FILE = '0';
  process.env.LOG_AUTH = '0';
  const { connectDb } = require('../src/db');
  const { app } = require('../server');
  await connectDb(process.env.MONGODB_URI);
  await require('../src/lsprSeed').seedLspr({ log: () => {} }); // msu/mips dos snapshots
  const server = app.listen(PORT);

  const admin = session();
  try {
    // ── Setup ──
    let r = await admin.req('/auth/setup', { method: 'POST', json: { name: 'Admin', email: 'a@x.com', password: 'admin123' } });
    check('admin criado', r.status === 201, r.status);
    const caixa = (await admin.req('/clients', { method: 'POST', json: { name: 'CAIXA' } })).body;
    const bb = (await admin.req('/clients', { method: 'POST', json: { name: 'BB' } })).body;
    const C = `/clients/${caixa._id}`;

    /* ══════════ BLOCO 1 — contratos e arquivos ══════════ */
    console.log('\n— contratos —');
    r = await admin.req(`${C}/contracts`, { method: 'POST', json: { number: 'CT-001', name: 'MO z16→z17', type: 'hardware', totalValue: 1000 } });
    check('POST cria contrato', r.status === 201 && r.body.number === 'CT-001', r.body);
    const ct1 = r.body._id;

    r = await admin.req(`${C}/contracts`, { method: 'POST', json: { number: 'CT-001' } });
    check('número duplicado no mesmo cliente -> 409', r.status === 409, r.status);

    r = await admin.req(`/clients/${bb._id}/contracts`, { method: 'POST', json: { number: 'CT-001' } });
    check('mesmo número em outro cliente -> 201', r.status === 201, r.status);

    r = await admin.req(`${C}/contracts`, { method: 'POST', json: { name: 'sem número' } });
    check('sem número -> 400', r.status === 400, r.status);

    r = await admin.req(`${C}/contracts/${ct1}`, { method: 'PUT', json: { status: 'encerrado' } });
    check('PUT parcial não zera os outros campos', r.status === 200 && r.body.status === 'encerrado' && r.body.number === 'CT-001' && r.body.totalValue === 1000, r.body);
    await admin.req(`${C}/contracts/${ct1}`, { method: 'PUT', json: { status: 'vigente' } });

    // Upload de PDF
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
    const form = new FormData();
    form.append('file', new Blob([pdfBytes]), 'contrato assinado.pdf');
    form.append('kind', 'contrato');
    r = await admin.req(`${C}/contracts/${ct1}/files`, { method: 'POST', body: form });
    check('upload de PDF -> 201', r.status === 201 && r.body.file && r.body.file.contentType === 'application/pdf', r.body);
    const fid = r.body.file._id;
    check('arquivo gravado no disco', fs.existsSync(path.join(FILES_DIR, String(fid))));

    let fres = await admin.raw(`${C}/contracts/${ct1}/files/${fid}`);
    check('GET do arquivo devolve application/pdf inline',
      fres.status === 200 && /application\/pdf/.test(fres.headers.get('content-type') || '') && /inline/.test(fres.headers.get('content-disposition') || ''),
      { ct: fres.headers.get('content-type'), cd: fres.headers.get('content-disposition') });
    check('conteúdo do PDF preservado', Buffer.from(await fres.arrayBuffer()).equals(pdfBytes));

    fres = await admin.raw(`${C}/contracts/${ct1}/files/${fid}?download=1`);
    check('?download=1 -> attachment', /attachment/.test(fres.headers.get('content-disposition') || ''));
    await fres.arrayBuffer();

    r = await admin.req(`${C}/contracts`);
    check('lista traz fileCount e não traz software[]', r.body[0].fileCount === 1 && r.body[0].software === undefined, r.body[0]);

    /* ══════════ BLOCO 2 — máquinas ══════════ */
    console.log('\n— máquinas —');
    const site = (await admin.req(`${C}/infra/sites`, { method: 'POST', json: { name: 'DC SP', role: 'prod' } })).body;
    const mkMachine = async (over) => (await admin.req(`${C}/infra/machines`, {
      method: 'POST',
      json: { model: 'IBM z16', serial: 'aa-1111', site: site._id, cps: 4, ziips: 2, iflsActive: 3, icfs: 1, memoryTB: 4, lsprModel: '3931-705', ...over },
    })).body;
    const m1 = await mkMachine({});
    check('máquina nasce com status ativa', m1.status === 'ativa', m1.status);

    r = await admin.req(`${C}/contracts/${ct1}/machines`, { method: 'POST', json: { machineIds: [m1._id] } });
    check('vincula máquina ao contrato', r.status === 200 && r.body.linked === 1, r.body);

    r = await admin.req(`${C}/infra/machines`);
    let row = r.body.find((x) => x._id === m1._id);
    check('listagem traz contractRef com o número', row.contractRef && row.contractRef.number === 'CT-001', row.contractRef);
    check('contract continua sendo id cru (round-trip do formulário)', typeof row.contract === 'string', typeof row.contract);

    // Round-trip: devolve o objeto recebido no PUT — não pode corromper o contrato.
    r = await admin.req(`${C}/infra/machines/${m1._id}`, { method: 'PUT', json: row });
    check('PUT devolvendo o objeto recebido não corrompe o contrato', r.status === 200 && String(r.body.contract) === String(ct1), r.body.contract);

    r = await admin.req(`${C}/contracts/${ct1}/machines`, { method: 'POST', json: { machineIds: ['64b7f9c2d1e4a5b6c7d8e9f0'] } });
    check('máquina de outro cliente -> 422', r.status === 422, r.status);

    // Shim de compatibilidade: cliente antigo mandando dormant
    r = await admin.req(`${C}/infra/machines/${m1._id}`, { method: 'PUT', json: { dormant: true } });
    check('PUT {dormant:true} vira status dormente (shim)', r.body.status === 'dormente', r.body.status);
    await admin.req(`${C}/infra/machines/${m1._id}`, { method: 'PUT', json: { status: 'ativa' } });

    /* ══════════ BLOCO 3 — software ══════════ */
    console.log('\n— software (PIDs) —');
    const inv = (produtos) => admin.req(`${C}/inventory`, {
      method: 'PUT',
      json: { clientName: 'CAIXA', customerNumber: '095616', products: produtos, sourceFileName: 'inv.html' },
    });
    await inv([
      { productId: '5655DT2', swSerial: 'S1', description: 'IBM CICS TS', category: 'LICENCE', effDate: '01.01.2026', poNumber: 'PO1', features: [] },
      { productId: '5655E90', swSerial: 'S2', description: 'IBM CICS TS S&S', category: 'SS', effDate: '01.01.2026', poNumber: 'PO1', features: [] },
    ]);

    r = await admin.req(`${C}/inventory/records?q=cics`);
    check('/inventory/records filtra e devolve projeção enxuta',
      r.body.length === 2 && r.body[0].features === undefined, r.body);

    r = await admin.req(`${C}/contracts/${ct1}/software`, { method: 'POST', json: { items: [{ productId: '5655DT2', swSerial: 'S1' }] } });
    check('vincula PID e copia o snapshot do inventário',
      r.status === 200 && r.body.software[0].description === 'IBM CICS TS' && r.body.software[0].category === 'LICENCE', r.body.software);

    const ct2 = (await admin.req(`${C}/contracts`, { method: 'POST', json: { number: 'CT-002' } })).body._id;
    r = await admin.req(`${C}/contracts/${ct2}/software`, { method: 'POST', json: { items: [{ productId: '5655DT2', swSerial: 'S1' }] } });
    check('mesmo registro em outro contrato -> 409', r.status === 409 && /CT-001/.test(r.body.error), r.body);

    r = await admin.req(`${C}/contracts/${ct2}/software`, { method: 'POST', json: { items: [{ productId: '5655DT2', swSerial: 'S1' }], move: true } });
    check('com move:true transfere', r.status === 200 && r.body.software.length === 1, r.body);
    r = await admin.req(`${C}/contracts/${ct1}`);
    check('contrato anterior perdeu o vínculo', (r.body.software || []).length === 0, r.body.software);

    // devolve para o CT-001 e liga o S&S também
    await admin.req(`${C}/contracts/${ct1}/software`, { method: 'POST', json: { items: [{ productId: '5655DT2', swSerial: 'S1' }, { productId: '5655E90', swSerial: 'S2' }], move: true } });

    // ── A regressão que mais importa: re-upload do inventário ──
    await inv([{ productId: '9999XXX', swSerial: 'Z9', description: 'Outro produto', category: 'LICENCE', features: [] }]);
    r = await admin.req(`${C}/contracts/${ct1}`);
    check('re-upload do inventário PRESERVA os vínculos', (r.body.software || []).length === 2, r.body.software);
    check('snapshot continua legível após o re-upload',
      r.body.software.some((s) => s.description === 'IBM CICS TS'), r.body.software);
    check('registro que sumiu do inventário volta com stale:true',
      r.body.software.every((s) => s.stale === true), r.body.software);

    r = await admin.req(`${C}/contracts/software-map`);
    check('software-map devolve as chaves PID|SERIAL', r.body.map['5655DT2|S1'] && r.body.map['5655DT2|S1'].number === 'CT-001', r.body.map);

    // ── Demo/PoC: marcação por registro, também imune ao re-upload ──
    r = await admin.req(`${C}/inventory/flags`, { method: 'PUT', json: { productFlags: [{ productId: '5655DT2', swSerial: 'S1', flag: 'demo' }] } });
    check('marca um PID como Demo/PoC', r.status === 200 && r.body.productFlags.length === 1, r.body);

    r = await admin.req(`${C}/inventory/flags`, { method: 'PUT', json: { productFlags: [{ productId: 'X' }] } });
    check('marcação sem serial -> 400', r.status === 400, r.status);

    r = await admin.req(`${C}/inventory/flags`, { method: 'PUT', json: { productFlags: 'nao-e-lista' } });
    check('productFlags fora de lista -> 400', r.status === 400, r.status);

    await inv([{ productId: 'OUTRO', swSerial: 'Z1', description: 'Outro', category: 'LICENCE', features: [] }]);
    r = await admin.req(`${C}/inventory`);
    check('Demo/PoC sobrevive ao re-upload do inventário',
      (r.body.productFlags || []).length === 1 && r.body.productFlags[0].productId === '5655DT2', r.body.productFlags);

    r = await admin.req(`${C}/inventory/flags`, { method: 'PUT', json: { productFlags: [] } });
    check('lista vazia desmarca tudo', r.status === 200 && r.body.productFlags.length === 0, r.body);

    r = await admin.req(`${C}/contracts/${ct1}/software/unlink`, { method: 'POST', json: { items: [{ productId: '5655E90', swSerial: 'S2' }] } });
    check('unlink remove só o pedido', r.body.software.length === 1 && r.body.software[0].productId === '5655DT2', r.body.software);

    /* ══════════ BLOCO 3b — termos aditivos ══════════ */
    console.log('\n— termos aditivos —');
    await admin.req(`${C}/contracts/${ct1}`, { method: 'PUT', json: { totalValue: 1000 } });
    r = await admin.req(`${C}/contracts`, { method: 'POST', json: { number: 'CT-001-A1', name: '1º aditivo', totalValue: 250, parentContract: ct1 } });
    check('cria termo aditivo -> 201', r.status === 201 && String(r.body.parentContract) === String(ct1), r.body);
    const ad1 = r.body._id;

    r = await admin.req(`${C}/contracts`, { method: 'POST', json: { number: 'CT-001-A2', totalValue: 150, parentContract: ct1 } });
    check('cria 2º aditivo', r.status === 201, r.status);

    r = await admin.req(`${C}/contracts`, { method: 'POST', json: { number: 'CT-001-A1-X', totalValue: 10, parentContract: ad1 } });
    check('aditivo de aditivo -> 422', r.status === 422, r.status);

    r = await admin.req(`${C}/contracts`, { method: 'POST', json: { number: 'X', parentContract: '64b7f9c2d1e4a5b6c7d8e9f0' } });
    check('pai inexistente -> 422', r.status === 422, r.status);

    r = await admin.req(`${C}/contracts`);
    const pai = r.body.find((c) => c._id === ct1);
    check('lista soma os aditivos ao contrato (1000 + 250 + 150)',
      pai.amendmentCount === 2 && pai.amendmentValue === 400 && pai.totalWithAmendments === 1400, {
        n: pai.amendmentCount, ad: pai.amendmentValue, total: pai.totalWithAmendments });

    r = await admin.req(`${C}/contracts/${ct1}`);
    check('detalhe traz os aditivos e o total consolidado',
      r.body.amendments.length === 2 && r.body.totalWithAmendments === 1400, r.body.totalWithAmendments);

    r = await admin.req(`${C}/contracts/${ad1}`);
    check('detalhe do aditivo aponta o contrato de origem', r.body.parent && r.body.parent.number === 'CT-001', r.body.parent);

    // O aditivo tem arquivos próprios, e a lista traz a contagem (a linha expansível usa).
    const formAd = new FormData();
    formAd.append('file', new Blob([pdfBytes]), 'aditivo.pdf');
    formAd.append('kind', 'aditivo');
    r = await admin.req(`${C}/contracts/${ad1}/files`, { method: 'POST', body: formAd });
    check('anexa arquivo ao termo aditivo', r.status === 201 && r.body.file.kind === 'aditivo', r.body);

    r = await admin.req(`${C}/contracts`);
    const paiComAnexo = r.body.find((c) => c._id === ct1);
    check('lista traz fileCount de cada aditivo',
      (paiComAnexo.amendments.find((a) => a._id === ad1) || {}).fileCount === 1,
      paiComAnexo.amendments.map((a) => a.fileCount));

    r = await admin.req(`${C}/contracts/${ct1}`, { method: 'DELETE' });
    check('excluir contrato com aditivos -> 422', r.status === 422 && /aditivo/.test(r.body.error), r.body);

    r = await admin.req(`${C}/contracts/software-map`);
    check('software-map traz signedAt/parentContract para a sugestão',
      r.body.contracts.every((c) => 'signedAt' in c && 'parentContract' in c), r.body.contracts[0]);

    /* ══════════ BLOCO 4 — MO / MES ══════════ */
    console.log('\n— MO / MES —');
    await runMigrationTests(admin, C, m1, site, mkMachine, ct1);

    /* ══════════ Acesso ══════════ */
    console.log('\n— acesso —');
    await admin.req('/admin/users', { method: 'POST', json: {
      name: 'Vera', email: 'v@x.com', password: 'view123', role: 'user',
      access: [{ client: caixa._id, level: 'view' }],
    } });
    const view = session();
    await view.req('/auth/login', { method: 'POST', json: { email: 'v@x.com', password: 'view123' } });
    r = await view.req(`${C}/contracts`);
    check('usuário view LÊ contratos', r.status === 200, r.status);
    r = await view.req(`${C}/contracts`, { method: 'POST', json: { number: 'X' } });
    check('usuário view NÃO cria contrato -> 403', r.status === 403, r.status);
    r = await view.req(`/clients/${bb._id}/contracts`);
    check('cliente sem acesso -> 403', r.status === 403, r.status);

    // Exclusão do contrato limpa vínculos sem apagar máquinas.
    // Os aditivos têm de sair antes (o contrato-pai se recusa a levá-los junto).
    const doPai = (await admin.req(`${C}/contracts/${ct1}`)).body.amendments || [];
    for (const a of doPai) await admin.req(`${C}/contracts/${a._id}`, { method: 'DELETE' });
    r = await admin.req(`${C}/contracts/${ct1}`, { method: 'DELETE' });
    check('DELETE do contrato (após remover os aditivos) -> ok', r.status === 200, { status: r.status, err: r.body && r.body.error });
    check('PDF removido do disco', !fs.existsSync(path.join(FILES_DIR, String(fid))));
    r = await admin.req(`${C}/infra/machines`);
    check('máquinas continuam existindo, sem contrato', r.body.length > 0 && r.body.every((m) => !m.contract), r.body.map((m) => m.contract));

  } catch (e) {
    failures++;
    console.error('  ✗ exceção', (e && e.stack) || e);
  } finally {
    server.close();
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    await mongod.stop();
    try { fs.rmSync(FILES_DIR, { recursive: true, force: true }); } catch (e) { /* ignora */ }
    try { fs.rmSync(process.env.SCRT_FILES_DIR, { recursive: true, force: true }); } catch (e) { /* ignora */ }
  }

  console.log(failures ? `\nCONTRATOS: ${failures} FALHA(S)` : '\nCONTRATOS: TODOS OS TESTES PASSARAM');
  process.exit(failures ? 1 : 0);
}

/** Bloco 4 — separado só para o main não virar uma função de 300 linhas. */
async function runMigrationTests(admin, C, m1, site, mkMachine, ct1) {
  let r;
  const alvo = { cps: 8, ziips: 4, iflsActive: 6, icfs: 2, memoryTB: 16, lsprModel: '3931-7C6', model: 'IBM z16' };

  // MES: serial diferente é erro
  r = await admin.req(`${C}/migrations`, { method: 'POST', json: { kind: 'MES', fromMachine: m1._id, after: { ...alvo, serial: 'BB-2222' } } });
  check('MES com serial diferente -> 422', r.status === 422, r.status);

  // MO exige serial novo e diferente
  r = await admin.req(`${C}/migrations`, { method: 'POST', json: { kind: 'MO', fromMachine: m1._id, after: { ...alvo } } });
  check('MO sem serial novo -> 422', r.status === 422, r.status);
  r = await admin.req(`${C}/migrations`, { method: 'POST', json: { kind: 'MO', fromMachine: m1._id, after: { ...alvo, serial: 'AA-1111' } } });
  check('MO com serial igual ao atual -> 422', r.status === 422, r.status);

  // ── MES completo ──
  r = await admin.req(`${C}/migrations`, {
    method: 'POST',
    json: { kind: 'MES', title: 'Upgrade memória', fromMachine: m1._id, after: alvo, value: 500, before: { cps: 999 } },
  });
  check('POST MES cria proposta', r.status === 201 && r.body.status === 'proposta', r.body);
  check('before é capturado do servidor (ignora o que o cliente mandou)', r.body.before.cps === 4 && r.body.before.memoryTB === 4, r.body.before);
  check('before congela msu/mips do LSPR', r.body.before.msu === 1232, r.body.before);
  const mes = r.body._id;

  r = await admin.req(`${C}/migrations/${mes}/executar`, { method: 'POST' });
  check('executar direto da proposta -> 422', r.status === 422, r.status);

  r = await admin.req(`${C}/migrations/${mes}/status`, { method: 'POST', json: { status: 'contratado' } });
  check('contratar sem contrato -> 422', r.status === 422, r.status);

  r = await admin.req(`${C}/migrations/${mes}/status`, { method: 'POST', json: { status: 'contratado', contract: ct1 } });
  check('contratar com contrato -> ok', r.status === 200 && r.body.status === 'contratado', r.body);

  r = await admin.req(`${C}/migrations/${mes}/executar`, { method: 'POST' });
  check('executar MES -> ok', r.status === 200 && r.body.event.status === 'executado', r.body && r.body.error);
  check('MES aplicou a configuração', r.body.fromMachine.cps === 8 && r.body.fromMachine.memoryTB === 16, r.body.fromMachine);
  check('MES mantém o serial', r.body.fromMachine.serial === 'AA-1111', r.body.fromMachine.serial);
  check('MES guarda o ponto de restauração', r.body.event.applied && r.body.event.applied.fromMachineBefore.cps === 4, r.body.event.applied);

  r = await admin.req(`${C}/migrations/${mes}`, { method: 'PUT', json: { after: { cps: 99 } } });
  check('editar after de evento executado -> 422', r.status === 422, r.status);
  r = await admin.req(`${C}/migrations/${mes}`, { method: 'DELETE' });
  check('excluir evento executado -> 422', r.status === 422, r.status);
  r = await admin.req(`${C}/migrations/${mes}/status`, { method: 'POST', json: { status: 'cancelada' } });
  check('cancelar evento executado -> 422', r.status === 422, r.status);

  r = await admin.req(`${C}/migrations/${mes}/desfazer`, { method: 'POST' });
  check('desfazer MES restaura a configuração exata', r.status === 200 && r.body.fromMachine.cps === 4 && r.body.fromMachine.memoryTB === 4, r.body.fromMachine);
  check('desfazer volta para contratado', r.body.event.status === 'contratado' && r.body.event.applied === null, r.body.event.status);

  // ── MO completo ──
  await admin.req(`${C}/migrations/${mes}/executar`, { method: 'POST' }); // reexecuta para deixar a máquina grande
  const lpar = (await admin.req(`${C}/infra/lpars`, { method: 'POST', json: { machine: m1._id, name: 'LPAR1', os: 'zos', ifls: 2 } })).body;
  check('LPAR criada na máquina antiga', Boolean(lpar._id), lpar);

  r = await admin.req(`${C}/migrations`, {
    method: 'POST',
    json: { kind: 'MO', title: 'Troca z16 → z17', fromMachine: m1._id, contract: ct1,
      after: { model: 'IBM z17', serial: 'cc-3333', cps: 12, ziips: 6, iflsActive: 8, icfs: 2, memoryTB: 32, lsprModel: '9175-760' } },
  });
  check('POST MO cria proposta', r.status === 201, r.body);
  const mo = r.body._id;
  await admin.req(`${C}/migrations/${mo}/status`, { method: 'POST', json: { status: 'contratado' } });

  r = await admin.req(`${C}/migrations/${mo}/executar`, { method: 'POST', json: { migrarLpars: true } });
  check('executar MO -> ok', r.status === 200, r.body && r.body.error);
  check('MO criou a máquina nova com serial em MAIÚSCULAS', r.body.toMachine && r.body.toMachine.serial === 'CC-3333', r.body.toMachine && r.body.toMachine.serial);
  check('máquina nova aponta para a antiga (replaces)', String(r.body.toMachine.replaces) === String(m1._id), r.body.toMachine.replaces);
  check('máquina nova herda o site', String(r.body.toMachine.site) === String(site._id), r.body.toMachine.site);
  check('máquina antiga vira substituida', r.body.fromMachine.status === 'substituida' && String(r.body.fromMachine.replacedBy) === String(r.body.toMachine._id), r.body.fromMachine);
  const nova = r.body.toMachine._id;

  // A listagem popula `machine`, então compara pelo _id de dentro.
  const lparMachineId = (l) => String((l.machine && (l.machine._id || l.machine)) || '');
  r = await admin.req(`${C}/infra/lpars`);
  check('LPAR original permanece na máquina antiga', r.body.some((l) => lparMachineId(l) === String(m1._id)), r.body.map(lparMachineId));
  check('LPAR foi clonada para a nova', r.body.some((l) => lparMachineId(l) === String(nova)), r.body.map(lparMachineId));

  r = await admin.req(`${C}/infra/machines`);
  check('listagem continua trazendo a substituída', r.body.some((m) => String(m._id) === String(m1._id)), r.body.length);

  // Histórico
  r = await admin.req(`${C}/infra/machines/${m1._id}/historico`);
  check('histórico traz os eventos da máquina', r.status === 200 && r.body.events.length >= 2, r.body && r.body.events && r.body.events.length);
  check('histórico resolve a cadeia de substituição', r.body.chain && r.body.chain.replacedBy.length === 1, r.body.chain);

  // Desfazer MO com LPAR própria na nova
  await admin.req(`${C}/infra/lpars`, { method: 'POST', json: { machine: nova, name: 'NOVA-LPAR', os: 'linux' } });
  r = await admin.req(`${C}/migrations/${mo}/desfazer`, { method: 'POST' });
  check('desfazer MO com LPAR própria na nova -> 422', r.status === 422, { status: r.status, err: r.body && r.body.error });

  // ── Detalhes da máquina ──
  r = await admin.req(`${C}/infra/machines/${m1._id}/detalhes`);
  check('detalhes trazem a máquina com LSPR e contrato',
    r.status === 200 && r.body.machine && r.body.machine.lspr && 'contractRef' in r.body.machine, {
      status: r.status, temLspr: !!(r.body.machine && r.body.machine.lspr) });
  check('detalhes trazem o total de MIPS do capacity marker', r.body.machine.lspr.mips > 0, r.body.machine.lspr);
  check('detalhes trazem as LPARs cadastradas', Array.isArray(r.body.lpars), typeof r.body.lpars);
  check('detalhes trazem os eventos de MO/MES', (r.body.events || []).length >= 1, (r.body.events || []).length);
}

main().catch((e) => { console.error(e); process.exit(1); });
