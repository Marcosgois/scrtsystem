'use strict';

/* Módulo MLC (Monthly License Charge): contrato por cliente + consumo do SCRT. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = new Intl.NumberFormat('pt-BR');
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtInt = (n) => (n == null ? '–' : nf.format(Math.round(n)));
const fmtBRL = (n) => (n == null ? '–' : brl.format(n));
const fmtSigned = (n) => (n == null ? '–' : (n >= 0 ? '+' : '') + nf.format(Math.round(n)));

const state = {
  clients: [],
  clientId: localStorage.getItem('tfp.clientId') || null,
  data: null, // resposta do GET /mlc
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

function showView(which) {
  ['empty-clients', 'empty-contract', 'contract-view'].forEach((id) =>
    $(id).classList.toggle('hidden', id !== which));
}

/* ------------------------------------------------------------------ *
 *  Carregamento
 * ------------------------------------------------------------------ */

async function loadClients() {
  state.clients = await api('/clients');
  const select = $('client-select');
  select.innerHTML = state.clients.map((c) => `<option value="${c._id}">${esc(c.name)}</option>`).join('');

  if (!state.clients.length) {
    state.clientId = null;
    showView('empty-clients');
    $('btn-edit-contract').disabled = true;
    return;
  }
  const exists = state.clients.some((c) => c._id === state.clientId);
  if (!exists) state.clientId = state.clients[0]._id;
  select.value = state.clientId;
  localStorage.setItem('tfp.clientId', state.clientId);
  await loadMlc();
}

async function loadMlc() {
  $('btn-edit-contract').disabled = false;
  state.data = await api(`/clients/${state.clientId}/mlc`);
  render();
}

/* ------------------------------------------------------------------ *
 *  Render da visão
 * ------------------------------------------------------------------ */

function render() {
  const d = state.data;
  const clientName = d.client.name;

  if (!d.contract || !d.view || !d.view.years.length) {
    $('empty-contract-name').textContent = clientName;
    showView('empty-contract');
    return;
  }

  showView('contract-view');
  $('mlc-client-name').textContent = clientName;
  const scrt = d.scrt || {};
  const cobertura = scrt.monthCount
    ? `SCRT no sistema: ${scrt.monthCount} mês(es), de ${labelKey(scrt.firstPeriodKey)} a ${labelKey(scrt.lastPeriodKey)}`
    : 'Nenhum SCRT carregado ainda para este cliente';
  $('mlc-subtitle').textContent = `Monthly License Charge · ${cobertura}`;

  renderKpis(d.view);
  renderYears(d.view);
}

function labelKey(k) {
  if (!k) return '–';
  const M = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const [y, m] = k.split('-').map(Number);
  return `${M[m - 1]}/${y}`;
}

// KPIs do ano vigente = último ano que tem algum mês com SCRT.
function renderKpis(view) {
  const comDados = view.years.filter((y) => y.totals.monthsWithScrt > 0);
  const ano = comDados.length ? comDados[comDados.length - 1] : view.years[0];
  const t = ano.totals;
  const media = t.monthsWithScrt ? t.withCbaRs / t.monthsWithScrt : null;
  const cards = [
    { h: 'Ano vigente', v: ano.label, s: `${labelKey(ano.firstPeriodKey)} – ${labelKey(ano.lastPeriodKey)}` },
    { h: 'Meses faturados', v: `${t.monthsWithScrt}/12`, s: t.monthsWithScrt < 12 ? 'aguardando SCRT dos demais' : 'ano completo' },
    { h: 'Faturado com CBA', v: fmtBRL(t.withCbaRs), s: `${ano.label} · já com desconto CBA`, accent: true },
    { h: 'Média mensal (CBA)', v: fmtBRL(media), s: 'por mês faturado' },
  ];
  $('mlc-kpis').innerHTML = cards.map((c) =>
    `<div class="kpi-card">
      <h3>${esc(c.h)}</h3>
      <div class="value${c.accent ? ' value-accent' : ''}">${esc(c.v)}</div>
      <div class="subtitle">${esc(c.s)}</div>
    </div>`).join('');
}

function renderYears(view) {
  $('mlc-years').innerHTML = view.years.map(renderYearCard).join('');
}

