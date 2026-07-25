'use strict';

/* Módulo Infraestrutura: parque físico (Sites -> Máquinas -> LPARs) por cliente.
 * Cruza a máquina com o consumo do SCRT pelo serial. Sem foto e sem catálogo. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('pt-BR');
const fmt = (n) => (n == null ? '–' : nf.format(n));
const num1 = (n) => (n == null ? '–' : nf.format(Math.round(n * 10) / 10));

const ROLES = {
  prod: { label: 'Produção', color: '#0f62fe' },
  dr: { label: 'DR', color: '#da1e28' },
  ha: { label: 'HA', color: '#8a3800' },
  dev: { label: 'Dev', color: '#6929c4' },
  test: { label: 'Teste', color: '#009d9a' },
  colo: { label: 'Colocation', color: '#525252' },
};
const OS_LABELS = { linux: 'Linux', zos: 'z/OS', zvm: 'z/VM', kvm: 'KVM', other: 'Outro' };
const OS_COLOR = { linux: '#0f62fe', zos: '#161616', zvm: '#6929c4', kvm: '#009d9a', other: '#6f6f6f' };
const NIC_TYPES = ['OSA', 'RoCE', 'NetworkExpress', 'HiperSockets', 'Other'];
const MODEL_SUGGESTIONS = ['IBM z17', 'IBM z16', 'IBM z15', 'LinuxONE Emperor 5', 'LinuxONE Emperor 4', 'LinuxONE III', 'LinuxONE Rockhopper 4', 'LinuxONE Rockhopper III'];

const state = {
  clients: [],
  clientId: localStorage.getItem('tfp.clientId') || null,
  sites: [],
  machines: [],
  lpars: [], // todas as LPARs do cliente (para a aba plana)
  tab: 'overview',
  // contexto dos modais
  editSiteId: null,
  editMachineId: null,
  configMachineId: null,
  configData: { configTxtName: '', configTxtContent: '', configCfrName: '', configCfrContent: '' },
  lparsMachine: null, // máquina aberta no modal de LPARs
  editLparId: null,
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `Erro ${res.status}`);
  return body;
}
function toast(message, kind = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 4600);
}
const jsonPut = (path, body) => api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const jsonPost = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function showView(which) {
  ['empty-clients', 'infra-view'].forEach((id) => $(id).classList.toggle('hidden', id !== which));
}
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModals() { document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden')); }

/* ------------------------------------------------------------------ *
 *  Carregamento
 * ------------------------------------------------------------------ */

async function loadClients() {
  state.clients = await api('/clients');
  const select = $('client-select');
  select.innerHTML = state.clients.map((c) => `<option value="${c._id}">${esc(c.name)}</option>`).join('');
  if (!state.clients.length) { state.clientId = null; showView('empty-clients'); return; }
  if (!state.clients.some((c) => c._id === state.clientId)) state.clientId = state.clients[0]._id;
  select.value = state.clientId;
  localStorage.setItem('tfp.clientId', state.clientId);
  await loadInfra();
}

async function loadInfra() {
  const client = state.clients.find((c) => c._id === state.clientId);
  const [sites, machines, lpars] = await Promise.all([
    api(`/clients/${state.clientId}/infra/sites`),
    api(`/clients/${state.clientId}/infra/machines`),
    api(`/clients/${state.clientId}/infra/lpars`),
  ]);
  state.sites = sites;
  state.machines = machines;
  state.lpars = lpars;
  showView('infra-view');
  $('infra-client-name').textContent = client ? client.name : '—';
  $('infra-subtitle').textContent = `Parque físico IBM Z / LinuxONE · ${machines.length} máquina(s), ${sites.length} site(s)`;
  renderStats();
  renderTab();
}

// LPARs de uma máquina (a partir da lista já carregada).
const lparsOfMachine = (machineId) => state.lpars.filter((l) => (l.machine && (l.machine._id || l.machine)) === machineId);

/* ------------------------------------------------------------------ *
 *  KPIs / stats
 * ------------------------------------------------------------------ */

function drStatus() {
  const roles = new Set(state.sites.map((s) => s.role));
  if (!state.sites.length) return { label: 'Sem sites', color: 'var(--ink-muted)' };
  if (roles.has('dr')) return { label: 'DR ativo', color: 'var(--success)' };
  if (roles.has('ha')) return { label: 'HA configurado', color: 'var(--success)' };
  if (state.sites.length > 1) return { label: 'Multi-site', color: 'var(--accent)' };
  return { label: 'Site único', color: 'var(--warning)' };
}

