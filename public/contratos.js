'use strict';

/* Contratos: repositório por cliente, ligando máquinas (infra) e PIDs (inventário),
   com os arquivos assinados e os eventos de MO/MES. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('pt-BR'));
const num1 = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const dt = (d) => {
  if (!d) return '—';
  // Datas de contrato são "dia", não instante: formata o YYYY-MM-DD direto para não
  // cair um dia por causa do fuso (new Date('2026-01-01') é meia-noite UTC).
  const s = String(d);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const dd = new Date(s);
  return Number.isNaN(dd.getTime()) ? '—' : dd.toLocaleDateString('pt-BR');
};
const money = (v, c) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: c || 'BRL' }));

const state = {
  clients: [],
  clientId: localStorage.getItem('tfp.clientId') || null,
  contracts: [],
  machines: [],
  events: [],
  tab: 'contratos',
  editId: null,
  parentId: null,   // quando preenchido, o modal está criando um TERMO ADITIVO
  detailId: null,
  swSelection: new Map(),
  expandidos: new Set(), // contratos com os termos aditivos abertos na lista
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `Erro ${res.status}`);
  return body;
}
const jsonPut = (p, b) => api(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const jsonPost = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

function toast(message, kind = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 4600);
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModals() { document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden')); }
function showView(which) {
  ['empty-clients', 'contracts-view'].forEach((id) => $(id).classList.toggle('hidden', id !== which));
}

const CT_TYPES = [
  { k: 'hardware', label: 'Hardware', c: '#0f62fe' },
  { k: 'software', label: 'Software', c: '#6929c4' },
  { k: 'servicos', label: 'Serviços', c: '#198038' },
  { k: 'misto', label: 'Misto', c: '#8e6a00' },
];
const CT_STATUS = [
  { k: 'vigente', label: 'Vigente', c: '#198038' },
  { k: 'rascunho', label: 'Rascunho', c: '#8e6a00' },
  { k: 'encerrado', label: 'Encerrado', c: '#6f6f6f' },
  { k: 'cancelado', label: 'Cancelado', c: '#da1e28' },
];
const tint = (list, k) => {
  const it = list.find((x) => x.k === k) || list[0];
  return `<span class="badge" style="background:${it.c}1a;color:${it.c}">${it.label}</span>`;
};

/* ── Carregamento ─────────────────────────────────────── */
async function loadClients() {
  state.clients = await api('/clients');
  const select = $('client-select');
  select.innerHTML = state.clients.map((c) => `<option value="${c._id}">${esc(c.name)}</option>`).join('');
  if (!state.clients.length) { state.clientId = null; showView('empty-clients'); return; }
  if (!state.clients.some((c) => c._id === state.clientId)) state.clientId = state.clients[0]._id;
  select.value = state.clientId;
  localStorage.setItem('tfp.clientId', state.clientId);
  await loadAll();
}

async function loadAll() {
  const c = state.clients.find((x) => x._id === state.clientId);
  $('contracts-client-name').textContent = c ? c.name : '—';
  [state.contracts, state.machines, state.events] = await Promise.all([
    api(`/clients/${state.clientId}/contracts`),
    api(`/clients/${state.clientId}/infra/machines`),
    api(`/clients/${state.clientId}/migrations`),
  ]);
  showView('contracts-view');
  renderKpis();
  renderTab();
  // ?contract=<id> abre o detalhe direto (link vindo do inventário).
  const alvo = new URLSearchParams(location.search).get('contract');
  if (alvo && state.contracts.some((x) => x._id === alvo)) { openDetail(alvo); history.replaceState({}, '', '/contratos'); }
}

function renderKpis() {
  const vigentes = state.contracts.filter((c) => c.status === 'vigente');
  // Soma tudo uma vez só: aditivo já entra pelo próprio totalValue.
  const valor = state.contracts.reduce((a, c) => a + (c.totalValue || 0), 0);
  const maquinas = state.contracts.reduce((a, c) => a + (c.machineCount || 0), 0);
  const pids = state.contracts.reduce((a, c) => a + (c.softwareCount || 0), 0);
  const abertos = state.events.filter((e) => e.status === 'proposta' || e.status === 'contratado').length;
  $('contracts-kpis').innerHTML = [
    ['Contratos vigentes', fmt(vigentes.filter((c) => !c.parentContract).length),
      `${state.contracts.filter((c) => !c.parentContract).length} no total${state.contracts.some((c) => c.parentContract) ? ` · ${state.contracts.filter((c) => c.parentContract).length} aditivo(s)` : ''}`],
    ['Valor contratado', money(valor, 'BRL'), 'contratos + termos aditivos'],
    ['Máquinas cobertas', fmt(maquinas), 'com contrato vinculado'],
    ['PIDs vinculados', fmt(pids), 'licenças e S&S'],
    ['MO/MES em aberto', fmt(abertos), 'proposta ou contratado'],
  ].map(([h, v, s]) => `<div class="kpi-card"><h3>${esc(h)}</h3><div class="value">${v}</div><div class="subtitle">${esc(s)}</div></div>`).join('');
}

