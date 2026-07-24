'use strict';

/*
 * Modal "Arquivos SCRT" — compartilhado pelo Consumo zOTC e pelo Consumo MLC.
 * Lista, por mês, os SCRTs originais enviados (uma origem por site), com
 * pré-visualização (CSV é texto) e download. O arquivo bruto é guardado a
 * partir desta versão; meses antigos aparecem marcados como "não guardado".
 *
 * Uso:  window.openScrtFilesModal(clientId, periodKey, periodLabel)
 */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const monthLabel = (k) => { const [y, m] = String(k).split('-').map(Number); return `${MESES[m - 1]}/${y}`; };
  const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  let modal;

  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.className = 'modal-backdrop hidden';
    modal.id = 'modal-scrt-files';
    modal.innerHTML = `
      <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="scrt-files-title">
        <div class="modal-forecast-top">
          <div>
            <h2 id="scrt-files-title">Arquivos SCRT</h2>
            <p class="muted small">arquivos originais enviados para este mês</p>
          </div>
          <button class="row-action" type="button" data-scrt-close aria-label="Fechar">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-forecast-scroll">
          <div id="scrt-files-list"></div>
          <div id="scrt-files-preview" class="scrt-preview hidden">
            <div class="scrt-preview-head">
              <strong id="scrt-preview-name"></strong>
              <button class="btn btn-ghost btn-sm" type="button" data-scrt-preview-close>Fechar prévia</button>
            </div>
            <pre id="scrt-preview-body"></pre>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.classList.add('hidden');
    let pressOnBackdrop = false;
    modal.addEventListener('mousedown', (e) => { pressOnBackdrop = e.target === modal; });
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-scrt-close]')) return close();
      if (e.target === modal && pressOnBackdrop) close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close(); });
    modal.querySelector('[data-scrt-preview-close]').addEventListener('click', () => {
      modal.querySelector('#scrt-files-preview').classList.add('hidden');
    });
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `Erro ${res.status}`);
    return body;
  }

  async function previewFile(reportId, name) {
    const box = modal.querySelector('#scrt-files-preview');
    const body = modal.querySelector('#scrt-preview-body');
    modal.querySelector('#scrt-preview-name').textContent = name;
    body.textContent = 'Carregando…';
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'nearest' });
    try {
      const res = await fetch(`/api/reports/${reportId}/file`);
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      let text = await res.text();
      if (text.length > 200000) text = `${text.slice(0, 200000)}\n\n… (prévia truncada — baixe o arquivo completo)`;
      body.textContent = text;
    } catch (err) {
      body.textContent = `Não foi possível pré-visualizar: ${err.message}`;
    }
  }

  window.openScrtFilesModal = async function (clientId, periodKey, periodLabel) {
    ensureModal();
    modal.querySelector('#scrt-files-title').textContent = `Arquivos SCRT · ${periodLabel || monthLabel(periodKey)}`;
    modal.querySelector('#scrt-files-preview').classList.add('hidden');
    const list = modal.querySelector('#scrt-files-list');
    list.innerHTML = '<p class="muted small">Carregando…</p>';
    modal.classList.remove('hidden');

    let month;
    try {
      month = await fetchJson(`/api/clients/${clientId}/months/${periodKey}`);
    } catch (err) {
      list.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
      return;
    }
    const sources = month.sources || [];
    if (!sources.length) { list.innerHTML = '<p class="muted small">Nenhuma origem neste mês.</p>'; return; }

    list.innerHTML = sources.map((s) => {
      const nome = (s.rawFile && s.rawFile.name) || s.sourceFileName || s.siteLabel || 'SCRT';
      const meta = [
        s.siteLabel ? `site ${esc(s.siteLabel)}` : null,
        s.machineCount ? `${s.machineCount} máquina(s)` : null,
        s.rawFile ? esc(fmtSize(s.rawFile.size)) : null,
      ].filter(Boolean).join(' · ');
      if (!s.rawFile) {
        return `<div class="scrt-file-row">
          <div><strong>${esc(nome)}</strong><div class="muted small">${meta}</div></div>
          <span class="muted small">arquivo não guardado — reenvie o SCRT para ver/baixar</span></div>`;
      }
      const isText = /csv|text/i.test(s.rawFile.contentType || '');
      const acoes = (isText
        ? `<button class="btn btn-ghost btn-sm" type="button" data-preview="${esc(s.reportId)}" data-name="${esc(nome)}">Pré-visualizar</button>`
        : '<span class="muted small">planilha — baixe para abrir</span>')
        + ` <a class="btn btn-primary btn-sm" href="/api/reports/${esc(s.reportId)}/file?download=1">Baixar</a>`;
      return `<div class="scrt-file-row">
        <div><strong>${esc(nome)}</strong><div class="muted small">${meta}</div></div>
        <div class="scrt-file-actions">${acoes}</div></div>`;
    }).join('');

    list.querySelectorAll('[data-preview]').forEach((btn) => {
      btn.addEventListener('click', () => previewFile(btn.dataset.preview, btn.dataset.name));
    });
  };
})();
