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

load().catch((e) => toast(`Falha ao carregar: ${e.message}`, 'error'));