function renderTab() {
  ['contratos', 'migracoes'].forEach((t) => $(`tab-${t}`).classList.toggle('hidden', t !== state.tab));
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'contratos') renderContracts(); else renderMigrations();
}

function renderContracts() {
  const el = $('tab-contratos');
  // A lista mostra os contratos originais; os termos aditivos aparecem dentro deles.
  const principais = state.contracts.filter((c) => !c.parentContract);
  if (!principais.length) {
    el.innerHTML = '<div class="empty-inline">Nenhum contrato cadastrado. Use <strong>+ Contrato</strong> para começar.</div>';
    return;
  }
  el.innerHTML = `
    <div class="card"><div class="table-responsive">
      <table class="infra-table">
        <thead><tr>
          <th>Contrato</th><th>Tipo</th><th>Situação</th><th>Vigência</th>
          <th class="num">Valor</th><th class="num">Máquinas</th><th class="num">PIDs</th>
          <th class="num">MO/MES</th><th>Arquivos</th><th class="infra-actions-col">Ações</th>
        </tr></thead>
        <tbody>${principais.map((c) => `
          <tr>
            <td><button type="button" class="btn-link" data-open="${c._id}"><strong>${esc(c.number)}</strong></button>
              ${c.amendmentCount ? ` <button type="button" class="badge badge-toggle" data-exp="${c._id}"
                  aria-expanded="${state.expandidos.has(c._id)}" title="Ver os termos aditivos">
                  ${state.expandidos.has(c._id) ? '▾' : '▸'} ${c.amendmentCount} aditivo(s)</button>` : ''}
              ${c.name ? `<div class="muted small">${esc(c.name)}</div>` : ''}</td>
            <td>${tint(CT_TYPES, c.type)}</td>
            <td>${tint(CT_STATUS, c.status)}</td>
            <td class="small">${dt(c.startDate)} → ${dt(c.endDate)}</td>
            <td class="num">${money(c.amendmentCount ? c.totalWithAmendments : c.totalValue, c.currency)}
              ${c.amendmentCount ? `<div class="muted small">${money(c.totalValue, c.currency)} + ${money(c.amendmentValue, c.currency)}</div>` : ''}</td>
            <td class="num">${fmt(c.machineCount)}</td>
            <td class="num">${fmt(c.softwareCount)}</td>
            <td class="num">${fmt(c.eventCount)}</td>
            <td>${c.fileCount ? `<span class="badge badge-neutral">${c.fileCount} arquivo(s)</span>` : '<span class="muted small">—</span>'}</td>
            <td class="infra-actions">
              <button class="row-action" data-open="${c._id}" title="Abrir">${iconOpen()}</button>
              <button class="row-action" data-requires-edit data-edit="${c._id}" title="Editar">${iconEdit()}</button>
            </td>
          </tr>
          ${c.amendmentCount && state.expandidos.has(c._id) ? `<tr class="amendment-row"><td colspan="10">
            <div class="amendment-box">
              <table class="infra-table">
                <thead><tr><th>Termo aditivo</th><th>Situação</th><th>Assinatura</th><th>Vigência</th><th class="num">Valor</th><th>Arquivos</th><th class="infra-actions-col"></th></tr></thead>
                <tbody>${c.amendments.map((a) => `<tr>
                  <td><button type="button" class="btn-link" data-open="${a._id}"><strong>${esc(a.number)}</strong></button>
                    ${a.name ? `<div class="muted small">${esc(a.name)}</div>` : ''}</td>
                  <td>${tint(CT_STATUS, a.status)}</td>
                  <td class="small">${dt(a.signedAt)}</td>
                  <td class="small">${dt(a.startDate)} → ${dt(a.endDate)}</td>
                  <td class="num">${money(a.totalValue, a.currency)}</td>
                  <td>${(a.fileCount || 0) ? `<span class="badge badge-neutral">${a.fileCount} arquivo(s)</span>` : '<span class="muted small">sem anexo</span>'}</td>
                  <td class="infra-actions">
                    <button class="row-action" data-open="${a._id}" title="Abrir">${iconOpen()}</button>
                    <button class="row-action" data-requires-edit data-edit="${a._id}" title="Editar">${iconEdit()}</button>
                  </td>
                </tr>`).join('')}
                <tr><td colspan="4"><strong>Contrato + aditivos</strong></td>
                  <td class="num"><strong>${money(c.totalWithAmendments, c.currency)}</strong></td><td colspan="2"></td></tr>
                </tbody>
              </table>
              <button class="btn btn-ghost btn-sm" data-requires-edit data-addad="${c._id}" style="margin-top:10px">+ Termo aditivo</button>
            </div>
          </td></tr>` : ''}`).join('')}</tbody>
      </table>
    </div></div>`;
  el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openDetail(b.dataset.open)));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openContractModal(b.dataset.edit)));
  el.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.exp;
    if (state.expandidos.has(id)) state.expandidos.delete(id); else state.expandidos.add(id);
    renderContracts();
  }));
  el.querySelectorAll('[data-addad]').forEach((b) => b.addEventListener('click', () => openContractModal(null, { parent: b.dataset.addad })));
}

