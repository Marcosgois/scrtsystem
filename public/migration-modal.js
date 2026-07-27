'use strict';

/*
 * MO / MES — modais compartilhados pela Infraestrutura e pelo módulo de Contratos.
 * Monta o próprio DOM (não depende de markup na página), no mesmo estilo do
 * scrt-files.js. Sem isso o formulário antes→depois, o seletor de LSPR, o cálculo
 * de delta e a linha do tempo viveriam duplicados nas duas telas.
 *
 * Uso:
 *   window.openMigrationModal({ clientId, machines, machine, contracts, event, onSaved })
 *   window.openMigrationExecModal({ clientId, event, sites, onDone })
 *   window.openMachineHistoryModal({ clientId, machineId })
 */
(function () {
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

  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, opts);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `Erro ${res.status}`);
    return body;
  }
  const jsonPost = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const jsonPut = (p, b) => api(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

  function toast(msg, kind = 'success') {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 4600);
  }

  const STATUS = {
    proposta: { label: 'Proposta', color: '#6f6f6f' },
    contratado: { label: 'Contratado', color: '#0f62fe' },
    executado: { label: 'Executado', color: '#198038' },
    cancelada: { label: 'Cancelada', color: '#da1e28' },
  };
  const statusBadge = (s) => {
    const it = STATUS[s] || STATUS.proposta;
    return `<span class="badge" style="background:${it.color}1a;color:${it.color}">${it.label}</span>`;
  };
  const kindBadge = (k) => `<span class="badge" style="background:${k === 'MO' ? '#6929c41a;color:#6929c4' : '#0f62fe1a;color:#0f62fe'}">${k}</span>`;

  // Campos de configuração comparados no antes→depois.
  const SPECS = [
    { k: 'cps', label: 'CPs' },
    { k: 'ziips', label: 'zIIPs' },
    { k: 'iflsActive', label: 'IFLs' },
    { k: 'icfs', label: 'CF (ICFs)' },
    { k: 'memoryTB', label: 'Memória (TB)', dec: true },
    { k: 'msu', label: 'MSU (LSPR)', ro: true },
    { k: 'mips', label: 'MIPS (LSPR)', ro: true },
  ];

  let host;
  function ensureHost() {
    if (host) return host;
    host = document.createElement('div');
    document.body.appendChild(host);
    return host;
  }
  function closeAll() {
    if (host) host.querySelectorAll('.modal-backdrop').forEach((m) => m.remove());
  }
  function mount(html) {
    ensureHost();
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = html;
    host.appendChild(wrap);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-mig-close]')) wrap.remove();
    });
    return wrap;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && host) {
      const abertos = host.querySelectorAll('.modal-backdrop');
      if (abertos.length) abertos[abertos.length - 1].remove();
    }
  });

  /* ── Proposta de MO/MES ─────────────────────────────────── */
  function openMigrationModal({ clientId, machines = [], machine = null, contracts = [], event = null, onSaved }) {
    const editando = Boolean(event);
    let kind = event ? event.kind : 'MES';
    let fromId = event ? String(event.fromMachine && (event.fromMachine._id || event.fromMachine)) : (machine ? String(machine._id) : (machines[0] && String(machines[0]._id)) || '');
    const after = Object.assign({}, event ? event.after : {});

    const wrap = mount(`
      <div class="modal modal-compare" role="dialog" aria-modal="true" aria-labelledby="mig-title">
        <div class="modal-forecast-top">
          <div>
            <h2 id="mig-title">${editando ? 'Editar proposta' : 'Migrar máquina'}</h2>
            <p class="muted small">MO troca a máquina · MES faz upgrade na mesma</p>
          </div>
          <button class="row-action" type="button" data-mig-close aria-label="Fechar">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-forecast-scroll">
          <div class="role-grid" id="mig-kind"></div>
          <div class="machine-grid" style="margin-top:14px">
            <label class="field"><span>Máquina de origem</span><select id="mig-from"></select></label>
            <label class="field"><span>Título</span><input type="text" id="mig-title-in" maxlength="120" placeholder="Ex.: Troca z16 → z17"></label>
            <label class="field"><span>Contrato</span><select id="mig-contract"></select></label>
            <label class="field"><span>Data prevista</span><input type="date" id="mig-planned"></label>
            <label class="field"><span>Valor</span><input type="number" id="mig-value" min="0" step="any"></label>
            <label class="field"><span>Referência da proposta</span><input type="text" id="mig-ref" maxlength="60"></label>
          </div>
          <div id="mig-compare"></div>
          <label class="field"><span>Observações</span><input type="text" id="mig-notes" maxlength="240"></label>
          <p class="form-error hidden" id="mig-error"></p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-mig-close>Cancelar</button>
          <button class="btn btn-primary" type="button" id="mig-save">${editando ? 'Salvar' : 'Criar proposta'}</button>
        </div>
      </div>`);

    const $ = (id) => wrap.querySelector(`#${id}`);
    const fromMachine = () => machines.find((m) => String(m._id) === String(fromId)) || machine || null;

    function renderKind() {
      $('mig-kind').innerHTML = [
        { k: 'MES', t: 'MES', d: 'Upgrade na mesma máquina', c: '#0f62fe' },
        { k: 'MO', t: 'MO', d: 'Troca de máquina', c: '#6929c4' },
      ].map((o) => `<button type="button" class="role-opt role-opt-2 ${kind === o.k ? 'active' : ''}" data-k="${o.k}" style="--rc:${o.c}">
          <strong>${o.t}</strong><span>${o.d}</span></button>`).join('');
      $('mig-kind').querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
        if (editando) return; // trocar o tipo depois de criado muda a semântica; melhor recriar
        kind = b.dataset.k; renderKind(); renderCompare();
      }));
    }

    function renderCompare() {
      const m = fromMachine();
      const base = editando ? event.before : (m || {});
      const linhas = SPECS.map((s) => {
        const antes = s.k === 'msu' || s.k === 'mips'
          ? (editando ? base[s.k] : (m && m.lspr ? m.lspr[s.k] : null))
          : base[s.k];
        const depois = after[s.k];
        const d = (Number(depois) || 0) - (Number(antes) || 0);
        const cls = d > 0 ? 'cap-up' : d < 0 ? 'cap-down' : '';
        const sinal = d > 0 ? '+' : '';
        const val = s.dec ? num1(antes) : fmt(antes);
        const input = s.ro
          ? `<span class="mono small">${s.dec ? num1(depois) : fmt(depois)}</span>`
          : `<input type="number" min="0" step="any" data-spec="${s.k}" value="${depois == null ? '' : depois}">`;
        return `<tr>
          <td>${s.label}</td>
          <td class="num mono">${val}</td>
          <td class="num">${input}</td>
          <td class="num ${cls}">${d ? `${sinal}${s.dec ? num1(d) : fmt(d)}` : '—'}</td>
        </tr>`;
      }).join('');

      $('mig-compare').innerHTML = `
        <div class="card" style="margin-top:6px">
          <div class="card-header"><h2>Antes → Depois</h2>
            <p class="muted small">${esc((fromMachine() || {}).model || '')} · ${esc((fromMachine() || {}).serial || '')}</p></div>
          <div class="machine-grid" style="padding:0 0 10px">
            <label class="field"><span>Modelo (depois)</span><input type="text" id="mig-model" value="${esc(after.model || '')}" placeholder="Ex.: IBM z17"></label>
            <label class="field"><span>LSPR (depois)</span>
              <input type="text" id="mig-lspr" list="mig-lspr-list" value="${esc(after.lsprModel || '')}" placeholder="ex.: 9175-760" autocomplete="off">
              <datalist id="mig-lspr-list"></datalist></label>
            ${kind === 'MO' ? `<label class="field"><span>Serial da máquina nova *</span><input type="text" id="mig-serial" value="${esc(after.serial || '')}" placeholder="obrigatório no MO"></label>` : ''}
          </div>
          <div class="table-responsive">
            <table class="infra-table">
              <thead><tr><th>Recurso</th><th class="num">Antes</th><th class="num">Depois</th><th class="num">Δ</th></tr></thead>
              <tbody>${linhas}</tbody>
            </table>
          </div>
        </div>`;

      wrap.querySelectorAll('[data-spec]').forEach((i) => i.addEventListener('input', () => {
        after[i.dataset.spec] = i.value === '' ? 0 : Number(i.value);
        const only = i.dataset.spec;
        // Redesenha só a coluna Δ para não perder o foco do campo.
        const tr = i.closest('tr');
        const spec = SPECS.find((s) => s.k === only);
        const m2 = fromMachine();
        const antes = (editando ? event.before : (m2 || {}))[only];
        const d = (Number(after[only]) || 0) - (Number(antes) || 0);
        const cell = tr.lastElementChild;
        cell.className = `num ${d > 0 ? 'cap-up' : d < 0 ? 'cap-down' : ''}`;
        cell.textContent = d ? `${d > 0 ? '+' : ''}${spec.dec ? num1(d) : fmt(d)}` : '—';
      }));
      $('mig-model').addEventListener('input', (e) => { after.model = e.target.value; });
      if ($('mig-serial')) $('mig-serial').addEventListener('input', (e) => { after.serial = e.target.value; });
      wireLspr();
    }

    let lsprTimer = null;
    function wireLspr() {
      const input = $('mig-lspr');
      if (!input) return;
      input.addEventListener('input', () => {
        after.lsprModel = input.value.trim();
        clearTimeout(lsprTimer);
        if (input.value.trim().length < 2) return;
        lsprTimer = setTimeout(async () => {
          try {
            const rows = await api(`/lspr?q=${encodeURIComponent(input.value.trim())}&limit=25`);
            wrap.querySelector('#mig-lspr-list').innerHTML = rows
              .map((r) => `<option value="${esc(r.model)}">${esc(r.family)} · ${fmt(r.msu)} MSU</option>`).join('');
            const exato = rows.find((r) => r.model === input.value.trim());
            if (exato) { after.msu = exato.msu; after.mips = exato.mips; renderCompare(); }
          } catch (e) { /* silencioso */ }
        }, 220);
      });
    }

    // Selects
    $('mig-from').innerHTML = machines.length
      ? machines.filter((m) => m.status !== 'substituida').map((m) => `<option value="${m._id}" ${String(m._id) === String(fromId) ? 'selected' : ''}>${esc(m.model || 'Máquina')} · ${esc(m.serial || 's/ serial')}</option>`).join('')
      : `<option value="${fromId}">${esc((machine || {}).model || '')} · ${esc((machine || {}).serial || '')}</option>`;
    $('mig-from').disabled = editando;
    $('mig-from').addEventListener('change', (e) => { fromId = e.target.value; renderCompare(); });
    $('mig-contract').innerHTML = ['<option value="">(sem contrato ainda)</option>']
      .concat(contracts.map((c) => `<option value="${c._id}" ${event && String(event.contract && (event.contract._id || event.contract)) === String(c._id) ? 'selected' : ''}>${esc(c.number)}${c.name ? ' · ' + esc(c.name) : ''}</option>`)).join('');
    if (event) {
      $('mig-title-in').value = event.title || '';
      $('mig-notes').value = event.notes || '';
      $('mig-ref').value = event.proposalRef || '';
      $('mig-value').value = event.value == null ? '' : event.value;
      if (event.plannedDate) $('mig-planned').value = String(event.plannedDate).slice(0, 10);
    }
    renderKind();
    renderCompare();

    $('mig-save').addEventListener('click', async () => {
      const err = $('mig-error');
      err.classList.add('hidden');
      const payload = {
        kind, fromMachine: fromId,
        title: $('mig-title-in').value.trim(),
        notes: $('mig-notes').value.trim(),
        proposalRef: $('mig-ref').value.trim(),
        contract: $('mig-contract').value || null,
        plannedDate: $('mig-planned').value || null,
        value: $('mig-value').value === '' ? null : Number($('mig-value').value),
        after: Object.assign({}, after, {
          model: $('mig-model').value.trim(),
          lsprModel: $('mig-lspr').value.trim(),
          serial: $('mig-serial') ? $('mig-serial').value.trim() : '',
        }),
      };
      try {
        if (editando) await jsonPut(`/clients/${clientId}/migrations/${event._id}`, payload);
        else await jsonPost(`/clients/${clientId}/migrations`, payload);
        wrap.remove();
        toast(editando ? 'Proposta atualizada.' : 'Proposta criada.');
        if (onSaved) onSaved();
      } catch (e) {
        err.textContent = e.message; err.classList.remove('hidden');
      }
    });
  }

  /* ── Execução ───────────────────────────────────────────── */
  function openMigrationExecModal({ clientId, event, sites = [], onDone }) {
    const isMO = event.kind === 'MO';
    const linhas = SPECS.map((s) => {
      const a = event.before[s.k]; const b = event.after[s.k];
      const d = (Number(b) || 0) - (Number(a) || 0);
      return `<tr><td>${s.label}</td><td class="num mono">${s.dec ? num1(a) : fmt(a)}</td>
        <td class="num mono">${s.dec ? num1(b) : fmt(b)}</td>
        <td class="num ${d > 0 ? 'cap-up' : d < 0 ? 'cap-down' : ''}">${d ? `${d > 0 ? '+' : ''}${s.dec ? num1(d) : fmt(d)}` : '—'}</td></tr>`;
    }).join('');

    const wrap = mount(`
      <div class="modal modal-wide" role="dialog" aria-modal="true">
        <h2>Executar ${event.kind}</h2>
        <p class="muted small">${esc(event.title || '')}</p>
        <div class="banner-warning">
          A partir daqui a máquina é alterada de verdade.
          ${isMO ? 'A máquina antiga fica marcada como <strong>substituída</strong> (não é apagada) e a nova entra no lugar.' : 'A configuração da máquina é atualizada.'}
          Dá para desfazer depois.
        </div>
        <div class="table-responsive" style="margin:12px 0">
          <table class="infra-table">
            <thead><tr><th>Recurso</th><th class="num">Antes</th><th class="num">Depois</th><th class="num">Δ</th></tr></thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>
        <div class="machine-grid">
          <label class="field"><span>Data da execução</span><input type="date" id="exec-date"></label>
          ${isMO ? `<label class="field"><span>Site da máquina nova</span><select id="exec-site">
            <option value="">(herda o site da antiga)</option>
            ${sites.map((s) => `<option value="${s._id}">${esc(s.name)}</option>`).join('')}
          </select></label>` : ''}
        </div>
        ${isMO ? '<label class="toggle"><input type="checkbox" id="exec-clone"> Copiar as LPARs para a máquina nova (as originais continuam na antiga)</label>' : ''}
        <p class="form-error hidden" id="exec-error"></p>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-mig-close>Cancelar</button>
          <button class="btn btn-primary" type="button" id="exec-go">Executar</button>
        </div>
      </div>`);

    wrap.querySelector('#exec-date').value = new Date().toISOString().slice(0, 10);
    wrap.querySelector('#exec-go').addEventListener('click', async () => {
      const err = wrap.querySelector('#exec-error');
      err.classList.add('hidden');
      try {
        await jsonPost(`/clients/${clientId}/migrations/${event._id}/executar`, {
          executedAt: wrap.querySelector('#exec-date').value || null,
          site: isMO && wrap.querySelector('#exec-site') ? wrap.querySelector('#exec-site').value || null : null,
          migrarLpars: isMO && wrap.querySelector('#exec-clone') ? wrap.querySelector('#exec-clone').checked : false,
        });
        wrap.remove();
        toast(`${event.kind} executado.`);
        if (onDone) onDone();
      } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    });
  }

  /* ── Histórico da máquina ───────────────────────────────── */
  async function openMachineHistoryModal({ clientId, machineId }) {
    let data;
    try {
      data = await api(`/clients/${clientId}/infra/machines/${machineId}/historico`);
    } catch (e) { toast(e.message, 'error'); return; }

    const m = data.machine;
    const itens = [];
    if (m.createdAt) {
      itens.push({ at: m.installedAt || m.createdAt, dot: 'plan', head: 'Máquina cadastrada', meta: `${esc(m.model || '')} · ${esc(m.serial || '')}` });
    }
    for (const ev of data.events) {
      const alvo = String(ev.fromMachine && ev.fromMachine._id) === String(machineId) ? 'origem' : 'destino';
      const quando = ev.executedAt || ev.plannedDate || ev.createdAt;
      const partes = [];
      if (ev.contract) partes.push(`contrato ${esc(ev.contract.number)}`);
      if (ev.value != null) partes.push(Number(ev.value).toLocaleString('pt-BR', { style: 'currency', currency: ev.currency || 'BRL' }));
      partes.push(alvo === 'origem' ? 'esta máquina' : 'entrou no lugar');
      itens.push({
        at: quando,
        dot: ev.status === 'executado' ? 'done' : 'plan',
        head: `${kindBadge(ev.kind)} ${esc(ev.title || (ev.kind === 'MO' ? 'Troca de máquina' : 'Upgrade'))} ${statusBadge(ev.status)}`,
        meta: partes.join(' · '),
        specs: ev.status === 'executado' ? ev : null,
      });
    }
    if (m.replacedAt) itens.push({ at: m.replacedAt, dot: 'done', head: 'Máquina substituída', meta: 'saiu do parque' });
    itens.sort((a, b) => new Date(a.at) - new Date(b.at));

    const scrtRows = (data.scrt || []).slice(-13).map((s) =>
      `<tr><td>${esc(s.periodLabel)}</td><td class="num mono">${fmt(s.msuConsumed)} MSU</td><td>${s.ignored ? '<span class="badge badge-neutral">ignorada</span>' : ''}</td></tr>`).join('');

    const chain = [];
    (data.chain.replaces || []).slice().reverse().forEach((c) => chain.push({ c, rel: 'antes' }));
    (data.chain.replacedBy || []).forEach((c) => chain.push({ c, rel: 'depois' }));

    mount(`
      <div class="modal modal-compare" role="dialog" aria-modal="true">
        <div class="modal-forecast-top">
          <div>
            <h2>Histórico · ${esc(m.model || 'Máquina')}</h2>
            <p class="muted small">${esc(m.serial || 's/ serial')}${m.contractRef ? ` · contrato ${esc(m.contractRef.number)}` : ''} · ${data.lparCount} LPAR(s)</p>
          </div>
          <button class="row-action" type="button" data-mig-close aria-label="Fechar">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-forecast-scroll">
          ${chain.length ? `<div class="card" style="margin-bottom:12px"><div class="card-header"><h2>Gerações</h2></div>
            <div class="lpar-strip">${chain.map((x) => `<span class="lpar-chip">${x.rel === 'antes' ? '←' : '→'} ${esc(x.c.model || '')} · ${esc(x.c.serial || '')}</span>`).join('')}</div></div>` : ''}
          <div class="tl">
            ${itens.length ? itens.map((i) => `
              <div class="tl-item">
                <span class="tl-dot ${i.dot}"></span>
                <div class="tl-head">${i.head}</div>
                <div class="tl-meta">${dt(i.at)}${i.meta ? ' · ' + i.meta : ''}</div>
                ${i.specs ? specDiff(i.specs) : ''}
              </div>`).join('') : '<div class="empty-inline">Sem eventos registrados.</div>'}
          </div>
          ${scrtRows ? `<div class="card" style="margin-top:14px"><div class="card-header"><h2>Consumo no SCRT</h2>
            <p class="muted small">histórico preservado mesmo depois da máquina sair do parque</p></div>
            <div class="table-responsive"><table class="infra-table"><tbody>${scrtRows}</tbody></table></div></div>` : ''}
        </div>
      </div>`);
  }

  function specDiff(ev) {
    const cells = SPECS.map((s) => {
      const a = ev.before[s.k]; const b = ev.after[s.k];
      const d = (Number(b) || 0) - (Number(a) || 0);
      if (!d) return '';
      return `<span class="${d > 0 ? 'cap-up' : 'cap-down'}">${s.label} ${d > 0 ? '+' : ''}${s.dec ? num1(d) : fmt(d)}</span>`;
    }).filter(Boolean);
    return cells.length ? `<div class="cap-delta">${cells.join('')}</div>` : '';
  }

  window.openMigrationModal = openMigrationModal;
  window.openMigrationExecModal = openMigrationExecModal;
  window.openMachineHistoryModal = openMachineHistoryModal;
  window.migrationBadges = { statusBadge, kindBadge, STATUS };
  window.closeMigrationModals = closeAll;
})();
