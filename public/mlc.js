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
  aba: 'geral', // 'geral' | 'ano' | 'comparativo' | 'planejado'
  charts: {},   // instâncias do Chart.js, uma por aba
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
  renderVisoes();
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
  // Com reajuste no meio do ano, um "R$/MSU" só no cabeçalho seria mentira: o
  // ano tem mais de um. Aí o cabeçalho fica no baseline (que é do ano inteiro) e
  // os preços vão para a tabela de trechos, cada um com sua janela de meses.
  const trechos = ano.trechos || [];
  const params = ano.temVariacao
    ? `Baseline ${fmtInt(ano.baselineAnnualMsu)} MSU/ano (${fmtInt(ano.baselineMensalMsu)}/mês) · ${trechos.length} faixas de preço no ano`
    : [
      `Baseline ${fmtInt(ano.baselineAnnualMsu)} MSU/ano (${fmtInt(ano.baselineMensalMsu)}/mês)`,
      `R$/MSU ${nf.format(ano.valorPorMsu)}`,
      `Cresc./MSU ${nf.format(ano.encargoCrescimentoPorMsu)}`,
      `CBA ${nf.format(ano.cbaPct * 100)}%`,
    ].join(' · ');

  const tabelaTrechos = ano.temVariacao ? `
    <div class="mlc-trechos">
      <table class="mlc-trechos-table">
        <thead><tr><th>Vigência</th><th class="num">R$/MSU</th><th class="num">Cresc./MSU</th><th class="num">CBA</th><th class="num">Encargos fixos</th><th>Referência</th></tr></thead>
        <tbody>${trechos.map((t) => `
          <tr>
            <td><strong>${esc(t.label)}</strong> <span class="muted small">${t.meses} ${t.meses > 1 ? 'meses' : 'mês'}</span></td>
            <td class="num">${nf.format(t.valorPorMsu)}</td>
            <td class="num">${nf.format(t.encargoCrescimentoPorMsu)}</td>
            <td class="num">${nf.format(t.cbaPct * 100)}%</td>
            <td class="num">${fmtBRL(t.encargosMensal)}</td>
            <td class="muted small">${esc(t.notas || (t.doAno ? 'valores do ano' : ''))}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : '';

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
        ${tabelaTrechos}
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

const METAS_VAZIAS = { capAnualRs: 0, capCbaRs: 0, plannedAnnualMsu: 0, baselineZotcAnualMsu: 0 };

function novoAno(label) {
  return {
    label, baselineAnnualMsu: 0, valorPorMsu: 0, encargoCrescimentoPorMsu: 0, cbaPct: 0,
    encargos: [], vigencias: [], ...METAS_VAZIAS,
  };
}
function cloneYear(y) {
  return {
    label: y.label || '',
    baselineAnnualMsu: y.baselineAnnualMsu || 0,
    valorPorMsu: y.valorPorMsu || 0,
    encargoCrescimentoPorMsu: y.encargoCrescimentoPorMsu || 0,
    cbaPct: y.cbaPct || 0,
    capAnualRs: y.capAnualRs || 0,
    capCbaRs: y.capCbaRs || 0,
    plannedAnnualMsu: y.plannedAnnualMsu || 0,
    baselineZotcAnualMsu: y.baselineZotcAnualMsu || 0,
    encargos: (y.encargos || []).map((e) => ({ nome: e.nome || '', valorMensal: e.valorMensal || 0 })),
    vigencias: (y.vigencias || []).map((v) => ({
      fromPeriodKey: v.fromPeriodKey || '',
      valorPorMsu: v.valorPorMsu || 0,
      encargoCrescimentoPorMsu: v.encargoCrescimentoPorMsu || 0,
      cbaPct: v.cbaPct || 0,
      encargos: (v.encargos || []).map((e) => ({ nome: e.nome || '', valorMensal: e.valorMensal || 0 })),
      notas: v.notas || '',
    })),
  };
}