function renderMigrations() {
  const el = $('tab-migracoes');
  const B = window.migrationBadges;
  if (!state.events.length) {
    el.innerHTML = '<div class="empty-inline">Nenhum MO/MES registrado. Use <strong>+ MO/MES</strong> para criar uma proposta.</div>';
    return;
  }
  el.innerHTML = `
    <div class="card"><div class="table-responsive">
      <table class="infra-table">
        <thead><tr>
          <th>Tipo</th><th>Título</th><th>Máquina</th><th>Δ capacidade</th>
          <th>Situação</th><th>Data</th><th>Contrato</th><th class="num">Valor</th>
          <th class="infra-actions-col">Ações</th>
        </tr></thead>
        <tbody>${state.events.map((e) => {
          const de = e.fromMachine || {};
          const para = e.toMachine || {};
          const dMsu = (Number(e.after && e.after.msu) || 0) - (Number(e.before && e.before.msu) || 0);
          const dMem = (Number(e.after && e.after.memoryTB) || 0) - (Number(e.before && e.before.memoryTB) || 0);
          const deltas = [];
          if (dMsu) deltas.push(`<span class="${dMsu > 0 ? 'cap-up' : 'cap-down'}">${dMsu > 0 ? '+' : ''}${fmt(dMsu)} MSU</span>`);
          if (dMem) deltas.push(`<span class="${dMem > 0 ? 'cap-up' : 'cap-down'}">${dMem > 0 ? '+' : ''}${num1(dMem)} TB</span>`);
          return `<tr>
            <td>${B.kindBadge(e.kind)}</td>
            <td>${esc(e.title || '—')}</td>
            <td class="small">${esc(de.model || '')} <span class="mono">${esc(de.serial || '')}</span>
              ${e.kind === 'MO' ? `<div class="muted small">→ ${esc(para.model || (e.after && e.after.model) || '')} <span class="mono">${esc(para.serial || (e.after && e.after.serial) || '')}</span></div>` : ''}</td>
            <td class="cap-delta">${deltas.join('') || '<span class="muted small">—</span>'}</td>
            <td>${B.statusBadge(e.status)}</td>
            <td class="small">${dt(e.executedAt || e.plannedDate)}</td>
            <td class="small">${e.contract ? esc(e.contract.number) : '<span class="muted">—</span>'}</td>
            <td class="num">${money(e.value, e.currency)}</td>
            <td class="infra-actions">
              ${e.status === 'proposta' ? `<button class="row-action" data-requires-edit data-contratar="${e._id}" title="Marcar como contratado">${iconCheck()}</button>` : ''}
              ${e.status === 'contratado' ? `<button class="row-action" data-requires-edit data-executar="${e._id}" title="Executar">${iconPlay()}</button>` : ''}
              ${e.status === 'executado' ? `<button class="row-action" data-requires-edit data-desfazer="${e._id}" title="Desfazer execução">${iconUndo()}</button>` : ''}
              <button class="row-action" data-hist="${String((e.fromMachine || {})._id || '')}" title="Histórico da máquina">${iconClock()}</button>
              ${e.status !== 'executado' ? `<button class="row-action" data-requires-edit data-edite="${e._id}" title="Editar">${iconEdit()}</button>` : ''}
              ${['proposta', 'cancelada'].includes(e.status) ? `<button class="row-action danger" data-requires-edit data-dele="${e._id}" title="Excluir">${iconTrash()}</button>` : ''}
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div></div>`;

  const reload = async () => { await loadAll(); };
  el.querySelectorAll('[data-contratar]').forEach((b) => b.addEventListener('click', () => contratar(b.dataset.contratar)));
  el.querySelectorAll('[data-executar]').forEach((b) => b.addEventListener('click', async () => {
    const ev = await api(`/clients/${state.clientId}/migrations/${b.dataset.executar}`);
    const sites = await api(`/clients/${state.clientId}/infra/sites`);
    window.openMigrationExecModal({ clientId: state.clientId, event: ev, sites, onDone: reload });
  }));
  el.querySelectorAll('[data-desfazer]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Desfazer a execução e restaurar a configuração anterior da máquina?')) return;
    try { await jsonPost(`/clients/${state.clientId}/migrations/${b.dataset.desfazer}/desfazer`, {}); toast('Execução desfeita.'); await loadAll(); }
    catch (e) { toast(e.message, 'error'); }
  }));
  el.querySelectorAll('[data-hist]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.hist) window.openMachineHistoryModal({ clientId: state.clientId, machineId: b.dataset.hist });
  }));
  el.querySelectorAll('[data-edite]').forEach((b) => b.addEventListener('click', async () => {
    const ev = await api(`/clients/${state.clientId}/migrations/${b.dataset.edite}`);
    window.openMigrationModal({ clientId: state.clientId, machines: state.machines, contracts: state.contracts, event: ev, onSaved: reload });
  }));
  el.querySelectorAll('[data-dele]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Excluir esta proposta?')) return;
    try { await api(`/clients/${state.clientId}/migrations/${b.dataset.dele}`, { method: 'DELETE' }); toast('Proposta excluída.'); await loadAll(); }
    catch (e) { toast(e.message, 'error'); }
  }));
}

async function contratar(eventId) {
  const ev = state.events.find((e) => e._id === eventId);
  let contractId = ev && ev.contract ? (ev.contract._id || ev.contract) : '';
  if (!contractId) {
    if (!state.contracts.length) { toast('Cadastre o contrato assinado antes.', 'error'); return; }
    const opcoes = state.contracts.map((c, i) => `${i + 1}) ${c.number}${c.name ? ' · ' + c.name : ''}`).join('\n');
    const escolha = prompt(`Qual contrato assinado cobre este ${ev.kind}?\n\n${opcoes}\n\nDigite o número:`);
    const idx = Number(escolha) - 1;
    if (!(idx >= 0 && idx < state.contracts.length)) return;
    contractId = state.contracts[idx]._id;
  }
  try {
    await jsonPost(`/clients/${state.clientId}/migrations/${eventId}/status`, { status: 'contratado', contract: contractId });
    toast('Marcado como contratado.');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Modal de contrato ────────────────────────────────── */
let ctType = 'misto';
let ctStatus = 'vigente';

function renderPickers() {
  $('ct-type').innerHTML = CT_TYPES.map((o) =>
    `<button type="button" class="role-opt ${ctType === o.k ? 'active' : ''}" data-t="${o.k}" style="--rc:${o.c}">${o.label}</button>`).join('');
  $('ct-status').innerHTML = CT_STATUS.map((o) =>
    `<button type="button" class="role-opt ${ctStatus === o.k ? 'active' : ''}" data-s="${o.k}" style="--rc:${o.c}">${o.label}</button>`).join('');
  $('ct-type').querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { ctType = b.dataset.t; renderPickers(); }));
  $('ct-status').querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => { ctStatus = b.dataset.s; renderPickers(); }));
}

function openContractModal(id, opts = {}) {
  state.editId = id || null;
  state.parentId = opts.parent || null;
  const c = id ? (state.contracts.find((x) => x._id === id) || (state.detailData && (state.detailData.amendments || []).find((x) => x._id === id))) : null;
  const pai = state.parentId ? state.contracts.find((x) => x._id === state.parentId) : null;
  $('modal-contract-title').textContent = c
    ? ((c.parentContract ? 'Editar termo aditivo' : 'Editar contrato'))
    : (pai ? `Termo aditivo de ${pai.number}` : 'Novo contrato');
  const set = (k, v) => { $(k).value = v == null ? '' : v; };
  set('ct-number', c ? c.number : '');
  set('ct-name', c ? c.name : '');
  set('ct-vendor', c ? c.vendor : 'IBM');
  set('ct-po', c ? c.poNumber : '');
  set('ct-owner', c ? c.owner : '');
  set('ct-notes', c ? c.notes : '');
  set('ct-total', c ? c.totalValue : '');
  set('ct-monthly', c ? c.monthlyValue : '');
  ['signed:signedAt', 'start:startDate', 'end:endDate'].forEach((p) => {
    const [el, campo] = p.split(':');
    $(`ct-${el}`).value = c && c[campo] ? String(c[campo]).slice(0, 10) : '';
  });
  $('ct-currency').value = (c && c.currency) || 'BRL';
  ctType = c ? c.type : 'misto';
  ctStatus = c ? c.status : 'vigente';
  renderPickers();
  const del = $('btn-delete-contract');
  del.style.display = c ? '' : 'none';
  del.onclick = c ? () => deleteContract(c) : null;
  // Anexo: o upload só existe depois que o contrato tem id, então o arquivo fica
  // guardado aqui e sobe logo após o POST/PUT.
  $('ct-file').value = '';
  $('ct-file-name').textContent = 'Nenhum arquivo escolhido';
  $('ct-file-hint').textContent = c && (c.fileCount || (c.files || []).length)
    ? `Já tem ${c.fileCount || c.files.length} arquivo(s). Um novo é adicionado, nada é substituído.`
    : 'PDF do contrato ou termo aditivo assinado. Dá para anexar mais depois, no detalhe.';
  $('ct-error').classList.add('hidden');
  openModal('modal-contract');
  $('ct-number').focus();
}

async function saveContract() {
  const err = $('ct-error');
  err.classList.add('hidden');
  const numero = $('ct-number').value.trim();
  if (!numero) { err.textContent = 'Informe o número do contrato.'; err.classList.remove('hidden'); return; }
  const body = {
    number: numero, name: $('ct-name').value.trim(), vendor: $('ct-vendor').value.trim(),
    poNumber: $('ct-po').value.trim(), owner: $('ct-owner').value.trim(), notes: $('ct-notes').value.trim(),
    type: ctType, status: ctStatus, currency: $('ct-currency').value,
    signedAt: $('ct-signed').value || null, startDate: $('ct-start').value || null, endDate: $('ct-end').value || null,
    totalValue: $('ct-total').value === '' ? null : Number($('ct-total').value),
    monthlyValue: $('ct-monthly').value === '' ? null : Number($('ct-monthly').value),
  };
  const ehAditivo = Boolean(state.parentId);
  if (ehAditivo) body.parentContract = state.parentId;
  const arquivo = $('ct-file').files && $('ct-file').files[0];
  const btn = $('btn-save-contract');
  btn.disabled = true;
  try {
    const salvo = state.editId
      ? await jsonPut(`/clients/${state.clientId}/contracts/${state.editId}`, body)
      : await jsonPost(`/clients/${state.clientId}/contracts`, body);

    // O arquivo sobe depois porque a rota precisa do id do contrato.
    let avisoAnexo = '';
    if (arquivo) {
      const form = new FormData();
      form.append('file', arquivo);
      form.append('kind', ehAditivo || (salvo && salvo.parentContract) ? 'aditivo' : 'contrato');
      try {
        await api(`/clients/${state.clientId}/contracts/${salvo._id}/files`, { method: 'POST', body: form });
      } catch (e2) {
        // O contrato já está gravado: avisa em vez de fingir que deu tudo certo.
        avisoAnexo = ` (o anexo falhou: ${e2.message})`;
      }
    }

    // Depois de criar um aditivo, abre o próprio aditivo — é onde se anexa o
    // resto e se vinculam máquinas/PIDs. Ele tem link de volta para o contrato.
    const abrir = state.editId ? (state.detailId ? state.detailId : null) : salvo._id;
    closeModals();
    toast(`${ehAditivo ? 'Termo aditivo' : 'Contrato'} salvo.${avisoAnexo}`, avisoAnexo ? 'error' : 'success');
    state.parentId = null;
    await loadAll();
    if (abrir) openDetail(abrir);
  } catch (e) {
    err.textContent = e.message; err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function deleteContract(c) {
  if (!confirm(`Excluir o contrato ${c.number}? As máquinas e os PIDs apenas deixam de apontar para ele.`)) return;
  try {
    await api(`/clients/${state.clientId}/contracts/${c._id}`, { method: 'DELETE' });
    closeModals();
    toast('Contrato excluído.');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Detalhe do contrato ──────────────────────────────── */
async function openDetail(id) {
  state.detailId = id;
  let d;
  try { d = await api(`/clients/${state.clientId}/contracts/${id}`); }
  catch (e) { toast(e.message, 'error'); return; }

  state.detailData = d;
  const ehAditivo = Boolean(d.parentContract);
  $('cd-title').textContent = (ehAditivo ? 'Termo aditivo ' : '') + d.number + (d.name ? ` · ${d.name}` : '');
  const valorTxt = d.amendmentValue
    ? `${money(d.totalWithAmendments, d.currency)} <span class="muted small">(${money(d.totalValue, d.currency)} + ${money(d.amendmentValue, d.currency)} em aditivos)</span>`
    : money(d.totalValue, d.currency);
  $('cd-sub').innerHTML = `${tint(CT_TYPES, d.type)} ${tint(CT_STATUS, d.status)} · ${esc(d.vendor || '')} · ${dt(d.startDate)} → ${dt(d.endDate)} · ${valorTxt}`
    + (d.parent ? ` · <button type="button" class="btn-link" data-goparent="${d.parent._id}">aditivo de ${esc(d.parent.number)}</button>` : '');
  $('cd-edit').onclick = () => { closeModals(); openContractModal(id); };

  const pdf = (d.files || []).find((f) => f.contentType === 'application/pdf');
  $('cd-body').innerHTML = `
    <div class="card"><div class="card-header"><h2>Arquivos</h2>
      <p class="muted small">contrato assinado, aditivos e anexos</p></div>
      <div id="cd-files">${(d.files || []).length ? d.files.map((f) => `
        <div class="contract-file-row">
          <div><strong>${esc(f.name)}</strong> <span class="badge badge-neutral">${esc(f.kind)}</span>
            <div class="muted small">${fmt(Math.round((f.size || 0) / 1024))} KB · ${dt(f.uploadedAt)}</div></div>
          <div class="contract-file-actions">
            <a class="btn btn-ghost btn-sm" href="/api/clients/${state.clientId}/contracts/${id}/files/${f._id}" target="_blank" rel="noopener">Abrir</a>
            <a class="btn btn-ghost btn-sm" href="/api/clients/${state.clientId}/contracts/${id}/files/${f._id}?download=1">Baixar</a>
            <button class="row-action danger" data-requires-edit data-delfile="${f._id}" title="Excluir">${iconTrash()}</button>
          </div>
        </div>`).join('') : '<div class="empty-inline small">Nenhum arquivo anexado.</div>'}
      </div>
      <label class="btn btn-ghost btn-sm" data-requires-edit style="margin-top:10px; display:inline-flex">
        Anexar arquivo<input type="file" id="cd-upload" hidden>
      </label>
      ${pdf ? `<iframe class="contract-pdf-frame" src="/api/clients/${state.clientId}/contracts/${id}/files/${pdf._id}" title="Prévia do contrato"></iframe>` : ''}
    </div>

    ${ehAditivo ? '' : `<div class="card" style="margin-top:14px"><div class="card-header"><h2>Termos aditivos (${d.amendments.length})</h2>
      <p class="muted small">cada um com número, vigência e valor próprios — o valor soma ao contrato</p></div>
      ${d.amendments.length ? `<div class="table-responsive"><table class="infra-table">
        <thead><tr><th>Número</th><th>Situação</th><th>Assinatura</th><th>Vigência</th><th class="num">Valor</th><th class="infra-actions-col"></th></tr></thead>
        <tbody>${d.amendments.map((a) => `<tr>
          <td><button type="button" class="btn-link" data-openad="${a._id}"><strong>${esc(a.number)}</strong></button>
            ${a.name ? `<div class="muted small">${esc(a.name)}</div>` : ''}</td>
          <td>${tint(CT_STATUS, a.status)}</td>
          <td class="small">${dt(a.signedAt)}</td>
          <td class="small">${dt(a.startDate)} → ${dt(a.endDate)}</td>
          <td class="num">${money(a.totalValue, a.currency)}</td>
          <td class="infra-actions"><button class="row-action" data-requires-edit data-editad="${a._id}" title="Editar">${iconEdit()}</button></td>
        </tr>`).join('')}
        <tr><td colspan="4"><strong>Total com aditivos</strong></td>
          <td class="num"><strong>${money(d.totalWithAmendments, d.currency)}</strong></td><td></td></tr>
        </tbody></table></div>` : '<div class="empty-inline small">Nenhum termo aditivo.</div>'}
      <button class="btn btn-ghost btn-sm" data-requires-edit id="cd-add-amendment" style="margin-top:10px">+ Termo aditivo</button>
    </div>`}

    <div class="card" style="margin-top:14px"><div class="card-header"><h2>Máquinas (${d.machines.length})</h2>
      <p class="muted small">hardware coberto por este contrato</p></div>
      ${d.machines.length ? `<div class="table-responsive"><table class="infra-table">
        <thead><tr><th>Modelo</th><th>Serial</th><th>Site</th><th>Processadores</th><th class="num">Memória</th><th></th></tr></thead>
        <tbody>${d.machines.map((m) => `<tr class="${m.status === 'substituida' ? 'machine-replaced' : ''}">
          <td>${esc(m.model || '—')}${m.status === 'substituida' ? ' <span class="badge badge-neutral">substituída</span>' : ''}</td>
          <td class="mono">${esc(m.serial || '—')}</td>
          <td class="small">${m.site ? esc(m.site.name) : '—'}</td>
          <td class="small">${fmt((m.cps || 0) + (m.ziips || 0) + (m.iflsActive || 0) + (m.icfs || 0))} <span class="muted">(${fmt(m.cps)} CP · ${fmt(m.ziips)} zIIP · ${fmt(m.iflsActive)} IFL · ${fmt(m.icfs)} CF)</span></td>
          <td class="num">${num1((m.memoryTB || 0) + (m.memoryAddTB || 0))} TB</td>
          <td class="infra-actions"><button class="row-action danger" data-requires-edit data-unlinkm="${m._id}" title="Desvincular">${iconUnlink()}</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty-inline small">Nenhuma máquina vinculada.</div>'}
      <button class="btn btn-ghost btn-sm" data-requires-edit id="cd-link-machines" style="margin-top:10px">+ Vincular máquinas</button>
    </div>

    <div class="card" style="margin-top:14px"><div class="card-header"><h2>Software (${d.software.length})</h2>
      <p class="muted small">licenças e S&amp;S cobertos — o vínculo sobrevive à recarga do inventário</p></div>
      ${d.software.length ? `<div class="table-responsive"><table class="infra-table">
        <thead><tr><th>PID</th><th>Serial</th><th>Descrição</th><th>Tipo</th><th>Eff. date</th><th></th></tr></thead>
        <tbody>${d.software.map((s) => `<tr>
          <td class="mono">${esc(s.productId)}</td>
          <td class="mono">${esc(s.swSerial)}</td>
          <td>${esc(s.description || '—')}${s.stale ? ' <span class="badge badge-neutral" title="não está no inventário atual">fora do inventário</span>' : ''}</td>
          <td>${s.category === 'SS' ? '<span class="badge badge-neutral">S&amp;S</span>' : 'Licença'}</td>
          <td class="small">${esc(s.effDate || '—')}</td>
          <td class="infra-actions"><button class="row-action danger" data-requires-edit data-unlinks="${esc(s.productId)}|${esc(s.swSerial)}" title="Desvincular">${iconUnlink()}</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty-inline small">Nenhum PID vinculado.</div>'}
      <button class="btn btn-ghost btn-sm" data-requires-edit id="cd-link-software" style="margin-top:10px">+ Vincular software</button>
    </div>

    ${d.events.length ? `<div class="card" style="margin-top:14px"><div class="card-header"><h2>MO / MES (${d.events.length})</h2></div>
      <div class="table-responsive"><table class="infra-table"><tbody>${d.events.map((e) => `<tr>
        <td>${window.migrationBadges.kindBadge(e.kind)}</td>
        <td>${esc(e.title || '—')}</td>
        <td class="small">${esc((e.fromMachine || {}).serial || '')}${e.toMachine ? ` → ${esc(e.toMachine.serial)}` : ''}</td>
        <td>${window.migrationBadges.statusBadge(e.status)}</td>
        <td class="num">${money(e.value, e.currency)}</td>
      </tr>`).join('')}</tbody></table></div></div>` : ''}`;

  // Fiação do detalhe
  $('cd-upload').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('kind', 'contrato');
    try {
      await api(`/clients/${state.clientId}/contracts/${id}/files`, { method: 'POST', body: form });
      toast('Arquivo anexado.');
      await loadAll();
      openDetail(id);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('cd-body').querySelectorAll('[data-delfile]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Excluir este arquivo?')) return;
    try { await api(`/clients/${state.clientId}/contracts/${id}/files/${b.dataset.delfile}`, { method: 'DELETE' }); toast('Arquivo excluído.'); await loadAll(); openDetail(id); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $('cd-body').querySelectorAll('[data-unlinkm]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/clients/${state.clientId}/contracts/${id}/machines/${b.dataset.unlinkm}`, { method: 'DELETE' }); toast('Máquina desvinculada.'); await loadAll(); openDetail(id); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $('cd-body').querySelectorAll('[data-unlinks]').forEach((b) => b.addEventListener('click', async () => {
    const [productId, swSerial] = b.dataset.unlinks.split('|');
    try { await jsonPost(`/clients/${state.clientId}/contracts/${id}/software/unlink`, { items: [{ productId, swSerial }] }); toast('PID desvinculado.'); await loadAll(); openDetail(id); }
    catch (err) { toast(err.message, 'error'); }
  }));
  const addAd = $('cd-add-amendment');
  if (addAd) addAd.addEventListener('click', () => { closeModals(); openContractModal(null, { parent: id }); });
  $('cd-body').querySelectorAll('[data-openad]').forEach((b) => b.addEventListener('click', () => openDetail(b.dataset.openad)));
  $('cd-body').querySelectorAll('[data-editad]').forEach((b) => b.addEventListener('click', () => { closeModals(); openContractModal(b.dataset.editad); }));
  const goParent = document.querySelector('#cd-sub [data-goparent]');
  if (goParent) goParent.addEventListener('click', () => openDetail(goParent.dataset.goparent));
  $('cd-link-machines').addEventListener('click', () => openLinkMachines(id, d.machines));
  $('cd-link-software').addEventListener('click', () => openLinkSoftware(id));

  openModal('modal-contract-detail');
  if (window.__authApplyViewOnly) window.__authApplyViewOnly();
}

