'use strict';

/* Administração de usuários: lista, cria, edita e exclui usuários, e define o
   acesso (ver / ver e editar) de cada usuário por cliente. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const state = {
  users: [],
  clients: [],
  editingId: null,      // id do usuário em edição (null = novo)
  role: 'user',         // papel selecionado no modal
  access: new Map(),    // clientId -> 'view' | 'edit'
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, opts);
  let body = null;
  try { body = await res.json(); } catch { /* sem corpo */ }
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

function initials(name, email) {
  const base = (name || email || '?').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  const chars = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : base.slice(0, 2);
  return chars.toUpperCase();
}

/* ── Modais ─────────────────────────────────────────── */
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModals() { document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden')); }
document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModals));
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  let pressOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('mouseup', (e) => { if (pressOnBackdrop && e.target === backdrop) closeModals(); });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

/* ── Carregamento ───────────────────────────────────── */
async function load() {
  [state.users, state.clients] = await Promise.all([
    api('/admin/users'),
    api('/clients'),
  ]);
  renderKpis();
  renderTable();
}

function renderKpis() {
  const total = state.users.length;
  const admins = state.users.filter((u) => u.role === 'admin').length;
  const regular = total - admins;
  $('admin-kpis').innerHTML = [
    ['Usuários', total, 'contas ativas'],
    ['Administradores', admins, 'acesso total'],
    ['Usuários comuns', regular, 'acesso por cliente'],
    ['Clientes', state.clients.length, 'disponíveis para associar'],
  ].map(([h, v, s]) => `
    <div class="kpi-card"><h3>${h}</h3><div class="value">${v}</div><div class="subtitle">${s}</div></div>
  `).join('');
}

function accessSummary(u) {
  if (u.role === 'admin') return '<span class="access-chip all">Todos os clientes</span>';
  const list = u.access || [];
  if (!list.length) return '<span class="muted small">— sem acesso</span>';
  const byId = new Map(state.clients.map((c) => [String(c._id), c.name]));
  return '<div class="access-summary">' + list.map((a) => {
    const name = byId.get(String(a.client)) || 'cliente removido';
    const cls = a.level === 'edit' ? 'edit' : '';
    const suf = a.level === 'edit' ? ' · editar' : '';
    return `<span class="access-chip ${cls}">${esc(name)}${suf}</span>`;
  }).join('') + '</div>';
}

function renderTable() {
  const body = $('users-body');
  const me = window.__me || {};
  if (!state.users.length) { body.innerHTML = ''; $('users-empty').classList.remove('hidden'); return; }
  $('users-empty').classList.add('hidden');
  body.innerHTML = state.users.map((u) => {
    const isSelf = String(u._id) === String(me._id);
    const roleTag = u.role === 'admin'
      ? '<span class="role-tag admin">Administrador</span>'
      : '<span class="role-tag user">Usuário</span>';
    return `
      <tr>
        <td>
          <div class="user-cell">
            <span class="user-avatar">${esc(initials(u.name, u.email))}</span>
            <strong>${esc(u.name)}${isSelf ? ' <span class="muted small">(você)</span>' : ''}</strong>
          </div>
        </td>
        <td class="mono">${esc(u.email)}</td>
        <td>${roleTag}</td>
        <td>${accessSummary(u)}</td>
        <td class="col-actions">
          <button class="row-action" data-edit="${u._id}" title="Editar" aria-label="Editar">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11 2.5l2.5 2.5L6 12.5l-3 .5.5-3L11 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          </button>
        </td>
      </tr>`;
  }).join('');
  body.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openUserModal(b.getAttribute('data-edit'))));
}

/* ── Modal de usuário ───────────────────────────────── */
const ROLES = [
  { key: 'user', label: 'Usuário', desc: 'Acesso por cliente', color: '#0f62fe' },
  { key: 'admin', label: 'Administrador', desc: 'Acesso total', color: '#6929c4' },
];

function renderRolePicker() {
  $('u-role').innerHTML = ROLES.map((r) => `
    <button type="button" class="role-opt role-opt-2 ${state.role === r.key ? 'active' : ''}" data-role="${r.key}" style="--rc:${r.color}">
      <strong>${r.label}</strong><span>${r.desc}</span>
    </button>`).join('');
  $('u-role').querySelectorAll('[data-role]').forEach((b) =>
    b.addEventListener('click', () => { state.role = b.getAttribute('data-role'); renderRolePicker(); renderAccessBlock(); }));
}