function renderStats() {
  const ativas = state.machines.filter((m) => !m.dormant);
  const ifls = state.machines.reduce((a, m) => a + (m.iflsActive || 0), 0);
  const tb = state.machines.reduce((a, m) => a + (m.storageTB || 0) + (m.storageAddTB || 0), 0);
  const dr = drStatus();
  const cards = [
    { h: 'Sites', v: fmt(state.sites.length) },
    { h: 'Máquinas ativas', v: fmt(ativas.length), s: state.machines.length > ativas.length ? `${state.machines.length - ativas.length} dormente(s)` : 'nenhuma dormente' },
    { h: 'IFLs ativos', v: fmt(ifls) },
    { h: 'Storage total', v: `${num1(tb)} TB` },
    { h: 'Disponibilidade', v: `<span style="color:${dr.color};font-weight:600">${esc(dr.label)}</span>`, raw: true },
  ];
  $('infra-kpis').innerHTML = cards.map((c) =>
    `<div class="kpi-card"><h3>${esc(c.h)}</h3><div class="value">${c.raw ? c.v : esc(c.v)}</div>${c.s ? `<div class="subtitle">${esc(c.s)}</div>` : ''}</div>`).join('');
}

/* ------------------------------------------------------------------ *
 *  Abas
 * ------------------------------------------------------------------ */

function renderTab() {
  ['overview', 'machines', 'lpars'].forEach((t) => $(`tab-${t}`).classList.toggle('hidden', t !== state.tab));
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'overview') renderOverview();
  else if (state.tab === 'machines') renderMachines();
  else renderLparsTab();
}

// Chip compacto de LPAR (usado na visão geral).
function lparChip(l) {
  return `<span class="lpar-chip" title="${esc(l.name)}${l.osDistro ? ' · ' + esc(l.osDistro) : ''}">
    <span class="os-dot" style="background:${OS_COLOR[l.os] || '#6f6f6f'}"></span>${esc(l.name)}
    <span class="muted">${l.ifls ? l.ifls + ' IFL' : ''}</span></span>`;
}

function machineCardCompact(m) {
  const lps = lparsOfMachine(m._id);
  const grad = /linuxone/i.test(m.model) ? 'grad-linuxone' : 'grad-z';
  return `<button type="button" class="infra-machine-card${m.dormant ? ' dormant' : ''}" data-open-lpars="${m._id}" title="Ver LPARs">
    <div class="imc-head">
      <span class="imc-mark ${grad}"></span>
      <span class="imc-id"><strong>${esc(m.model || 'Máquina')}</strong>${m.featureModel ? ` <span class="muted small">${esc(m.featureModel)}</span>` : ''}
        <span class="muted small">${esc(m.serial || 's/ serial')}</span></span>
      <span class="imc-cap muted small">${fmt(m.iflsActive)} IFL${m.iflsSpare ? ' +' + m.iflsSpare : ''} · ${num1((m.storageTB || 0) + (m.storageAddTB || 0))} TB</span>
    </div>
    ${lps.length ? `<div class="lpar-strip">${lps.map(lparChip).join('')}</div>` : '<div class="lpar-strip muted small">sem LPARs</div>'}
  </button>`;
}

function renderOverview() {
  const el = $('tab-overview');
  if (!state.machines.length && !state.sites.length) {
    el.innerHTML = `<div class="empty-inline">Nenhuma máquina cadastrada. Use <strong>+ Máquina</strong> (e opcionalmente <strong>+ Site</strong>) para começar.</div>`;
    return;
  }
  const bySite = new Map(state.sites.map((s) => [s._id, []]));
  const semSite = [];
  for (const m of state.machines) {
    const sid = m.site && (m.site._id || m.site);
    if (sid && bySite.has(sid)) bySite.get(sid).push(m);
    else semSite.push(m);
  }
  const siteBlocks = state.sites.map((s) => {
    const ms = bySite.get(s._id) || [];
    const r = ROLES[s.role] || ROLES.prod;
    const ifls = ms.reduce((a, m) => a + (m.iflsActive || 0), 0);
    const tb = ms.reduce((a, m) => a + (m.storageTB || 0) + (m.storageAddTB || 0), 0);
    return `<div class="site-block" style="border-top-color:${r.color}">
      <div class="site-block-head">
        <span class="badge" style="background:${r.color}1a;color:${r.color}">${esc(r.label)}</span>
        <strong>${esc(s.name)}</strong>${s.location ? ` <span class="muted small">${esc(s.location)}</span>` : ''}
        <button type="button" class="btn-link" data-edit-site="${s._id}">editar</button>
      </div>
      ${ms.length ? ms.map(machineCardCompact).join('') : '<div class="empty-inline small">sem máquinas neste site</div>'}
      <div class="site-block-foot muted small">${ms.length} máquina(s) · ${fmt(ifls)} IFLs · ${num1(tb)} TB</div>
    </div>`;
  }).join('');
  const semSiteBlock = semSite.length
    ? `<div class="site-block site-block-nosite">
        <div class="site-block-head"><span class="badge badge-neutral">Sem site</span><strong>Máquinas sem site definido</strong></div>
        ${semSite.map(machineCardCompact).join('')}
      </div>`
    : '';
  el.innerHTML = `<div class="site-columns">${siteBlocks}${semSiteBlock}</div>`;
  wireOverview(el);
}