/* ── Vincular máquinas ────────────────────────────────── */
function openLinkMachines(contractId, jaVinculadas) {
  const atuais = new Set(jaVinculadas.map((m) => String(m._id)));
  const livres = state.machines.filter((m) => !atuais.has(String(m._id)));
  $('link-machines-list').innerHTML = livres.length
    ? livres.map((m) => `<label class="lpar-check"><input type="checkbox" value="${m._id}">
        ${esc(m.model || 'Máquina')} <span class="mono">${esc(m.serial || '')}</span>
        ${m.contractRef ? `<span class="badge badge-neutral">${esc(m.contractRef.number)}</span>` : ''}</label>`).join('')
    : '<div class="empty-inline small">Todas as máquinas já estão neste contrato.</div>';
  $('link-machines-error').classList.add('hidden');
  $('btn-save-link-machines').onclick = async () => {
    const ids = [...$('link-machines-list').querySelectorAll('input:checked')].map((i) => i.value);
    if (!ids.length) return;
    try {
      await jsonPost(`/clients/${state.clientId}/contracts/${contractId}/machines`, { machineIds: ids });
      closeModals(); toast('Máquinas vinculadas.'); await loadAll(); openDetail(contractId);
    } catch (e) { const el = $('link-machines-error'); el.textContent = e.message; el.classList.remove('hidden'); }
  };
  openModal('modal-link-machines');
}