function renderAccessBlock() {
  const isAdmin = state.role === 'admin';
  $('u-access-block').style.display = isAdmin ? 'none' : '';
  $('u-access-admin-note').style.display = isAdmin ? '' : 'none';
  if (isAdmin) return;
  const list = $('u-access-list');
  if (!state.clients.length) {
    list.innerHTML = '<div class="access-empty">Nenhum cliente cadastrado. Cadastre clientes no módulo de consumo zOTC.</div>';
    return;
  }
  list.innerHTML = state.clients.map((c) => {
    const lvl = state.access.get(String(c._id)) || 'none';
    const seg = (val, label, extra = '') => {
      const on = lvl === val;
      return `<button type="button" data-client="${c._id}" data-level="${val}" class="${on ? 'on ' + extra : ''}">${label}</button>`;
    };
    return `
      <div class="access-row">
        <span class="ar-name">${esc(c.name)}</span>
        <div class="access-seg">
          ${seg('none', 'Sem acesso')}
          ${seg('view', 'Ver')}
          ${seg('edit', 'Ver e editar', 'edit-on')}
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('[data-client]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-client');
    const level = b.getAttribute('data-level');
    if (level === 'none') state.access.delete(String(id));
    else state.access.set(String(id), level);
    renderAccessBlock();
  }));
}

function bulkAccess(level) {
  state.access.clear();
  if (level !== 'none') state.clients.forEach((c) => state.access.set(String(c._id), level));
  renderAccessBlock();
}
document.querySelectorAll('[data-bulk]').forEach((b) =>
  b.addEventListener('click', () => bulkAccess(b.getAttribute('data-bulk'))));

function openUserModal(id) {
  state.editingId = id || null;
  const u = id ? state.users.find((x) => String(x._id) === String(id)) : null;
  const me = window.__me || {};
  const isSelf = u && String(u._id) === String(me._id);

  $('modal-user-title').textContent = u ? 'Editar usuário' : 'Novo usuário';
  $('u-name').value = u ? u.name : '';
  $('u-email').value = u ? u.email : '';
  $('u-email').disabled = !!u; // e-mail é a identidade — não muda na edição
  $('u-password').value = '';
  $('u-password').placeholder = u ? 'deixe em branco para manter' : 'mínimo 6 caracteres';
  $('u-pass-label').textContent = u ? 'Nova senha' : 'Senha *';

  state.role = u ? u.role : 'user';
  state.access = new Map((u && u.access || []).map((a) => [String(a.client), a.level]));

  // Não deixa o admin rebaixar/excluir a si mesmo por engano.
  const delBtn = $('btn-delete-user');
  delBtn.style.display = u && !isSelf ? '' : 'none';
  delBtn.onclick = u && !isSelf ? () => deleteUser(u) : null;

  $('u-error').classList.add('hidden');
  renderRolePicker();
  renderAccessBlock();
  openModal('modal-user');
  setTimeout(() => $('u-name').focus(), 40);
}

function accessPayload() {
  const out = [];
  state.access.forEach((level, client) => out.push({ client, level }));
  return out;
}

async function saveUser() {
  const name = $('u-name').value.trim();
  const email = $('u-email').value.trim();
  const password = $('u-password').value;
  const err = $('u-error');
  err.classList.add('hidden');

  const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
  if (!name) return fail('Informe o nome.');
  if (!state.editingId && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('E-mail inválido.');
  if (!state.editingId && password.length < 6) return fail('A senha precisa de ao menos 6 caracteres.');
  if (state.editingId && password && password.length < 6) return fail('A nova senha precisa de ao menos 6 caracteres.');

  const payload = { name, role: state.role, access: state.role === 'admin' ? [] : accessPayload() };
  if (!state.editingId) { payload.email = email; payload.password = password; }
  else if (password) payload.password = password;

  const btn = $('btn-save-user');
  btn.disabled = true;
  try {
    if (state.editingId) {
      await api(`/admin/users/${state.editingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      toast('Usuário atualizado.');
    } else {
      await api('/admin/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      toast('Usuário criado.');
    }
    closeModals();
    await load();
  } catch (e) {
    fail(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteUser(u) {
  if (!confirm(`Excluir o usuário "${u.name}"? Essa ação não pode ser desfeita.`)) return;
  try {
    await api(`/admin/users/${u._id}`, { method: 'DELETE' });
    toast('Usuário excluído.');
    closeModals();
    await load();
  } catch (e) {
    toast(e.message, 'error');
  }
}

$('btn-new-user').addEventListener('click', () => openUserModal(null));
$('btn-save-user').addEventListener('click', saveUser);

/* ── Auditoria ──────────────────────────────────────── */
const auditState = { page: 1, limit: 100, hasMore: false, loading: false, loaded: false };
const ACTION_LABEL = { create: 'Criou', update: 'Editou', delete: 'Excluiu', login: 'Entrou', logout: 'Saiu', 'login-falho': 'Login falho', negado: 'Negado', setup: 'Setup' };
const ACTION_CLASS = { create: 'ok', update: 'info', delete: 'danger', 'login-falho': 'warn', negado: 'warn' };

function fmtWhen(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
const fmtVal = (v) => (v == null ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const hasDetail = (e) => (e.changes && e.changes.length) || e.before || e.after || e.summary;

function detailHtml(e) {
  if (e.changes && e.changes.length) {
    return '<table class="audit-diff"><tbody>' + e.changes.map((c) =>
      `<tr><th>${esc(c.field)}</th><td class="from">${esc(fmtVal(c.from))}</td><td class="arrow">→</td><td class="to">${esc(fmtVal(c.to))}</td></tr>`).join('') + '</tbody></table>';
  }
  if (e.before) return `<div class="audit-blob"><span class="muted small">apagado:</span><pre>${esc(JSON.stringify(e.before, null, 2))}</pre></div>`;
  if (e.after) return `<div class="audit-blob"><span class="muted small">criado:</span><pre>${esc(JSON.stringify(e.after, null, 2))}</pre></div>`;
  return `<span class="muted">${esc(e.summary || '—')}</span>`;
}

function renderAudit(items, reset) {
  const body = $('audit-body');
  if (reset) body.innerHTML = '';
  $('audit-empty').classList.toggle('hidden', !(reset && !items.length));
  const rows = items.map((e, i) => {
    const rid = `ad-${auditState.page}-${i}`;
    const ent = e.entity ? `${esc(e.entity.type || '')}${e.entity.label ? ' · <strong>' + esc(e.entity.label) + '</strong>' : ''}` : '<span class="muted small">—</span>';
    const cli = e.client && e.client.name ? esc(e.client.name) : '<span class="muted small">—</span>';
    const act = `<span class="audit-badge ${ACTION_CLASS[e.action] || ''}">${ACTION_LABEL[e.action] || esc(e.action || '')}</span>`;
    const det = hasDetail(e) ? `<button type="button" class="btn-link audit-expand" data-target="${rid}">ver</button>` : '<span class="muted small">—</span>';
    return `<tr>
        <td class="nowrap">${fmtWhen(e.at)}</td>
        <td>${esc((e.actor && e.actor.email) || '—')}</td>
        <td>${act}</td>
        <td>${ent}</td>
        <td>${cli}</td>
        <td>${det}</td>
      </tr>
      <tr class="audit-detail hidden" id="${rid}"><td colspan="6">${detailHtml(e)}</td></tr>`;
  }).join('');
  body.insertAdjacentHTML('beforeend', rows);
  body.querySelectorAll('.audit-expand:not([data-wired])').forEach((b) => {
    b.setAttribute('data-wired', '1');
    b.addEventListener('click', () => {
      const row = document.getElementById(b.dataset.target);
      if (row) { const hidden = row.classList.toggle('hidden'); b.textContent = hidden ? 'ver' : 'ocultar'; }
    });
  });
}

function auditQuery() {
  const p = new URLSearchParams();
  const set = (k, id) => { const v = $(id).value.trim(); if (v) p.set(k, v); };
  set('client', 'af-client'); set('actor', 'af-actor'); set('action', 'af-action'); set('q', 'af-q');
  const from = $('af-from').value; if (from) p.set('from', from);
  const to = $('af-to').value; if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); p.set('to', d.toISOString()); }
  return p;
}

async function loadAudit(reset) {
  if (auditState.loading) return;
  auditState.loading = true;
  if (reset) auditState.page = 1;
  const p = auditQuery();
  p.set('limit', String(auditState.limit));
  p.set('page', String(auditState.page));
  try {
    const data = await api(`/admin/audit?${p.toString()}`);
    renderAudit(data.items || [], reset);
    const shown = (auditState.page - 1) * auditState.limit + (data.items || []).length;
    auditState.hasMore = shown < data.total;
    $('audit-more').classList.toggle('hidden', !auditState.hasMore);
    $('audit-count').textContent = data.total ? `${shown} de ${data.total} registros` : 'Nenhum registro';
  } catch (e) {
    toast(`Falha ao carregar auditoria: ${e.message}`, 'error');
  } finally {
    auditState.loading = false;
    auditState.loaded = true;
  }
}

function populateAuditFilters() {
  $('af-client').innerHTML = '<option value="">Todos os clientes</option>' +
    state.clients.map((c) => `<option value="${c._id}">${esc(c.name)}</option>`).join('');
  $('af-actor').innerHTML = '<option value="">Todas as pessoas</option>' +
    state.users.map((u) => `<option value="${u._id}">${esc(u.name || u.email)}</option>`).join('');
}

function showView(view) {
  document.querySelectorAll('#admin-tabs .seg').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('admin-view').classList.toggle('hidden', view !== 'users');
  $('audit-view').classList.toggle('hidden', view !== 'audit');
  $('btn-new-user').style.display = view === 'users' ? '' : 'none';
  if (view === 'audit' && !auditState.loaded) { populateAuditFilters(); loadAudit(true); }
}

document.querySelectorAll('#admin-tabs .seg').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('af-apply').addEventListener('click', () => loadAudit(true));
$('af-clear').addEventListener('click', () => {
  ['af-client', 'af-actor', 'af-action', 'af-from', 'af-to', 'af-q'].forEach((id) => { $(id).value = ''; });
  loadAudit(true);
});
$('audit-more').addEventListener('click', () => { auditState.page += 1; loadAudit(false); });
$('af-csv').addEventListener('click', () => { window.location.href = `/api/admin/audit.csv?${auditQuery().toString()}`; });

load().catch((e) => toast(`Falha ao carregar: ${e.message}`, 'error'));