function renderYearCard(ano) {
  const t = ano.totals;
  const encargosDesc = ano.encargos.length
    ? ano.encargos.map((e) => `${esc(e.nome)} ${fmtBRL(e.valorMensal)}`).join(' · ')
    : 'sem encargos fixos';
  const params = [
    `Baseline ${fmtInt(ano.baselineAnnualMsu)} MSU/ano (${fmtInt(ano.baselineMensalMsu)}/mês)`,
    `R$/MSU ${nf.format(ano.valorPorMsu)}`,
    `Cresc./MSU ${nf.format(ano.encargoCrescimentoPorMsu)}`,
    `CBA ${nf.format(ano.cbaPct * 100)}%`,
  ].join(' · ');

  const linhas = ano.months.map((m) => {
    if (m.source !== 'scrt') {
      return `<tr class="mlc-row-pending">
        <td>${esc(m.label)}</td>
        <td class="num" colspan="7">aguardando SCRT</td>
      </tr>`;
    }
    const gCls = m.growth >= 0 ? 'up' : 'down';
    return `<tr>
      <td>${esc(m.label)}</td>
      <td class="num">${fmtInt(m.consumedMsu)} <span class="badge badge-scrt mlc-scrt-link" role="button" tabindex="0" data-period="${esc(m.periodKey)}" data-label="${esc(m.label)}" title="Ver arquivos SCRT de ${esc(m.label)}">SCRT</span></td>
      <td class="num"><span class="delta ${gCls}">${fmtSigned(m.growth)}</span></td>
      <td class="num">${fmtBRL(m.baselineMensalRs)}</td>
      <td class="num">${fmtBRL(m.growthChargeRs)}</td>
      <td class="num">${fmtBRL(m.encargosRs)}</td>
      <td class="num strong">${fmtBRL(m.monthlyWithGrowthRs)}</td>
      <td class="num strong">${fmtBRL(m.withCbaRs)}</td>
    </tr>`;
  }).join('');

  const totalRow = `<tr class="mlc-row-total">
    <td>Total (${t.monthsWithScrt}/12)</td>
    <td class="num">${fmtInt(t.consumedMsu)}</td>
    <td class="num">—</td>
    <td class="num">${fmtBRL(t.baselineMensalRs)}</td>
    <td class="num">${fmtBRL(t.growthChargeRs)}</td>
    <td class="num">—</td>
    <td class="num strong">${fmtBRL(t.monthlyWithGrowthRs)}</td>
    <td class="num strong">${fmtBRL(t.withCbaRs)}</td>
  </tr>`;

  return `<section class="card mlc-year">
    <div class="card-header">
      <div>
        <h2>${esc(ano.label)} <span class="muted mlc-year-range">${labelKey(ano.firstPeriodKey)} – ${labelKey(ano.lastPeriodKey)}</span></h2>
        <p class="muted">${esc(params)}</p>
        <p class="muted mlc-encargos">Encargos fixos mensais: ${encargosDesc}</p>
      </div>
    </div>
    <div class="table-responsive">
      <table class="mlc-table">
        <thead>
          <tr>
            <th>Mês</th>
            <th class="num">Consumo (SCRT)</th>
            <th class="num">Growth (MSU)</th>
            <th class="num">Baseline R$</th>
            <th class="num">Encargo cresc. R$</th>
            <th class="num">Encargos fixos R$</th>
            <th class="num">Consumo c/ Growth R$</th>
            <th class="num">Com CBA R$</th>
          </tr>
        </thead>
        <tbody>${linhas}${totalRow}</tbody>
      </table>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ *
 *  Editor do contrato (modal)
 * ------------------------------------------------------------------ */

let draftYears = []; // estado do editor enquanto aberto

function openContractEditor() {
  if (!state.clientId) return;
  const c = state.data && state.data.contract;
  // Ponto de partida: contrato existente, ou um esboço com 1 ano.
  const start = (c && c.startPeriodKey) || sugerirInicio();
  $('contract-start').value = start;
  draftYears = c && c.years && c.years.length
    ? c.years.map(cloneYear)
    : [novoAno('Ano 1')];
  renderYearsEditor();
  $('contract-error').classList.add('hidden');
  $('btn-delete-contract').classList.toggle('hidden', !(c && c.years && c.years.length));
  $('modal-contract').classList.remove('hidden');
}

// Sugere o mês inicial pelo 1º SCRT do cliente (se houver), senão mês atual.
function sugerirInicio() {
  const scrt = state.data && state.data.scrt;
  if (scrt && scrt.firstPeriodKey) return scrt.firstPeriodKey;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function novoAno(label) {
  return { label, baselineAnnualMsu: 0, valorPorMsu: 0, encargoCrescimentoPorMsu: 0, cbaPct: 0, encargos: [] };
}
function cloneYear(y) {
  return {
    label: y.label || '',
    baselineAnnualMsu: y.baselineAnnualMsu || 0,
    valorPorMsu: y.valorPorMsu || 0,
    encargoCrescimentoPorMsu: y.encargoCrescimentoPorMsu || 0,
    cbaPct: y.cbaPct || 0,
    encargos: (y.encargos || []).map((e) => ({ nome: e.nome || '', valorMensal: e.valorMensal || 0 })),
  };
}

function renderYearsEditor() {
  const el = $('contract-years-editor');
  el.innerHTML = draftYears.map((y, i) => {
    const encargos = y.encargos.map((e, j) =>
      `<div class="encargo-row">
        <input type="text" class="enc-nome" data-year="${i}" data-enc="${j}" value="${esc(e.nome)}" placeholder="Nome (ex.: Dev/Test)">
        <input type="number" step="any" class="enc-valor" data-year="${i}" data-enc="${j}" value="${e.valorMensal}" placeholder="R$/mês">
        <button type="button" class="btn-icon" data-remove-enc data-year="${i}" data-enc="${j}" title="Remover encargo" aria-label="Remover encargo">×</button>
      </div>`).join('');

    return `<div class="year-editor">
      <div class="year-editor-head">
        <input type="text" class="year-label" data-year="${i}" value="${esc(y.label)}" placeholder="Ano ${i + 1}">
        ${draftYears.length > 1 ? `<button type="button" class="btn btn-danger-ghost btn-sm" data-remove-year data-year="${i}">Remover ano</button>` : ''}
      </div>
      <div class="year-grid">
        <label class="field"><span>Baseline anual (MSU)</span>
          <input type="number" step="any" class="y-baseline" data-year="${i}" value="${y.baselineAnnualMsu}"></label>
        <label class="field"><span>Valor por MSU (R$)</span>
          <input type="number" step="any" class="y-valor" data-year="${i}" value="${y.valorPorMsu}"></label>
        <label class="field"><span>Encargo de crescimento por MSU (R$)</span>
          <input type="number" step="any" class="y-cresc" data-year="${i}" value="${y.encargoCrescimentoPorMsu}"></label>
        <label class="field"><span>CBA (%)</span>
          <input type="number" step="any" class="y-cba" data-year="${i}" value="${round(y.cbaPct * 100)}"></label>
      </div>
      <div class="encargos-block">
        <div class="encargos-head"><span>Encargos fixos mensais</span>
          <button type="button" class="btn btn-ghost btn-sm" data-add-enc data-year="${i}">+ Encargo</button>
        </div>
        ${encargos || '<p class="muted small">Nenhum encargo fixo. Use "+ Encargo" para adicionar Dev/Test, Produtos Flat, etc.</p>'}
      </div>
    </div>`;
  }).join('');
}

function round(n) { return Math.round(n * 1e6) / 1e6; }

// Lê os inputs do editor de volta para draftYears (antes de re-render ou salvar).
function syncDraftFromInputs() {
  const el = $('contract-years-editor');
  el.querySelectorAll('.year-label').forEach((inp) => { draftYears[+inp.dataset.year].label = inp.value; });
  el.querySelectorAll('.y-baseline').forEach((inp) => { draftYears[+inp.dataset.year].baselineAnnualMsu = num(inp.value); });
  el.querySelectorAll('.y-valor').forEach((inp) => { draftYears[+inp.dataset.year].valorPorMsu = num(inp.value); });
  el.querySelectorAll('.y-cresc').forEach((inp) => { draftYears[+inp.dataset.year].encargoCrescimentoPorMsu = num(inp.value); });
  el.querySelectorAll('.y-cba').forEach((inp) => { draftYears[+inp.dataset.year].cbaPct = num(inp.value) / 100; });
  el.querySelectorAll('.enc-nome').forEach((inp) => { draftYears[+inp.dataset.year].encargos[+inp.dataset.enc].nome = inp.value; });
  el.querySelectorAll('.enc-valor').forEach((inp) => { draftYears[+inp.dataset.year].encargos[+inp.dataset.enc].valorMensal = num(inp.value); });
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Delegação de eventos no editor (add/remove ano e encargo).
$('contract-years-editor').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  syncDraftFromInputs();
  if (btn.hasAttribute('data-remove-year')) draftYears.splice(+btn.dataset.year, 1);
  else if (btn.hasAttribute('data-add-enc')) draftYears[+btn.dataset.year].encargos.push({ nome: '', valorMensal: 0 });
  else if (btn.hasAttribute('data-remove-enc')) draftYears[+btn.dataset.year].encargos.splice(+btn.dataset.enc, 1);
  else return;
  renderYearsEditor();
});

$('btn-add-year').addEventListener('click', () => {
  syncDraftFromInputs();
  draftYears.push(novoAno(`Ano ${draftYears.length + 1}`));
  renderYearsEditor();
});

async function saveContract() {
  syncDraftFromInputs();
  const start = $('contract-start').value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)) {
    return showError('Informe o mês inicial do contrato.');
  }
  if (!draftYears.length) return showError('Adicione pelo menos um ano de contrato.');

  const contract = {
    startPeriodKey: start,
    years: draftYears.map((y, i) => ({
      label: y.label.trim() || `Ano ${i + 1}`,
      baselineAnnualMsu: y.baselineAnnualMsu,
      valorPorMsu: y.valorPorMsu,
      encargoCrescimentoPorMsu: y.encargoCrescimentoPorMsu,
      cbaPct: y.cbaPct,
      encargos: y.encargos.map((e) => ({ nome: e.nome.trim(), valorMensal: e.valorMensal })).filter((e) => e.nome),
    })),
  };
  try {
    await api(`/clients/${state.clientId}/mlc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contract),
    });
    closeModal();
    await loadMlc();
    toast('Contrato MLC salvo.');
  } catch (err) {
    showError(err.message);
  }
}