/* ── Vincular software ────────────────────────────────── */
let swTimer = null;
function openLinkSoftware(contractId) {
  state.swSelection = new Map();
  $('sw-search').value = '';
  $('sw-results').innerHTML = '<div class="empty-inline small">Digite para buscar no inventário.</div>';
  $('link-sw-error').classList.add('hidden');

  const buscar = async () => {
    const q = $('sw-search').value.trim();
    if (q.length < 2) { $('sw-results').innerHTML = '<div class="empty-inline small">Digite ao menos 2 caracteres.</div>'; return; }
    try {
      const rows = await api(`/clients/${state.clientId}/inventory/records?q=${encodeURIComponent(q)}&limit=100`);
      $('sw-results').innerHTML = rows.length ? `<div class="table-responsive"><table class="infra-table">
        <thead><tr><th></th><th>PID</th><th>Serial</th><th>Descrição</th><th>Tipo</th></tr></thead>
        <tbody>${rows.map((p) => {
          const k = `${p.productId}|${p.swSerial}`;
          return `<tr><td><input type="checkbox" data-sw="${esc(k)}" ${state.swSelection.has(k) ? 'checked' : ''}></td>
            <td class="mono">${esc(p.productId)}</td><td class="mono">${esc(p.swSerial)}</td>
            <td>${esc(p.description || '')}</td>
            <td>${p.category === 'SS' ? '<span class="badge badge-neutral">S&amp;S</span>' : 'Licença'}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty-inline small">Nada encontrado.</div>';
      $('sw-results').querySelectorAll('[data-sw]').forEach((cb) => cb.addEventListener('change', () => {
        const [productId, swSerial] = cb.dataset.sw.split('|');
        if (cb.checked) state.swSelection.set(cb.dataset.sw, { productId, swSerial });
        else state.swSelection.delete(cb.dataset.sw);
      }));
    } catch (e) { $('sw-results').innerHTML = `<div class="empty-inline small">${esc(e.message)}</div>`; }
  };
  $('sw-search').oninput = () => { clearTimeout(swTimer); swTimer = setTimeout(buscar, 220); };

  $('btn-save-link-software').onclick = async () => {
    const items = [...state.swSelection.values()];
    if (!items.length) return;
    const err = $('link-sw-error');
    err.classList.add('hidden');
    try {
      await jsonPost(`/clients/${state.clientId}/contracts/${contractId}/software`, { items });
      closeModals(); toast('Software vinculado.'); await loadAll(); openDetail(contractId);
    } catch (e) {
      // 409: o registro já está em outro contrato — oferece mover.
      if (/já está no contrato/.test(e.message) && confirm(`${e.message}\n\nMover para este contrato?`)) {
        try {
          await jsonPost(`/clients/${state.clientId}/contracts/${contractId}/software`, { items, move: true });
          closeModals(); toast('Software movido para este contrato.'); await loadAll(); openDetail(contractId);
          return;
        } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); return; }
      }
      err.textContent = e.message; err.classList.remove('hidden');
    }
  };
  openModal('modal-link-software');
}