/* Mês inicial do ano no editor. O contrato pode ainda não estar salvo, então sai
   do campo de início da tela — é ele que manda enquanto se edita. */
function primeiroMesDoAno(i) {
  const inicio = ($('contract-start') && $('contract-start').value) || '';
  if (!/^\d{4}-\d{2}$/.test(inicio)) return '';
  const [a, m] = inicio.split('-').map(Number);
  const idx = a * 12 + (m - 1) + i * 12;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
function ultimoMesDoAno(i) {
  const p = primeiroMesDoAno(i);
  if (!p) return '';
  const [a, m] = p.split('-').map(Number);
  const idx = a * 12 + (m - 1) + 11;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
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

    const pri = primeiroMesDoAno(i);
    const ult = ultimoMesDoAno(i);
    const vigencias = (y.vigencias || []).map((v, j) => `
      <div class="vig-row">
        <div class="vig-head">
          <label class="field vig-mes"><span>A partir de</span>
            <input type="month" class="v-from" data-year="${i}" data-vig="${j}" value="${esc(v.fromPeriodKey)}"
                   ${pri ? `min="${pri}" max="${ult}"` : ''}></label>
          <label class="field vig-nota"><span>Referência (opcional)</span>
            <input type="text" class="v-notas" data-year="${i}" data-vig="${j}" value="${esc(v.notas)}" placeholder="Ex.: Aditivo 3/2026"></label>
          <button type="button" class="btn-icon" data-remove-vig data-year="${i}" data-vig="${j}" title="Remover reajuste" aria-label="Remover reajuste">×</button>
        </div>
        <div class="year-grid">
          <label class="field"><span>Valor por MSU (R$)</span>
            <input type="number" step="any" class="v-valor" data-year="${i}" data-vig="${j}" value="${v.valorPorMsu}"></label>
          <label class="field"><span>Encargo de crescimento por MSU (R$)</span>
            <input type="number" step="any" class="v-cresc" data-year="${i}" data-vig="${j}" value="${v.encargoCrescimentoPorMsu}"></label>
          <label class="field"><span>CBA (%)</span>
            <input type="number" step="any" class="v-cba" data-year="${i}" data-vig="${j}" value="${round(v.cbaPct * 100)}"></label>
        </div>
        <div class="encargos-head"><span class="muted small">Encargos fixos deste trecho</span>
          <button type="button" class="btn btn-ghost btn-sm" data-add-venc data-year="${i}" data-vig="${j}">+ Encargo</button>
        </div>
        ${(v.encargos || []).map((e, k) => `
          <div class="encargo-row">
            <input type="text" class="venc-nome" data-year="${i}" data-vig="${j}" data-enc="${k}" value="${esc(e.nome)}" placeholder="Nome">
            <input type="number" step="any" class="venc-valor" data-year="${i}" data-vig="${j}" data-enc="${k}" value="${e.valorMensal}" placeholder="R$/mês">
            <button type="button" class="btn-icon" data-remove-venc data-year="${i}" data-vig="${j}" data-enc="${k}" title="Remover" aria-label="Remover">×</button>
          </div>`).join('') || '<p class="muted small">Sem encargo fixo neste trecho — se o contrato mantém os mesmos, repita-os aqui.</p>'}
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
      <div class="encargos-block">
        <div class="encargos-head"><span>Tetos e metas do ano <span class="muted small">(opcionais — usados nas visões da reunião)</span></span></div>
        <div class="year-grid">
          <label class="field"><span>CAP anual MLC (R$)</span>
            <input type="number" step="any" min="0" class="y-cap" data-year="${i}" value="${y.capAnualRs || ''}" placeholder="teto contratado"></label>
          <label class="field"><span>CAP com CBA (R$)</span>
            <input type="number" step="any" min="0" class="y-capcba" data-year="${i}" value="${y.capCbaRs || ''}" placeholder="disponibilidade"></label>
          <label class="field"><span>Consumo planejado (MSU)</span>
            <input type="number" step="any" min="0" class="y-plan" data-year="${i}" value="${y.plannedAnnualMsu || ''}" placeholder="entregue pelo cliente"></label>
          <label class="field"><span>Baseline zOTC do ano (MSU)</span>
            <input type="number" step="any" min="0" class="y-basezotc" data-year="${i}" value="${y.baselineZotcAnualMsu || ''}" placeholder="vazio = baseline do cliente"></label>
        </div>
        <p class="muted small">O <strong>CAP com CBA</strong> é negociado à parte, não é o CAP × (1 − CBA). O <strong>baseline zOTC</strong>
        é o teto de consumo do contrato zOTC, diferente do baseline anual do MLC acima.</p>
      </div>
      <div class="encargos-block">
        <div class="encargos-head">
          <span>Reajustes no meio do ano</span>
          <button type="button" class="btn btn-ghost btn-sm" data-add-vig data-year="${i}">+ Reajuste</button>
        </div>
        <p class="muted small">Os valores acima valem a partir de ${esc(rotuloMes(primeiroMesDoAno(i)) || 'o início do ano')}. Um reajuste passa a valer do mês informado até o próximo (ou até o fim do ano). O baseline anual não muda — o reajuste é de preço.</p>
        ${vigencias || ''}
      </div>
    </div>`;
  }).join('');
}