async function deleteContract() {
  if (!confirm('Excluir o contrato MLC deste cliente? Os parâmetros serão removidos (o SCRT não é afetado).')) return;
  try {
    await api(`/clients/${state.clientId}/mlc`, { method: 'DELETE' });
    closeModal();
    await loadMlc();
    toast('Contrato MLC excluído.');
  } catch (err) {
    showError(err.message);
  }
}

function showError(msg) {
  const el = $('contract-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function closeModal() { $('modal-contract').classList.add('hidden'); }

/* ------------------------------------------------------------------ *
 *  Eventos globais
 * ------------------------------------------------------------------ */

$('client-select').addEventListener('change', async (e) => {
  state.clientId = e.target.value;
  localStorage.setItem('tfp.clientId', state.clientId);
  try { await loadMlc(); }
  catch (err) { toast(`Falha ao carregar o cliente: ${err.message}`, 'error'); }
});

$('btn-edit-contract').addEventListener('click', openContractEditor);
$('btn-edit-contract-2').addEventListener('click', openContractEditor);
$('btn-empty-new-contract').addEventListener('click', openContractEditor);
$('btn-save-contract').addEventListener('click', saveContract);
$('btn-delete-contract').addEventListener('click', deleteContract);

// Clicar no selo "SCRT" de um mês abre os arquivos daquele mês.
$('mlc-years').addEventListener('click', (e) => {
  const el = e.target.closest('.mlc-scrt-link');
  if (el && window.openScrtFilesModal) window.openScrtFilesModal(state.clientId, el.dataset.period, el.dataset.label);
});

$('modal-contract').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-close-modal]')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal-contract').classList.contains('hidden')) closeModal();
});

loadClients().catch((err) => toast(`Falha ao carregar: ${err.message}`, 'error'));