/* ── Ícones ───────────────────────────────────────────── */
const iconEdit = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M11 2.5l2.5 2.5L6 12.5l-3 .5.5-3L11 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const iconTrash = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const iconOpen = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4 12 12 4M6 4h6v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const iconCheck = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const iconPlay = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4.5 3.5v9l7-4.5-7-4.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const iconUndo = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 7h7a3 3 0 1 1 0 6H6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 4.5 3 7l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const iconClock = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3.2l2 1.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const iconUnlink = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M6.5 9.5 4 12M9.5 6.5 12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M9 11l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1M7 5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

/* ── Eventos ──────────────────────────────────────────── */
document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModals));
document.querySelectorAll('.modal-backdrop').forEach((bk) => {
  let press = false;
  bk.addEventListener('mousedown', (e) => { press = e.target === bk; });
  bk.addEventListener('mouseup', (e) => { if (press && e.target === bk) closeModals(); });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.modal-backdrop:not(.hidden)')) closeModals();
});
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderTab(); }));

$('client-select').addEventListener('change', async (e) => {
  state.clientId = e.target.value;
  localStorage.setItem('tfp.clientId', state.clientId);
  try { await loadAll(); } catch (err) { toast(`Falha ao carregar: ${err.message}`, 'error'); }
});
$('btn-new-contract').addEventListener('click', () => { if (state.clientId) openContractModal(null); });
$('btn-save-contract').addEventListener('click', saveContract);
$('ct-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  $('ct-file-name').textContent = f ? f.name : 'Nenhum arquivo escolhido';
});
$('btn-new-migration').addEventListener('click', () => {
  if (!state.clientId) return;
  const ativas = state.machines.filter((m) => m.status !== 'substituida');
  if (!ativas.length) { toast('Cadastre uma máquina na Infraestrutura antes.', 'error'); return; }
  window.openMigrationModal({
    clientId: state.clientId, machines: state.machines, contracts: state.contracts,
    onSaved: async () => { await loadAll(); state.tab = 'migracoes'; renderTab(); },
  });
});

loadClients().catch((err) => toast(`Falha ao carregar: ${err.message}`, 'error'));