function wireOverview(el) {
  el.querySelectorAll('[data-open-lpars]').forEach((b) => b.addEventListener('click', () => openLparsModal(b.dataset.openLpars)));
  el.querySelectorAll('[data-edit-site]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openSiteModal(b.dataset.editSite); }));
}

/* ------------------------------------------------------------------ *
 *  Aba Máquinas (tabela)
 * ------------------------------------------------------------------ */

let machineFilter = { q: '', site: '', model: '' };

function renderMachines() {
  const el = $('tab-machines');
  const sitesOpts = ['<option value="">Todos os sites</option>']
    .concat(state.sites.map((s) => `<option value="${s._id}"${machineFilter.site === s._id ? ' selected' : ''}>${esc(s.name)}</option>`)).join('');
  const models = [...new Set(state.machines.map((m) => m.model).filter(Boolean))].sort();
  const modelOpts = ['<option value="">Todos os modelos</option>']
    .concat(models.map((m) => `<option value="${esc(m)}"${machineFilter.model === m ? ' selected' : ''}>${esc(m)}</option>`)).join('');

  el.innerHTML = `
    <div class="infra-toolbar">
      <input type="search" id="machine-search" class="infra-search" placeholder="Buscar por modelo ou serial" value="${esc(machineFilter.q)}">
      <select id="machine-filter-site">${sitesOpts}</select>
      <select id="machine-filter-model">${modelOpts}</select>
    </div>
    <div class="card">
      <div class="table-responsive">
        <table class="infra-table">
          <thead><tr>
            <th>Modelo</th><th>Site</th><th>Serial</th>
            <th class="num">IFLs</th><th class="num">Storage</th><th class="num">Ano</th>
            <th>Consumo (SCRT)</th><th class="infra-actions-col">Ações</th>
          </tr></thead>
          <tbody id="machine-rows"></tbody>
        </table>
      </div>
    </div>`;
  renderMachineRows();
  $('machine-search').addEventListener('input', (e) => { machineFilter.q = e.target.value; renderMachineRows(); });
  $('machine-filter-site').addEventListener('change', (e) => { machineFilter.site = e.target.value; renderMachineRows(); });
  $('machine-filter-model').addEventListener('change', (e) => { machineFilter.model = e.target.value; renderMachineRows(); });
}

function renderMachineRows() {
  const q = machineFilter.q.trim().toLowerCase();
  const rows = state.machines.filter((m) => {
    if (machineFilter.site && (m.site && (m.site._id || m.site)) !== machineFilter.site) return false;
    if (machineFilter.model && m.model !== machineFilter.model) return false;
    if (q && !(`${m.model} ${m.serial}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const tbody = $('machine-rows');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="muted small" style="padding:14px">Nenhuma máquina.</td></tr>'; return; }
  tbody.innerHTML = rows.map((m) => {
    const grad = /linuxone/i.test(m.model) ? 'grad-linuxone' : 'grad-z';
    const r = m.site && ROLES[m.site.role];
    const siteCell = m.site
      ? `<span class="badge" style="background:${r.color}1a;color:${r.color}">${esc(ROLES[m.site.role].label)}</span> ${esc(m.site.name)}`
      : '<span class="muted small">—</span>';
    let scrtCell = '<span class="muted small">—</span>';
    if (m.scrt) {
      const tag = m.scrt.tag ? ` <span class="badge badge-neutral">${esc(m.scrt.tag)}</span>` : '';
      scrtCell = `${fmt(m.scrt.msuConsumed)} MSU${tag}<div class="muted small">${esc(m.scrt.periodLabel)}${m.scrt.ignored ? ' · ignorada' : ''}</div>`;
    }
    const lpc = lparsOfMachine(m._id).length;
    return `<tr class="${m.dormant ? 'machine-dormant' : ''}">
      <td><span class="imc-mark ${grad} inline"></span><strong>${esc(m.model || '—')}</strong>${m.variant ? ` <span class="muted small">${esc(m.variant)}</span>` : ''}${m.featureModel ? `<div class="muted small">${esc(m.featureModel)}</div>` : ''}${m.dormant ? ' <span class="badge badge-neutral">dormente</span>' : ''}</td>
      <td>${siteCell}</td>
      <td class="mono">${esc(m.serial || '—')}</td>
      <td class="num">${fmt(m.iflsActive)}${m.iflsSpare ? ` <span class="muted small">+${m.iflsSpare}</span>` : ''}</td>
      <td class="num">${num1((m.storageTB || 0) + (m.storageAddTB || 0))} TB</td>
      <td class="num">${m.year || '—'}</td>
      <td>${scrtCell}</td>
      <td class="infra-actions">
        <button class="row-action" data-lpars="${m._id}" title="LPARs (${lpc})">${iconCpu()}</button>
        <button class="row-action" data-config="${m._id}" title="Arquivos de configuração">${iconFile()}</button>
        <button class="row-action" data-edit="${m._id}" title="Editar">${iconEdit()}</button>
        <button class="row-action danger" data-del="${m._id}" title="Excluir">${iconTrash()}</button>
      </td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('[data-lpars]').forEach((b) => b.addEventListener('click', () => openLparsModal(b.dataset.lpars)));
  tbody.querySelectorAll('[data-config]').forEach((b) => b.addEventListener('click', () => openConfigModal(b.dataset.config)));
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openMachineModal(b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteMachine(b.dataset.del)));
}

/* ------------------------------------------------------------------ *
 *  Aba LPARs (tabela plana)
 * ------------------------------------------------------------------ */

function renderLparsTab() {
  const el = $('tab-lpars');
  if (!state.lpars.length) { el.innerHTML = '<div class="empty-inline">Nenhuma LPAR cadastrada. Abra uma máquina para adicionar LPARs.</div>'; return; }
  const rows = [...state.lpars].sort((a, b) => String((a.machine && a.machine.model) || '').localeCompare(String((b.machine && b.machine.model) || '')) || a.name.localeCompare(b.name));
  el.innerHTML = `<div class="card"><div class="table-responsive"><table class="infra-table">
    <thead><tr><th>LPAR</th><th>Máquina</th><th>SO</th><th class="num">IFLs</th><th class="num">CPs</th><th class="num">Memória</th><th>Rede</th></tr></thead>
    <tbody>${rows.map((l) => {
      const mid = l.machine && (l.machine._id || l.machine);
      return `<tr class="row-clickable" data-open-lpars="${mid}">
        <td><span class="os-dot" style="background:${OS_COLOR[l.os] || '#6f6f6f'}"></span><strong>${esc(l.name)}</strong>${l.osDistro ? ` <span class="muted small">${esc(l.osDistro)}</span>` : ''}</td>
        <td>${esc((l.machine && l.machine.model) || '—')}${l.machine && l.machine.serial ? ` <span class="muted small">${esc(l.machine.serial)}</span>` : ''}</td>
        <td>${esc(OS_LABELS[l.os] || l.os)}</td>
        <td class="num">${fmt(l.ifls)}</td>
        <td class="num">${fmt(l.cps)}</td>
        <td class="num">${l.memoryGB ? l.memoryGB + ' GB' : '—'}</td>
        <td class="muted small">${(l.ips || []).length} IP · ${(l.wwpns || []).length} WWPN · ${(l.networkCards || []).length} placa(s)</td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
  el.querySelectorAll('[data-open-lpars]').forEach((r) => r.addEventListener('click', () => openLparsModal(r.dataset.openLpars)));
}

/* ------------------------------------------------------------------ *
 *  Modal: Site
 * ------------------------------------------------------------------ */

let siteRoleSel = 'prod';
function openSiteModal(siteId) {
  state.editSiteId = siteId || null;
  const s = siteId ? state.sites.find((x) => x._id === siteId) : null;
  $('modal-site-title').textContent = s ? 'Editar site' : 'Novo site';
  $('site-name').value = s ? s.name : '';
  $('site-location').value = s ? s.location : '';
  $('site-notes').value = s ? s.notes : '';
  siteRoleSel = s ? s.role : 'prod';
  $('site-role').innerHTML = Object.entries(ROLES).map(([k, r]) =>
    `<button type="button" class="role-opt${siteRoleSel === k ? ' active' : ''}" data-role="${k}" style="--rc:${r.color}">${esc(r.label)}</button>`).join('');
  $('site-role').querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
    siteRoleSel = b.dataset.role;
    $('site-role').querySelectorAll('[data-role]').forEach((x) => x.classList.toggle('active', x === b));
  }));
  $('site-error').classList.add('hidden');
  openModal('modal-site');
  $('site-name').focus();
}

async function saveSite() {
  const body = { name: $('site-name').value.trim(), location: $('site-location').value.trim(), role: siteRoleSel, notes: $('site-notes').value.trim() };
  if (!body.name) return showErr('site-error', 'Informe o nome do site.');
  try {
    if (state.editSiteId) await jsonPut(`/clients/${state.clientId}/infra/sites/${state.editSiteId}`, body);
    else await jsonPost(`/clients/${state.clientId}/infra/sites`, body);
    closeModals();
    await loadInfra();
    toast('Site salvo.');
  } catch (err) { showErr('site-error', err.message); }
}

/* ------------------------------------------------------------------ *
 *  Modal: Máquina
 * ------------------------------------------------------------------ */

function openMachineModal(machineId) {
  state.editMachineId = machineId || null;
  const m = machineId ? state.machines.find((x) => x._id === machineId) : null;
  $('modal-machine-title').textContent = m ? 'Editar máquina' : 'Nova máquina';
  $('model-suggestions').innerHTML = MODEL_SUGGESTIONS.map((s) => `<option value="${esc(s)}">`).join('');
  const set = (id, v) => { $(id).value = v == null ? '' : v; };
  set('machine-model', m ? m.model : '');
  set('machine-variant', m ? m.variant : '');
  set('machine-feature', m ? m.featureModel : '');
  set('machine-serial', m ? m.serial : '');
  set('machine-year', m ? m.year : '');
  set('machine-ifls', m ? m.iflsActive : '');
  set('machine-ifls-spare', m ? m.iflsSpare : '');
  set('machine-storage', m ? m.storageTB : '');
  set('machine-storage-add', m ? m.storageAddTB : '');
  set('machine-notes', m ? m.notes : '');
  $('machine-dormant').checked = m ? !!m.dormant : false;
  const cur = m && m.site && (m.site._id || m.site);
  $('machine-site').innerHTML = ['<option value="">(sem site)</option>']
    .concat(state.sites.map((s) => `<option value="${s._id}"${cur === s._id ? ' selected' : ''}>${esc(s.name)} · ${esc((ROLES[s.role] || {}).label || s.role)}</option>`)).join('');
  $('machine-error').classList.add('hidden');
  openModal('modal-machine');
  $('machine-model').focus();
}

async function saveMachine() {
  const numv = (id) => { const v = $(id).value; return v === '' ? 0 : Number(v); };
  const body = {
    model: $('machine-model').value.trim(),
    variant: $('machine-variant').value.trim(),
    featureModel: $('machine-feature').value.trim(),
    serial: $('machine-serial').value.trim(),
    year: $('machine-year').value === '' ? null : Number($('machine-year').value),
    site: $('machine-site').value || null,
    iflsActive: numv('machine-ifls'),
    iflsSpare: numv('machine-ifls-spare'),
    storageTB: numv('machine-storage'),
    storageAddTB: numv('machine-storage-add'),
    dormant: $('machine-dormant').checked,
    notes: $('machine-notes').value.trim(),
  };
  if (!body.model && !body.serial) return showErr('machine-error', 'Informe ao menos o modelo ou o serial.');
  try {
    if (state.editMachineId) await jsonPut(`/clients/${state.clientId}/infra/machines/${state.editMachineId}`, body);
    else await jsonPost(`/clients/${state.clientId}/infra/machines`, body);
    closeModals();
    await loadInfra();
    toast('Máquina salva.');
  } catch (err) { showErr('machine-error', err.message); }
}

async function deleteMachine(id) {
  const m = state.machines.find((x) => x._id === id);
  const n = lparsOfMachine(id).length;
  if (!confirm(`Excluir a máquina ${m ? (m.model || m.serial) : ''}?${n ? ` As ${n} LPAR(s) dela também serão removidas.` : ''}`)) return;
  try { await api(`/clients/${state.clientId}/infra/machines/${id}`, { method: 'DELETE' }); await loadInfra(); toast('Máquina excluída.'); }
  catch (err) { toast(err.message, 'error'); }
}

/* ------------------------------------------------------------------ *
 *  Modal: Arquivos de configuração
 * ------------------------------------------------------------------ */

async function openConfigModal(machineId) {
  state.configMachineId = machineId;
  const m = state.machines.find((x) => x._id === machineId);
  $('config-machine-label').textContent = m ? `${m.model || 'Máquina'} · ${m.serial || 's/ serial'}` : '';
  $('config-error').classList.add('hidden');
  $('config-slots').innerHTML = '<p class="muted small">Carregando…</p>';
  openModal('modal-config');
  try {
    const full = await api(`/clients/${state.clientId}/infra/machines/${machineId}`);
    state.configData = {
      configTxtName: full.configTxtName || '', configTxtContent: full.configTxtContent || '',
      configCfrName: full.configCfrName || '', configCfrContent: full.configCfrContent || '',
    };
    renderConfigSlots();
  } catch (err) { showErr('config-error', err.message); }
}

function renderConfigSlots() {
  const slot = (key, label, accept) => {
    const name = state.configData[`config${key}Name`];
    const content = state.configData[`config${key}Content`];
    return `<div class="config-slot">
      <div class="config-slot-head"><strong>${esc(label)}</strong>${name ? ` <span class="muted small">${esc(name)} · ${content.length} car.</span>` : ' <span class="muted small">nenhum arquivo</span>'}</div>
      <div class="config-slot-actions">
        <label class="btn btn-ghost btn-sm">Carregar<input type="file" accept="${accept}" data-upload="${key}" hidden></label>
        ${content ? `<button type="button" class="btn btn-ghost btn-sm" data-view="${key}">Ver</button>
          <button type="button" class="btn btn-ghost btn-sm" data-download="${key}">Baixar</button>
          <button type="button" class="btn btn-danger-ghost btn-sm" data-clear="${key}">Limpar</button>` : ''}
      </div>
      <pre class="config-preview hidden" data-preview="${key}">${esc(content)}</pre>
    </div>`;
  };
  const el = $('config-slots');
  el.innerHTML = slot('Txt', 'Configuração (.txt)', '.txt,text/plain') + slot('Cfr', 'Configuração (.cfr)', '.cfr,text/plain');
  el.querySelectorAll('[data-upload]').forEach((inp) => inp.addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { const k = inp.dataset.upload; state.configData[`config${k}Name`] = f.name; state.configData[`config${k}Content`] = String(rd.result); renderConfigSlots(); };
    rd.readAsText(f);
  }));
  el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => el.querySelector(`[data-preview="${b.dataset.view}"]`).classList.toggle('hidden')));
  el.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.clear; state.configData[`config${k}Name`] = ''; state.configData[`config${k}Content`] = ''; renderConfigSlots(); }));
  el.querySelectorAll('[data-download]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.download;
    const blob = new Blob([state.configData[`config${k}Content`]], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = state.configData[`config${k}Name`] || `config.${k.toLowerCase()}`; a.click(); URL.revokeObjectURL(a.href);
  }));
}