function round(n) { return Math.round(n * 1e6) / 1e6; }

const MESES_ED = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
function rotuloMes(k) {
  if (!/^\d{4}-\d{2}$/.test(k || '')) return '';
  const [a, m] = k.split('-').map(Number);
  return `${MESES_ED[m - 1]}/${String(a).slice(-2)}`;
}

// Lê os inputs do editor de volta para draftYears (antes de re-render ou salvar).
function syncDraftFromInputs() {
  const el = $('contract-years-editor');
  el.querySelectorAll('.year-label').forEach((inp) => { draftYears[+inp.dataset.year].label = inp.value; });
  el.querySelectorAll('.y-baseline').forEach((inp) => { draftYears[+inp.dataset.year].baselineAnnualMsu = num(inp.value); });
  el.querySelectorAll('.y-valor').forEach((inp) => { draftYears[+inp.dataset.year].valorPorMsu = num(inp.value); });
  el.querySelectorAll('.y-cresc').forEach((inp) => { draftYears[+inp.dataset.year].encargoCrescimentoPorMsu = num(inp.value); });
  el.querySelectorAll('.y-cba').forEach((inp) => { draftYears[+inp.dataset.year].cbaPct = num(inp.value) / 100; });
  el.querySelectorAll('.y-cap').forEach((inp) => { draftYears[+inp.dataset.year].capAnualRs = num(inp.value); });
  el.querySelectorAll('.y-capcba').forEach((inp) => { draftYears[+inp.dataset.year].capCbaRs = num(inp.value); });
  el.querySelectorAll('.y-plan').forEach((inp) => { draftYears[+inp.dataset.year].plannedAnnualMsu = num(inp.value); });
  el.querySelectorAll('.y-basezotc').forEach((inp) => { draftYears[+inp.dataset.year].baselineZotcAnualMsu = num(inp.value); });
  el.querySelectorAll('.enc-nome').forEach((inp) => { draftYears[+inp.dataset.year].encargos[+inp.dataset.enc].nome = inp.value; });
  el.querySelectorAll('.enc-valor').forEach((inp) => { draftYears[+inp.dataset.year].encargos[+inp.dataset.enc].valorMensal = num(inp.value); });
  const vig = (inp) => draftYears[+inp.dataset.year].vigencias[+inp.dataset.vig];
  el.querySelectorAll('.v-from').forEach((inp) => { vig(inp).fromPeriodKey = inp.value; });
  el.querySelectorAll('.v-notas').forEach((inp) => { vig(inp).notas = inp.value; });
  el.querySelectorAll('.v-valor').forEach((inp) => { vig(inp).valorPorMsu = num(inp.value); });
  el.querySelectorAll('.v-cresc').forEach((inp) => { vig(inp).encargoCrescimentoPorMsu = num(inp.value); });
  el.querySelectorAll('.v-cba').forEach((inp) => { vig(inp).cbaPct = num(inp.value) / 100; });
  el.querySelectorAll('.venc-nome').forEach((inp) => { vig(inp).encargos[+inp.dataset.enc].nome = inp.value; });
  el.querySelectorAll('.venc-valor').forEach((inp) => { vig(inp).encargos[+inp.dataset.enc].valorMensal = num(inp.value); });
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
  else if (btn.hasAttribute('data-add-vig')) {
    const ano = draftYears[+btn.dataset.year];
    // O reajuste nasce COPIANDO os valores em vigor: quem reajusta costuma mudar
    // um campo só, e partir de zero convidaria a salvar um trecho com preço nulo.
    const ult = (ano.vigencias || [])[ano.vigencias.length - 1] || ano;
    ano.vigencias.push({
      fromPeriodKey: '',
      valorPorMsu: ult.valorPorMsu || 0,
      encargoCrescimentoPorMsu: ult.encargoCrescimentoPorMsu || 0,
      cbaPct: ult.cbaPct || 0,
      encargos: (ult.encargos || []).map((e) => ({ nome: e.nome, valorMensal: e.valorMensal })),
      notas: '',
    });
  } else if (btn.hasAttribute('data-remove-vig')) draftYears[+btn.dataset.year].vigencias.splice(+btn.dataset.vig, 1);
  else if (btn.hasAttribute('data-add-venc')) draftYears[+btn.dataset.year].vigencias[+btn.dataset.vig].encargos.push({ nome: '', valorMensal: 0 });
  else if (btn.hasAttribute('data-remove-venc')) draftYears[+btn.dataset.year].vigencias[+btn.dataset.vig].encargos.splice(+btn.dataset.enc, 1);
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

  /* O PUT SUBSTITUI o contrato inteiro: tudo que não for enviado some do banco.
     Foi assim que os reajustes cadastrados desapareciam a cada "Salvar" — o corpo
     ia sem `vigencias`. Se acrescentar campo ao ano, acrescente aqui também. */
  const contract = {
    startPeriodKey: start,
    years: draftYears.map((y, i) => ({
      label: y.label.trim() || `Ano ${i + 1}`,
      baselineAnnualMsu: y.baselineAnnualMsu,
      valorPorMsu: y.valorPorMsu,
      encargoCrescimentoPorMsu: y.encargoCrescimentoPorMsu,
      cbaPct: y.cbaPct,
      encargos: y.encargos.map((e) => ({ nome: e.nome.trim(), valorMensal: e.valorMensal })).filter((e) => e.nome),
      vigencias: (y.vigencias || [])
        .filter((v) => /^\d{4}-\d{2}$/.test(v.fromPeriodKey || ''))
        .map((v) => ({
          fromPeriodKey: v.fromPeriodKey,
          valorPorMsu: v.valorPorMsu,
          encargoCrescimentoPorMsu: v.encargoCrescimentoPorMsu,
          cbaPct: v.cbaPct,
          encargos: (v.encargos || []).map((e) => ({ nome: e.nome.trim(), valorMensal: e.valorMensal })).filter((e) => e.nome),
          notas: (v.notas || '').trim(),
        })),
      capAnualRs: y.capAnualRs,
      capCbaRs: y.capCbaRs,
      plannedAnnualMsu: y.plannedAnnualMsu,
      baselineZotcAnualMsu: y.baselineZotcAnualMsu,
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
 *  As três visões da reunião
 *
 *  Tudo aqui vem pronto do servidor, em `data.views` (src/mlcViews.js) — a mesma
 *  estrutura que o .pptx consome. A tela NÃO recalcula nada: é o que garante que
 *  o slide levado ao cliente diga exatamente o que está no navegador.
 * ------------------------------------------------------------------ */

const CHART_BASE = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'top', align: 'end', labels: { usePointStyle: true, pointStyleWidth: 10, boxHeight: 7, font: { size: 12 } } },
    tooltip: { backgroundColor: '#1c1c1c', padding: 12 },
  },
};
const fmtM = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}M` : fmtInt(n));
const fmtPct2 = (p) => (p == null ? '–' : `${Number(p).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);

function trocarAba(aba) {
  state.aba = aba;
  document.querySelectorAll('#mlc-tabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.aba === aba));
  document.querySelectorAll('.mlc-aba').forEach((d) => d.classList.toggle('hidden', d.dataset.aba !== aba));
  $('mlc-ano-wrap').classList.toggle('hidden', aba !== 'ano');
  $('btn-mlc-pptx-slide').classList.toggle('hidden', aba === 'geral');
  const nomes = { ano: 'Consumo MLC do ano', comparativo: 'Comparação por ano', planejado: 'Consumido × planejado' };
  if (nomes[aba]) $('btn-mlc-pptx-slide').textContent = `Só "${nomes[aba]}" em PPT`;
  // Chart.js só mede direito o que está visível; redesenha ao entrar na aba.
  renderVisoes();
}

function renderVisoes() {
  const v = state.data && state.data.views;
  if (!v) return;
  preencherSeletorDeAno(v);
  if (state.aba === 'ano') renderAnoMlc(v.anoMlc);
  if (state.aba === 'comparativo') renderComparativo(v.comparativo);
  if (state.aba === 'planejado') renderPlanejado(v.planejado);
}

function preencherSeletorDeAno(v) {
  const sel = $('mlc-ano');
  const atual = String(v.anoSelecionado);
  const html = v.anosDisponiveis.map((a) =>
    `<option value="${a.indice}">${esc(a.label)} · ${esc(a.periodoLabel)}${a.mesesComScrt ? '' : ' (sem SCRT)'}</option>`).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.value = atual;
}

/* ── Visão 1: consumo de MLC do ano (R$) ── */

function renderAnoMlc(a) {
  const tabela = $('mlc-ano-tabela');
  if (!a) { tabela.querySelector('tbody').innerHTML = ''; return; }

  tabela.querySelector('thead').innerHTML =
    '<tr><th>Histórico inventário (R$) reportado</th>'
    + a.colunas.map((c) => `<th class="num">Med/ ${esc(c.medLabel)}<br><span class="muted small">Inv/ ${esc(c.invLabel)}</span></th>`).join('')
    + '<th class="num">Total</th></tr>';

  const linha = (rotulo, campo, total) =>
    `<tr><td><strong>${esc(rotulo)}</strong></td>`
    + a.colunas.map((c) => `<td class="num">${c[campo] == null ? '<span class="muted">–</span>' : fmtBRL(c[campo])}</td>`).join('')
    + `<td class="num"><strong>${fmtBRL(total)}</strong></td></tr>`;
  tabela.querySelector('tbody').innerHTML =
    linha('Consumo mensal (R$)', 'consumoRs', a.totais.consumoRs)
    + linha(`Consumo com CBA (${a.cbaLabel})`, 'comCbaRs', a.totais.comCbaRs);

  $('mlc-cap').innerHTML = a.cap ? blocoCap(a) : `<div class="mlc-cap-vazio muted small">
      Sem <strong>CAP contratado</strong> cadastrado para o ${esc(a.label)}. Informe o teto anual em
      <strong>Editar contrato</strong> para acompanhar o saldo.</div>`;

  $('mlc-ano-nota').innerHTML = `<strong>Med/</strong> = mês medido no SCRT · <strong>Inv/</strong> = mês em que entra no `
    + `inventário (defasagem de ${a.lagMonths} ${a.lagMonths === 1 ? 'mês' : 'meses'}). Os valores são os do mês medido. `
    + `${a.totais.mesesComScrt} de ${a.totais.mesesNoAno} meses com SCRT recebido.`;

  desenharAnoChart(a);
}

function blocoCap(a) {
  const c = a.cap;
  const bloco = (titulo, linhas) => `<div class="mlc-cap-card">
      <div class="mlc-cap-head">${esc(titulo)}</div>
      ${linhas.map((l) => `<div class="mlc-cap-row${l.destaque ? ' destaque' : ''}">
        <span>${esc(l.k)}</span><strong${l.alerta ? ' class="delta up"' : ''}>${esc(l.v)}</strong></div>`).join('')}
    </div>`;
  const cards = [bloco(`CAP — máximo anual MLC ${a.label} (${c.janelaLabel})`, [
    { k: 'CAP contratado', v: fmtBRL(c.anualRs) },
    { k: 'Total CAP consumido', v: fmtBRL(c.consumidoRs) },
    { k: c.estourado ? 'CAP excedido' : 'Saldo CAP', v: fmtBRL(Math.abs(c.saldoRs)), destaque: true, alerta: c.estourado },
  ])];
  if (c.cba) {
    cards.push(bloco(`CAP — disponibilidade CBA (${c.janelaLabel})`, [
      { k: 'Disponibilidade contratada', v: fmtBRL(c.cba.anualRs) },
      { k: `Total consumido (${fmtPct2(c.cba.descontoPct)} de desconto)`, v: fmtBRL(c.cba.consumidoRs) },
      { k: c.cba.estourado ? 'CBA excedido' : 'Saldo CAP CBA', v: fmtBRL(Math.abs(c.cba.saldoRs)), destaque: true, alerta: c.cba.estourado },
    ]));
  }
  return cards.join('');
}

function desenharAnoChart(a) {
  const ctx = $('mlcAnoChart').getContext('2d');
  const datasets = [{
    type: 'bar', label: 'Consumo mensal (R$)',
    data: a.colunas.map((c) => c.consumoRs),
    backgroundColor: '#a8c0ea', borderColor: '#5b8ad6', borderWidth: 1,
  }];
  if (a.cap) {
    datasets.push({
      type: 'line', label: `CAP contratado mensal (${fmtBRL(a.cap.mensalRs)})`,
      data: a.colunas.map(() => a.cap.mensalRs),
      borderColor: '#ff832b', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false,
    });
  }
  if (state.charts.ano) state.charts.ano.destroy();
  state.charts.ano = new Chart(ctx, {
    data: { labels: a.colunas.map((c) => `Inv/ ${c.invLabel}`), datasets },
    options: {
      ...CHART_BASE,
      plugins: {
        ...CHART_BASE.plugins,
        tooltip: { ...CHART_BASE.plugins.tooltip, callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtBRL(c.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 0, autoSkipPadding: 8 } },
        y: { beginAtZero: false, grid: { color: '#eef1f5' }, ticks: { callback: (v) => fmtM(v) } },
      },
    },
  });
}

/* ── Visão 2: comparação de consumo por ano (MSU) ── */

function renderComparativo(c) {
  const nota = $('mlc-cmp-nota');
  if (!c.anos.length) {
    nota.textContent = 'Nenhum ano contratual tem consumo medido.';
    if (state.charts.cmp) { state.charts.cmp.destroy(); state.charts.cmp = null; }
    $('mlc-cmp-tabela').querySelector('tbody').innerHTML = '';
    return;
  }

  const datasets = c.anos.map((a) => ({
    label: a.mesesPlanejados > 0 ? `${a.label} (${a.mesesComDado} medidos + ${a.mesesPlanejados} planejados)` : a.label,
    data: a.pontos,
    borderColor: `#${a.cor}`, backgroundColor: `#${a.cor}`,
    borderWidth: 2.5, pointRadius: 2, pointHoverRadius: 4, tension: 0.1, spanGaps: false,
    // Tracejado a partir do mês em que o dado deixa de ser medido.
    segment: a.posicaoUltimoReal != null && a.mesesPlanejados > 0
      ? { borderDash: (ctx) => (ctx.p0DataIndex + 1 >= a.posicaoUltimoReal ? [6, 4] : undefined) }
      : undefined,
  }));
  if (c.baseline) {
    datasets.push({
      label: c.baseline.label, data: Array.from({ length: 12 }, () => c.baseline.mensalMsu),
      borderColor: '#0072c3', borderWidth: 2, borderDash: [2, 3], pointRadius: 0, fill: false,
    });
  }

  const ctx = $('mlcCmpChart').getContext('2d');
  if (state.charts.cmp) state.charts.cmp.destroy();
  state.charts.cmp = new Chart(ctx, {
    type: 'line',
    data: { labels: Array.from({ length: 12 }, (_, i) => String(i + 1)), datasets },
    options: {
      ...CHART_BASE,
      plugins: {
        ...CHART_BASE.plugins,
        tooltip: {
          ...CHART_BASE.plugins.tooltip,
          callbacks: {
            title: (its) => `Mês ${its[0].label} do ano contratual`,
            label: (it) => ` ${it.dataset.label}: ${fmtInt(it.parsed.y)} MSU`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, title: { display: true, text: 'posição do mês dentro do ano contratual' } },
        y: { beginAtZero: false, grid: { color: '#eef1f5' }, ticks: { callback: (v) => fmtM(v) }, title: { display: true, text: 'MSUs por mês' } },
      },
    },
  });

  nota.innerHTML = 'Cada série é um ano contratual, alinhado pela <strong>posição do mês dentro do ano</strong> — '
    + 'é o que permite comparar o mesmo ponto do ciclo em anos diferentes. Trecho tracejado = completado pelo consumo planejado.'
    + (c.estouro
      ? ` <span class="delta up">Estouro:</span> no mês ${c.estouro.posicao}${c.estouro.planejado ? ' (trecho planejado)' : ''} o `
        + `acumulado do ${esc(c.estouro.anoLabel)} chega a ${fmtInt(c.estouro.acumuladoMsu)} MSU e passa o baseline anual de `
        + `${fmtInt(c.baseline.anualMsu)} MSU.`
      : '');

  const t = $('mlc-cmp-tabela');
  t.querySelector('thead').innerHTML = '<tr><th>Ano</th>'
    + Array.from({ length: 12 }, (_, i) => `<th class="num">${i + 1}</th>`).join('') + '<th class="num">Total</th></tr>';
  t.querySelector('tbody').innerHTML = c.anos.map((a) => {
    const total = a.pontos.reduce((s, v) => s + (v || 0), 0);
    return `<tr><td><strong>${esc(a.label)}</strong> <span class="muted small">${esc(a.periodoLabel)}</span></td>`
      + a.pontos.map((v, k) => {
        const planejado = a.posicaoUltimoReal != null && k + 1 > a.posicaoUltimoReal;
        return `<td class="num${planejado ? ' muted' : ''}">${v == null ? '–' : fmtInt(v)}</td>`;
      }).join('')
      + `<td class="num"><strong>${fmtInt(total)}</strong></td></tr>`;
  }).join('');
}

/* ── Visão 3: consumido × planejado × contratado ── */

function renderPlanejado(p) {
  const t = $('mlc-plan-tabela');
  t.querySelector('thead').innerHTML = '<tr><th>Ano contratual</th><th class="num">Consumo planejado</th>'
    + '<th class="num">Baseline contratado</th><th class="num">MSUs consumidas</th><th class="num">Consumido vs contratado</th></tr>';

  const marcaBaseline = p.notas.find((n) => n.tipo === 'baseline');
  const marcaEstimado = p.notas.find((n) => n.tipo === 'estimado' || n.tipo === 'parcial');
  t.querySelector('tbody').innerHTML = p.anos.map((a) => `
    <tr>
      <td><strong>${esc(a.label)}</strong> <span class="muted small">${esc(a.periodoLabel)}</span></td>
      <td class="num">${a.planejadoMsu > 0 ? fmtInt(a.planejadoMsu) : '<span class="muted">–</span>'}</td>
      <td class="num${a.baselineIgualConsumoAnterior ? ' cel-destaque' : ''}">${fmtInt(a.baselineZotcMsu)}${a.baselineIgualConsumoAnterior && marcaBaseline ? ` <span class="muted small">${marcaBaseline.marca}</span>` : ''}</td>
      <td class="num"><strong>${fmtInt(a.consumidasMsu)}</strong>${(a.estimado || a.parcialSemPlanejado) && marcaEstimado ? ` <span class="muted small">${marcaEstimado.marca}</span>` : ''}</td>
      <td class="num"><span class="delta ${a.excedeBaseline ? 'up' : 'down'}">${fmtPct2(a.vsContratadoPct)}</span></td>
    </tr>`).join('');

  $('mlc-plan-notas').innerHTML = p.notas.map((n) => `<div>${esc(n.marca)} ${esc(n.texto)}</div>`).join('');
  $('mlc-plan-conclusoes').innerHTML = p.conclusoes.length
    ? p.conclusoes.map((c) => `<li>${esc(c)}</li>`).join('')
    : '<li class="muted">Sem ano fechado o bastante para concluir alguma coisa.</li>';

  const ctx = $('mlcPlanChart').getContext('2d');
  if (state.charts.plan) state.charts.plan.destroy();
  state.charts.plan = new Chart(ctx, {
    data: {
      labels: p.anos.map((a) => a.label),
      datasets: [
        { type: 'bar', label: 'MSUs consumidas (SCRT)', data: p.anos.map((a) => a.consumidasMsu), backgroundColor: '#2e6bd4' },
        { type: 'bar', label: 'Consumo planejado', data: p.anos.map((a) => a.planejadoMsu || null), backgroundColor: '#ed7d31' },
        {
          type: 'line', label: 'Baseline contratado', data: p.anos.map((a) => a.baselineZotcMsu || null),
          borderColor: '#da1e28', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, stepped: 'middle', fill: false,
        },
      ],
    },
    options: {
      ...CHART_BASE,
      plugins: {
        ...CHART_BASE.plugins,
        tooltip: { ...CHART_BASE.plugins.tooltip, callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtInt(c.parsed.y)} MSU` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: '#eef1f5' }, ticks: { callback: (v) => fmtM(v) }, title: { display: true, text: 'MSUs por ano contratual' } },
      },
    },
  });
}

/* ── Exportação ── */

function baixarPptx(slides) {
  if (!state.clientId || !state.data || !state.data.views) return;
  const ano = state.data.views.anoSelecionado;
  const q = new URLSearchParams({ ano: String(ano) });
  if (slides) q.set('slides', slides);
  window.location.assign(`/api/clients/${state.clientId}/mlc.pptx?${q}`);
  toast('Gerando a apresentação…');
}

/* ------------------------------------------------------------------ *
 *  Eventos globais
 * ------------------------------------------------------------------ */

$('mlc-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (btn) trocarAba(btn.dataset.aba);
});

$('mlc-ano').addEventListener('change', async (e) => {
  try {
    state.data = await api(`/clients/${state.clientId}/mlc?ano=${encodeURIComponent(e.target.value)}`);
    renderVisoes();
  } catch (err) { toast(`Falha ao trocar de ano: ${err.message}`, 'error'); }
});

$('btn-mlc-pptx').addEventListener('click', () => baixarPptx(null));
$('btn-mlc-pptx-slide').addEventListener('click', () => {
  baixarPptx({ ano: '1', comparativo: '2', planejado: '3' }[state.aba]);
});

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
