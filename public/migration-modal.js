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
 *   window.migrationActions.html(ev) / .wire(root, { clientId, onChanged })
 *
 * As AÇÕES de um evento (contratar, executar, desfazer, editar, excluir) também
 * moram aqui, e não na tela de Contratos: elas aparecem nos dois lugares — na
 * lista de MO/MES e no histórico da máquina, aberto pela Infraestrutura — e
 * duplicá-las garantiria que uma regra de transição ficasse diferente da outra.
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
  async function openMachineHistoryModal({ clientId, machineId, onChanged }) {
    let data;
    try {
      data = await api(`/clients/${clientId}/infra/machines/${machineId}/historico`);
    } catch (e) { toast(e.message, 'error'); return; }
    // Reabre no mesmo lugar depois de agir, e avisa a tela de trás — quem chamou
    // pode estar mostrando "1 MO/MES em aberto", que acabou de deixar de ser verdade.
    const apósAgir = async () => {
      if (onChanged) await onChanged();
      openMachineHistoryModal({ clientId, machineId, onChanged });
    };

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
        // As mesmas ações da lista de Contratos, aqui na linha do tempo.
        acoes: acoesHtml(ev),
      });
    }
    if (m.replacedAt) itens.push({ at: m.replacedAt, dot: 'done', head: 'Máquina substituída', meta: 'saiu do parque' });
    itens.sort((a, b) => new Date(a.at) - new Date(b.at));

    const scrtRows = (data.scrt || []).slice(-13).map((s) =>
      `<tr><td>${esc(s.periodLabel)}</td><td class="num mono">${fmt(s.msuConsumed)} MSU</td><td>${s.ignored ? '<span class="badge badge-neutral">ignorada</span>' : ''}</td></tr>`).join('');

    const chain = [];
    (data.chain.replaces || []).slice().reverse().forEach((c) => chain.push({ c, rel: 'antes' }));
    (data.chain.replacedBy || []).forEach((c) => chain.push({ c, rel: 'depois' }));

    const wrap = mount(`
      <div class="modal modal-compare" role="dialog" aria-modal="true">
        <div class="modal-forecast-top">
          <div>
            <h2>Histórico · ${esc(m.model || 'Máquina')}</h2>
            <p class="muted small">${esc(m.serial || 's/ serial')}${m.contractRef ? ` · contrato ${esc(m.contractRef.number)}` : ''} · ${data.lparCount} LPAR(s)</p>
          </div>
          <div class="modal-compare-head">
            <button class="btn btn-ghost btn-sm" type="button" id="hist-novo" data-requires-edit>Nova MO/MES</button>
            <button class="row-action" type="button" data-mig-close aria-label="Fechar">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
          </div>
        </div>
        <div class="modal-forecast-scroll">
          ${chain.length ? `<div class="card" style="margin-bottom:12px"><div class="card-header"><h2>Gerações</h2></div>
            <div class="lpar-strip">${chain.map((x) => `<span class="lpar-chip">${x.rel === 'antes' ? '←' : '→'} ${esc(x.c.model || '')} · ${esc(x.c.serial || '')}</span>`).join('')}</div></div>` : ''}
          <div class="tl">
            ${itens.length ? itens.map((i) => `
              <div class="tl-item">
                <span class="tl-dot ${i.dot}"></span>
                <div class="tl-head">${i.head}${i.acoes ? `<span class="tl-acoes">${i.acoes}</span>` : ''}</div>
                <div class="tl-meta">${dt(i.at)}${i.meta ? ' · ' + i.meta : ''}</div>
                ${i.specs ? specDiff(i.specs) : ''}
              </div>`).join('') : '<div class="empty-inline">Sem eventos registrados.</div>'}
          </div>
          ${scrtRows ? `<div class="card" style="margin-top:14px"><div class="card-header"><h2>Consumo no SCRT</h2>
            <p class="muted small">histórico preservado mesmo depois da máquina sair do parque</p></div>
            <div class="table-responsive"><table class="infra-table"><tbody>${scrtRows}</tbody></table></div></div>` : ''}
        </div>
      </div>`);

    wireAcoes(wrap, { clientId, onChanged: apósAgir });
    wrap.querySelector('#hist-novo').addEventListener('click', async () => {
      try {
        const [machines, contracts] = await Promise.all([
          api(`/clients/${clientId}/infra/machines`),
          api(`/clients/${clientId}/contracts`),
        ]);
        const maq = machines.find((x) => String(x._id) === String(machineId));
        closeAll();
        openMigrationModal({ clientId, machines, machine: maq, contracts, onSaved: apósAgir });
      } catch (e) { toast(e.message, 'error'); }
    });
    if (window.__authApplyViewOnly) window.__authApplyViewOnly();
  }


  /* ── Detalhes da máquina ────────────────────────────────
     Contrato, capacidade (MIPS/MSU do capacity marker LSPR) e as LPARs que o
     SCRT reporta para ela, além das cadastradas na infra. */
  async function openMachineDetailModal({ clientId, machineId, onChanged, onOpenLpars, onMigrate }) {
    let d;
    try { d = await api(`/clients/${clientId}/infra/machines/${machineId}/detalhes`); }
    catch (e) { toast(e.message, 'error'); return; }
    const m = d.machine;
    const lspr = m.lspr || null;
    const procTotal = (m.cps || 0) + (m.ziips || 0) + (m.iflsActive || 0) + (m.icfs || 0);
    const memTotal = (m.memoryTB || 0) + (m.memoryAddTB || 0);

    const kpi = (h, v, s) => `<div class="kpi-card"><h3>${esc(h)}</h3><div class="value">${v}</div>${s ? `<div class="subtitle">${esc(s)}</div>` : ''}</div>`;

    const lparRows = (d.scrtLpars || []).map((l) => `<tr>
      <td><strong>${esc(l.name)}</strong></td>
      <td class="small">${esc(l.os || '—')}</td>
      <td class="num mono">${fmt(l.msuConsumed)}</td>
      <td class="num mono">${fmt(l.peakHourMsu)}</td>
      <td class="num mono">${fmt(l.peak4hraMsu)}</td>
    </tr>`).join('');

    const wrap = mount(`
      <div class="modal modal-compare" role="dialog" aria-modal="true">
        <div class="modal-forecast-top">
          <div>
            <h2>${esc(m.model || 'Máquina')}</h2>
            <p class="muted small"><span class="mono">${esc(m.serial || 's/ serial')}</span>
              ${m.site ? ' · ' + esc(m.site.name) : ''}${m.status !== 'ativa' ? ` · <span class="badge badge-neutral">${esc(m.status)}</span>` : ''}</p>
          </div>
          <div class="modal-compare-head">
            <button class="btn btn-ghost btn-sm" type="button" id="md-contract" data-requires-edit>Vincular ao contrato</button>
            <button class="btn btn-ghost btn-sm" type="button" id="md-lpars">LPARs</button>
            <button class="btn btn-ghost btn-sm" type="button" id="md-migrate" data-requires-edit>Migrar</button>
            <button class="btn btn-ghost btn-sm" type="button" id="md-hist">Histórico</button>
            <button class="row-action" type="button" data-mig-close aria-label="Fechar">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
          </div>
        </div>
        <div class="modal-forecast-scroll">
          <div class="kpi-grid">
            ${kpi('Contrato', m.contractRef ? esc(m.contractRef.number) : '—', m.contractRef ? esc(m.contractRef.name || '') : 'sem contrato vinculado')}
            ${kpi('Total de MIPS', lspr ? fmt(lspr.mips) : '—', lspr ? `capacity marker ${esc(lspr.model)}` : 'sem LSPR definido')}
            ${kpi('Capacidade', lspr ? `${fmt(lspr.msu)} MSU` : '—', lspr ? esc(lspr.family) : '')}
            ${kpi('Processadores', fmt(procTotal), `${fmt(m.cps)} CP · ${fmt(m.ziips)} zIIP · ${fmt(m.iflsActive)} IFL${m.icfs ? ` · ${fmt(m.icfs)} CF` : ''}`)}
            ${kpi('Memória', `${num1(memTotal)} TB`, '')}
          </div>

          ${d.scrtMachine ? `<div class="card"><div class="card-header"><h2>No SCRT · ${esc(d.scrtPeriodLabel || '')}</h2>
            <p class="muted small">serial ${esc(d.scrtMachine.serialNumber || d.scrtMachine.identifier)} · type-model ${esc(d.scrtMachine.typeModel || '—')}</p></div>
            <div class="cap-delta">
              <span>Consumido: <b>${fmt(d.scrtMachine.msuConsumed)} MSU</b></span>
              <span>Capacidade nominal: <b>${fmt(d.scrtMachine.ratedCapacityMsus)} MSU</b></span>
              <span>Pico: <b>${fmt(d.scrtMachine.peakUtilizationMsus)} MSU</b></span>
              ${d.scrtMachine.tag ? `<span>Tag: <b>${esc(d.scrtMachine.tag)}</b></span>` : ''}
            </div></div>` : '<div class="empty-inline small">Esta máquina não aparece no último SCRT.</div>'}

          <div class="card" style="margin-top:14px"><div class="card-header"><h2>LPARs do SCRT (${(d.scrtLpars || []).length})</h2>
            <p class="muted small">vindas do relatório, sem precisar cadastrar à mão</p></div>
            ${lparRows ? `<div class="table-responsive"><table class="infra-table">
              <thead><tr><th>LPAR</th><th>SO</th><th class="num">MSU consumido</th><th class="num">Pico horário</th><th class="num">4HRA</th></tr></thead>
              <tbody>${lparRows}</tbody></table></div>`
              : '<div class="empty-inline small">O SCRT não trouxe LPARs para esta máquina (seção N7 ausente).</div>'}
          </div>

          ${(d.lpars || []).length ? `<div class="card" style="margin-top:14px"><div class="card-header"><h2>LPARs cadastradas (${d.lpars.length})</h2>
            <p class="muted small">registradas na infraestrutura</p></div>
            <div class="lpar-strip">${d.lpars.map((l) => `<span class="lpar-chip">${esc(l.name)}${l.ifls ? ` <span class="muted">${l.ifls} IFL</span>` : ''}</span>`).join('')}</div>
          </div>` : ''}

          ${(d.events || []).length ? `<div class="card" style="margin-top:14px"><div class="card-header"><h2>MO / MES (${d.events.length})</h2></div>
            <div class="table-responsive"><table class="infra-table"><tbody>${d.events.map((e) => `<tr>
              <td>${kindBadge(e.kind)}</td><td>${esc(e.title || '—')}</td>
              <td>${statusBadge(e.status)}</td>
              <td class="small">${dt(e.executedAt || e.plannedDate)}</td>
              <td class="small">${e.contract ? esc(e.contract.number) : '—'}</td>
              <td class="infra-actions">${acoesHtml(e)}</td>
            </tr>`).join('')}</tbody></table></div></div>` : ''}
        </div>
      </div>`);

    wireAcoes(wrap, { clientId, onChanged: async () => { if (onChanged) await onChanged(); openMachineDetailModal({ clientId, machineId, onChanged, onOpenLpars, onMigrate }); } });
    wrap.querySelector('#md-hist').addEventListener('click', () =>
      openMachineHistoryModal({ clientId, machineId, onChanged }));
    const bl = wrap.querySelector('#md-lpars');
    if (onOpenLpars) bl.addEventListener('click', () => { wrap.remove(); onOpenLpars(machineId); });
    else bl.style.display = 'none';
    const bm = wrap.querySelector('#md-migrate');
    if (onMigrate) bm.addEventListener('click', () => { wrap.remove(); onMigrate(machineId); });
    else bm.style.display = 'none';
    wrap.querySelector('#md-contract').addEventListener('click', () =>
      openMachineContractModal({ clientId, machine: m, onChanged: async () => { wrap.remove(); if (onChanged) await onChanged(); } }));
    if (window.__authApplyViewOnly) window.__authApplyViewOnly();
  }

  /* Seletor de contrato para uma máquina. */
  async function openMachineContractModal({ clientId, machine, onChanged }) {
    let contratos;
    try { contratos = await api(`/clients/${clientId}/contracts`); }
    catch (e) { toast(e.message, 'error'); return; }
    const principais = contratos.filter((c) => !c.parentContract);
    if (!principais.length) { toast('Nenhum contrato cadastrado. Cadastre em Contratos.', 'error'); return; }
    const atual = machine.contract ? String(machine.contract) : '';

    const wrap = mount(`
      <div class="modal modal-wide" role="dialog" aria-modal="true">
        <h2>Vincular ao contrato</h2>
        <p class="muted small">${esc(machine.model || 'Máquina')} · <span class="mono">${esc(machine.serial || '')}</span></p>
        <div class="tl-ctlist">
          ${principais.map((c) => `<button type="button" class="ct-opt ${String(c._id) === atual ? 'atual' : ''}" data-ct="${c._id}">
            <strong>${esc(c.number)}</strong>${c.name ? ` <span class="muted">${esc(c.name)}</span>` : ''}
            <div class="muted small">${esc(c.vendor || '')} · ${dt(c.startDate)} → ${dt(c.endDate)}${String(c._id) === atual ? ' · vinculado hoje' : ''}</div>
          </button>`).join('')}
        </div>
        <p class="form-error hidden" id="mc-err"></p>
        <div class="modal-actions">
          ${atual ? '<button class="btn btn-danger-ghost" id="mc-unlink" style="margin-right:auto">Desvincular</button>' : ''}
          <button class="btn btn-ghost" type="button" data-mig-close>Fechar</button>
        </div>
      </div>`);

    const erro = (msg) => { const el = wrap.querySelector('#mc-err'); el.textContent = msg; el.classList.remove('hidden'); };
    wrap.querySelectorAll('[data-ct]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await jsonPost(`/clients/${clientId}/contracts/${b.dataset.ct}/machines`, { machineIds: [String(machine._id)] });
        wrap.remove(); toast('Máquina vinculada ao contrato.');
        if (onChanged) await onChanged();
      } catch (e) { erro(e.message); }
    }));
    const un = wrap.querySelector('#mc-unlink');
    if (un) un.addEventListener('click', async () => {
      try {
        await api(`/clients/${clientId}/contracts/${atual}/machines/${machine._id}`, { method: 'DELETE' });
        wrap.remove(); toast('Máquina desvinculada.');
        if (onChanged) await onChanged();
      } catch (e) { erro(e.message); }
    });
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

  /* ── Ações de um evento MO/MES ──────────────────────────
     As mesmas na lista de Contratos e no histórico da máquina que a Infra abre.
     Que ação existe depende do STATUS, e essa regra vive só aqui — no servidor
     ela é reforçada de novo (executar exige 'contratado', excluir só aceita
     'proposta'/'cancelada'), então o botão a menos é conveniência, não a trava. */

  const ICONES = {
    contratar: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    executar: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4.5 3.5v9l8-4.5-8-4.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    desfazer: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 1 1 1.6 3.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3 4.5V8h3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    editar: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5 13.5 4.5 5.5 12.5 2.5 13.5 3.5 10.5 11.5 2.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    excluir: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5 5 13h6l.5-8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    historico: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2 1.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  };

  /** Que ações o evento aceita no estado em que está. */
  function acoesDe(ev) {
    const out = [];
    if (ev.status === 'proposta') out.push({ act: 'contratar', title: 'Marcar como contratado' });
    if (ev.status === 'contratado') out.push({ act: 'executar', title: 'Executar' });
    if (ev.status === 'executado') out.push({ act: 'desfazer', title: 'Desfazer execução' });
    if (ev.status !== 'executado') out.push({ act: 'editar', title: 'Editar' });
    if (['proposta', 'cancelada'].includes(ev.status)) out.push({ act: 'excluir', title: 'Excluir', danger: true });
    return out;
  }

  /**
   * Botões de ação do evento. `historico` inclui o atalho para a linha do tempo
   * da máquina — útil na lista de Contratos, redundante dentro dela própria.
   */
  function acoesHtml(ev, { historico = false } = {}) {
    const maquina = String((ev.fromMachine && (ev.fromMachine._id || ev.fromMachine)) || '');
    const extra = historico && maquina
      ? [{ act: 'historico', title: 'Histórico da máquina', semEdicao: true }]
      : [];
    return [...extra, ...acoesDe(ev)].map((a) =>
      `<button class="row-action${a.danger ? ' danger' : ''}" type="button"`
      + `${a.semEdicao ? '' : ' data-requires-edit'}`
      + ` data-mig-act="${a.act}" data-mig-ev="${esc(ev._id)}" data-mig-maq="${esc(maquina)}"`
      + ` title="${esc(a.title)}" aria-label="${esc(a.title)}">${ICONES[a.act]}</button>`).join('');
  }

  /**
   * Liga as ações dentro de `root`. Um listener só, delegado — o HTML pode ser
   * redesenhado à vontade sem religar nada.
   *
   * Máquinas e contratos são buscados SOB DEMANDA: assim a Infra não precisa
   * carregar a lista de contratos só para o caso de alguém clicar em "editar".
   */
  function wireAcoes(root, { clientId, onChanged }) {
    if (!root || root.dataset.migWired === '1') return;
    root.dataset.migWired = '1';
    const recarrega = async () => { if (onChanged) await onChanged(); };

    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-mig-act]');
      if (!b || !root.contains(b)) return;
      e.preventDefault();
      e.stopPropagation();
      const { migAct: act, migEv: id, migMaq: maq } = b.dataset;

      try {
        if (act === 'historico') { openMachineHistoryModal({ clientId, machineId: maq }); return; }

        if (act === 'excluir') {
          if (!confirm('Excluir esta proposta? O histórico da máquina perde o registro dela.')) return;
          await api(`/clients/${clientId}/migrations/${id}`, { method: 'DELETE' });
          toast('Proposta excluída.');
          closeAll();
          await recarrega();
          return;
        }

        if (act === 'desfazer') {
          if (!confirm('Desfazer a execução e restaurar a configuração anterior da máquina?')) return;
          await jsonPost(`/clients/${clientId}/migrations/${id}/desfazer`, {});
          toast('Execução desfeita.');
          closeAll();
          await recarrega();
          return;
        }

        const ev = await api(`/clients/${clientId}/migrations/${id}`);

        if (act === 'contratar') {
          const contratos = await api(`/clients/${clientId}/contracts`);
          let contractId = ev.contract ? (ev.contract._id || ev.contract) : '';
          if (!contractId) {
            if (!contratos.length) { toast('Cadastre o contrato assinado antes.', 'error'); return; }
            const opcoes = contratos.map((c, i) => `${i + 1}) ${c.number}${c.name ? ' · ' + c.name : ''}`).join('\n');
            const escolha = prompt(`Qual contrato assinado cobre este ${ev.kind}?\n\n${opcoes}\n\nDigite o número:`);
            const idx = Number(escolha) - 1;
            if (!(idx >= 0 && idx < contratos.length)) return;
            contractId = contratos[idx]._id;
          }
          await jsonPost(`/clients/${clientId}/migrations/${id}/status`, { status: 'contratado', contract: contractId });
          toast('Marcado como contratado.');
          closeAll();
          await recarrega();
          return;
        }

        if (act === 'executar') {
          const sites = await api(`/clients/${clientId}/infra/sites`);
          closeAll();
          openMigrationExecModal({ clientId, event: ev, sites, onDone: recarrega });
          return;
        }

        if (act === 'editar') {
          const [machines, contracts] = await Promise.all([
            api(`/clients/${clientId}/infra/machines`),
            api(`/clients/${clientId}/contracts`),
          ]);
          closeAll();
          openMigrationModal({ clientId, machines, contracts, event: ev, onSaved: recarrega });
          return;
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  window.openMigrationModal = openMigrationModal;
  window.openMigrationExecModal = openMigrationExecModal;
  window.openMachineHistoryModal = openMachineHistoryModal;
  window.openMachineDetailModal = openMachineDetailModal;
  window.openMachineContractModal = openMachineContractModal;
  window.migrationBadges = { statusBadge, kindBadge, STATUS };
  window.migrationActions = { html: acoesHtml, wire: wireAcoes, disponiveis: acoesDe };
  window.closeMigrationModals = closeAll;
})();