async function saveConfig() {
  try {
    await jsonPut(`/clients/${state.clientId}/infra/machines/${state.configMachineId}`, state.configData);
    closeModals();
    toast('Arquivos de configuração salvos.');
  } catch (err) { showErr('config-error', err.message); }
}

/* ------------------------------------------------------------------ *
 *  Modal: LPARs de uma máquina
 * ------------------------------------------------------------------ */

function openLparsModal(machineId) {
  const m = state.machines.find((x) => x._id === machineId);
  if (!m) return;
  state.lparsMachine = m;
  state.editLparId = null;
  $('modal-lpars-title').textContent = `LPARs · ${m.model || 'Máquina'}`;
  $('lpar-form').classList.add('hidden');
  $('lpar-form').innerHTML = '';
  renderLparsList();
  openModal('modal-lpars');
}

function renderLparsList() {
  const m = state.lparsMachine;
  const lps = lparsOfMachine(m._id);
  const totalIfls = lps.reduce((a, l) => a + (l.ifls || 0), 0);
  const over = totalIfls > (m.iflsActive || 0);
  $('lpars-machine-sub').innerHTML = `${lps.length} LPAR(s) · ${totalIfls} IFLs alocados de ${fmt(m.iflsActive)} ativos`
    + (over ? ' <span class="badge badge-danger">acima do configurado</span>' : '');
  const list = $('lpars-list');
  if (!lps.length) { list.innerHTML = '<div class="empty-inline small">Nenhuma LPAR nesta máquina. Use "+ Nova LPAR".</div>'; return; }
  list.innerHTML = lps.map((l) => `
    <div class="lpar-card">
      <div class="lpar-card-head">
        <span class="os-dot" style="background:${OS_COLOR[l.os] || '#6f6f6f'}"></span>
        <strong>${esc(l.name)}</strong>
        <span class="badge badge-neutral">${esc(OS_LABELS[l.os] || l.os)}</span>${l.osDistro ? ` <span class="muted small">${esc(l.osDistro)}</span>` : ''}
        <span class="lpar-card-actions">
          <button class="btn-link" data-edit-lpar="${l._id}">editar</button>
          <button class="btn-link danger" data-del-lpar="${l._id}">excluir</button>
        </span>
      </div>
      <div class="lpar-grid">
        <div><span class="muted small">IFLs / CPs</span><div>${fmt(l.ifls)}${l.cps ? ` · ${l.cps} CP` : ''}</div></div>
        <div><span class="muted small">Memória</span><div>${l.memoryGB ? l.memoryGB + ' GB' : '–'}</div></div>
        <div><span class="muted small">Placas</span><div>${(l.networkCards || []).length ? l.networkCards.map((c) => `${esc(c.type)}${c.label ? ' ' + esc(c.label) : ''}`).join(', ') : '–'}</div></div>
      </div>
      ${l.description ? `<div class="muted small">${esc(l.description)}</div>` : ''}
      <div class="lpar-grid">
        <div><span class="muted small">Devices</span><div class="mono small">${(l.devices || []).length ? esc(l.devices.join(', ')) : '–'}</div></div>
        <div><span class="muted small">WWPNs</span><div class="mono small">${(l.wwpns || []).length ? esc(l.wwpns.join(', ')) : '–'}</div></div>
        <div><span class="muted small">IPs</span><div class="mono small">${(l.ips || []).length ? esc(l.ips.join(', ')) : '–'}</div></div>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-edit-lpar]').forEach((b) => b.addEventListener('click', () => openLparForm(b.dataset.editLpar)));
  list.querySelectorAll('[data-del-lpar]').forEach((b) => b.addEventListener('click', () => deleteLpar(b.dataset.delLpar)));
}

function openLparForm(lparId) {
  state.editLparId = lparId || null;
  const l = lparId ? state.lpars.find((x) => x._id === lparId) : null;
  const cards = (l && l.networkCards) || [];
  const f = $('lpar-form');
  f.innerHTML = `
    <h3 class="compare-subtitle">${l ? 'Editar LPAR' : 'Nova LPAR'}</h3>
    <div class="machine-grid">
      <label class="field"><span>Nome *</span><input type="text" id="lp-name" maxlength="60" value="${esc(l ? l.name : '')}"></label>
      <label class="field"><span>Sistema operacional</span><select id="lp-os">${Object.entries(OS_LABELS).map(([k, v]) => `<option value="${k}"${l && l.os === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>Distribuição/versão</span><input type="text" id="lp-distro" maxlength="60" value="${esc(l ? l.osDistro : '')}" placeholder="RHEL 10.2, z/OS 3.1"></label>
      <label class="field"><span>IFLs</span><input type="number" id="lp-ifls" min="0" step="any" value="${l ? l.ifls : ''}"></label>
      <label class="field"><span>CPs / vCPUs</span><input type="number" id="lp-cps" min="0" step="any" value="${l ? l.cps : ''}"></label>
      <label class="field"><span>Memória (GB)</span><input type="number" id="lp-mem" min="0" step="any" value="${l ? l.memoryGB : ''}"></label>
    </div>
    <label class="field"><span>Descrição</span><input type="text" id="lp-desc" maxlength="200" value="${esc(l ? l.description : '')}"></label>
    <div class="machine-grid">
      <label class="field"><span>Devices <span class="muted small">(vírgula)</span></span><input type="text" id="lp-devices" value="${esc((l && l.devices || []).join(', '))}"></label>
      <label class="field"><span>WWPNs <span class="muted small">(vírgula)</span></span><input type="text" id="lp-wwpns" value="${esc((l && l.wwpns || []).join(', '))}"></label>
      <label class="field"><span>IPs <span class="muted small">(vírgula)</span></span><input type="text" id="lp-ips" value="${esc((l && l.ips || []).join(', '))}"></label>
    </div>
    <div class="field"><span>Placas de rede</span><div id="lp-nics"></div>
      <button type="button" class="btn btn-ghost btn-sm" id="lp-add-nic">+ Placa</button></div>
    <label class="field"><span>Notas</span><input type="text" id="lp-notes" maxlength="200" value="${esc(l ? l.notes : '')}"></label>
    <p class="form-error hidden" id="lpar-error"></p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="lp-cancel">Cancelar</button>
      <button type="button" class="btn btn-primary" id="lp-save">Salvar LPAR</button>
    </div>`;
  nicDraft = cards.map((c) => ({ type: c.type, label: c.label }));
  renderNics();
  f.classList.remove('hidden');
  $('lp-add-nic').addEventListener('click', () => { syncNics(); nicDraft.push({ type: 'OSA', label: '' }); renderNics(); });
  $('lp-cancel').addEventListener('click', () => { f.classList.add('hidden'); f.innerHTML = ''; });
  $('lp-save').addEventListener('click', saveLpar);
  $('lp-name').focus();
}

let nicDraft = [];
function renderNics() {
  $('lp-nics').innerHTML = nicDraft.map((c, i) => `<div class="nic-row">
    <select class="nic-type" data-i="${i}">${NIC_TYPES.map((t) => `<option${c.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
    <input type="text" class="nic-label" data-i="${i}" value="${esc(c.label)}" placeholder="CHPID / porta">
    <button type="button" class="btn-icon" data-rm-nic="${i}" aria-label="Remover">×</button></div>`).join('') || '<span class="muted small">nenhuma placa</span>';
  $('lp-nics').querySelectorAll('[data-rm-nic]').forEach((b) => b.addEventListener('click', () => { syncNics(); nicDraft.splice(+b.dataset.rmNic, 1); renderNics(); }));
}
function syncNics() {
  document.querySelectorAll('#lp-nics .nic-type').forEach((s) => { nicDraft[+s.dataset.i].type = s.value; });
  document.querySelectorAll('#lp-nics .nic-label').forEach((s) => { nicDraft[+s.dataset.i].label = s.value; });
}

async function saveLpar() {
  syncNics();
  const numv = (id) => { const v = $(id).value; return v === '' ? 0 : Number(v); };
  const list = (id) => $(id).value.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
  const body = {
    machine: state.lparsMachine._id,
    name: $('lp-name').value.trim(),
    os: $('lp-os').value,
    osDistro: $('lp-distro').value.trim(),
    ifls: numv('lp-ifls'), cps: numv('lp-cps'), memoryGB: numv('lp-mem'),
    description: $('lp-desc').value.trim(),
    devices: list('lp-devices'), wwpns: list('lp-wwpns'), ips: list('lp-ips'),
    networkCards: nicDraft.map((c) => ({ type: c.type, label: c.label.trim() })).filter((c) => c.label),
    notes: $('lp-notes').value.trim(),
  };
  if (!body.name) return showErr('lpar-error', 'Informe o nome da LPAR.');
  try {
    if (state.editLparId) await jsonPut(`/clients/${state.clientId}/infra/lpars/${state.editLparId}`, body);
    else await jsonPost(`/clients/${state.clientId}/infra/lpars`, body);
    // recarrega as LPARs e re-renderiza o modal + a aba de fundo
    state.lpars = await api(`/clients/${state.clientId}/infra/lpars`);
    $('lpar-form').classList.add('hidden'); $('lpar-form').innerHTML = '';
    renderLparsList();
    renderTab();
    toast('LPAR salva.');
  } catch (err) { showErr('lpar-error', err.message); }
}

async function deleteLpar(id) {
  const l = state.lpars.find((x) => x._id === id);
  if (!confirm(`Excluir a LPAR ${l ? l.name : ''}?`)) return;
  try {
    await api(`/clients/${state.clientId}/infra/lpars/${id}`, { method: 'DELETE' });
    state.lpars = await api(`/clients/${state.clientId}/infra/lpars`);
    renderLparsList(); renderTab();
    toast('LPAR excluída.');
  } catch (err) { toast(err.message, 'error'); }
}

/* ------------------------------------------------------------------ *
 *  Ícones + utilidades
 * ------------------------------------------------------------------ */

function showErr(id, msg) { const el = $(id); el.textContent = msg; el.classList.remove('hidden'); }
const iconCpu = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const iconFile = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M9 1.5H4.5A1 1 0 0 0 3.5 2.5v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L9 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1.5V5h3.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const iconEdit = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M11 2.5l2.5 2.5L6 12.5l-3 .5.5-3L11 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const iconTrash = () => '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ------------------------------------------------------------------ *
 *  Eventos globais
 * ------------------------------------------------------------------ */

$('client-select').addEventListener('change', async (e) => {
  state.clientId = e.target.value;
  localStorage.setItem('tfp.clientId', state.clientId);
  machineFilter = { q: '', site: '', model: '' };
  try { await loadInfra(); } catch (err) { toast(`Falha ao carregar: ${err.message}`, 'error'); }
});

document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderTab(); }));

$('btn-new-site').addEventListener('click', () => { if (state.clientId) openSiteModal(null); });
$('btn-new-machine').addEventListener('click', () => { if (state.clientId) openMachineModal(null); });
$('btn-save-site').addEventListener('click', saveSite);
$('btn-save-machine').addEventListener('click', saveMachine);
$('btn-save-config').addEventListener('click', saveConfig);
$('btn-add-lpar').addEventListener('click', () => openLparForm(null));

document.querySelectorAll('.modal-backdrop').forEach((bk) => {
  let press = false;
  bk.addEventListener('mousedown', (e) => { press = e.target === bk; });
  bk.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) return closeModals();
    if (e.target === bk && press) closeModals();
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.modal-backdrop:not(.hidden)')) closeModals();
});

loadClients().catch((err) => toast(`Falha ao carregar: ${err.message}`, 'error'));
