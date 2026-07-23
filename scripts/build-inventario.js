'use strict';

/*
 * Gera public/inventario.html a partir do painel original em Inventario/.
 *
 * O painel é mantido intacto: este build só (1) aplica o sistema visual do
 * TFPSystem, (2) insere a barra de módulos e (3) anexa um script que
 * sobrescreve a camada de persistência para gravar no MongoDB via API,
 * em vez de localStorage.
 *
 * Quando chegar uma versão nova do painel, basta substituir o arquivo em
 * Inventario/ e rodar:  npm run build:inventario
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'Inventario');
const OUT = path.join(ROOT, 'public', 'inventario.html');

/** Pega o painel mais recente na pasta Inventario/ (app_inventario*.html). */
function findSource() {
  const explicit = process.argv[2];
  if (explicit) return path.resolve(explicit);
  const candidates = fs.readdirSync(SRC_DIR)
    .filter((f) => /^app_inventario.*\.html?$/i.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(SRC_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) {
    throw new Error(`Nenhum painel encontrado em ${SRC_DIR} (esperado app_inventario*.html).`);
  }
  return path.join(SRC_DIR, candidates[0].f);
}

const ICONS = {
  chart: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 13.5V9m4 4.5V4m4 9.5V7m4 6.5V2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  box: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 5.2 8 2l6 3.2v5.6L8 14l-6-3.2V5.2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M2 5.2 8 8.4l6-3.2M8 8.4V14" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  building: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 20h18M4 20V9.5L12 4l8 5.5V20M9 20v-5.5h6V20" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const TOPBAR = `
  <!-- Barra de módulos do TFPSystem (gerada por scripts/build-inventario.js) -->
  <header class="tfp-topbar">
    <div class="tfp-topbar-inner">
      <div class="tfp-brand">
        <div class="tfp-brand-mark">TFP</div>
        <div><h1>TFPSystem</h1></div>
        <nav class="tfp-module-nav" aria-label="Módulos">
          <a href="/">${ICONS.chart}Consumo (SCRT)</a>
          <a href="/inventario" class="active" aria-current="page">${ICONS.box}Inventário</a>
        </nav>
      </div>
    </div>
  </header>
`;

/** Trocas de texto: tira pictogramas e ajusta rótulos para o tom formal. */
const TEXT_REPLACEMENTS = [
  ['🔄 Atualizar / Fazer Carga', 'Carregar inventário'],
  ['👤 Selecionar Cliente no Menu', 'Selecionar cliente'],
  ['📄 Carregar Novo Inventário', 'Carregar inventário'],
  ['💾 Salvo Localmente', 'Salvo no banco'],
  ['➕ Carregar Novo Inventário / Adicionar Cliente...', 'Carregar novo inventário…'],
  ['📅 Range Eff. Date:', 'Effective date'],
  ['☑️ Selecionar Todos', 'Selecionar todos'],
  ['☐ Desmarcar Todos', 'Desmarcar todos'],
  ['⭐ Apenas ECUS (Padrão)', 'Apenas ECUS (padrão)'],
  ['🏷️ Status do Produto (Filtrar por Status Válidos IBM):', 'Status do produto'],
  ['🔍 Buscar por PID, Descrição, Status ou Serial...', 'Buscar por PID, descrição, status ou serial'],
  ['📥 Exportar CSV', 'Exportar CSV'],
  ['🔑 Identificação do PID', 'Identificação do PID'],
  ['🤖 Resumo Inteligente por IA (O que este Produto Faz)', 'Resumo do produto'],
  ['📜 Carta de Anúncio & Termos (IBM CSOL Portal)', 'Carta de anúncio &amp; termos (IBM CSOL)'],
  ['🧮 VUE (Value Unit Exhibit & Precificação)', 'VUE (Value Unit Exhibit)'],
  ['🏛️ Consultar no Portal IBM CSOL (Terms) →', 'Consultar no portal IBM CSOL'],
  ['📅 Registros do PID & Effective Dates', 'Registros do PID &amp; effective dates'],
  ['🗑️ Apagar Registro', 'Excluir inventário'],
  ['🏠 Início', 'Início'],
];

/** Trocas dentro de template strings do JS do painel. */
const JS_REPLACEMENTS = [
  ['`🏛️ Consultar no Portal IBM CSOL (Termos de ${firstProd.productId}) →`', '`Consultar no portal IBM CSOL (${firstProd.productId})`'],
  ['`${btn.dataset.count}x 🔼 Recolher`', '`${btn.dataset.count}x · recolher`'],
  ['`${btn.dataset.count}x 📂 Expandir`', '`${btn.dataset.count}x · expandir`'],
  ['${item.count}x 📂 Expandir', '${item.count}x · expandir'],
  ["📅 ${p.effDate || '-'}", "${p.effDate || '-'}"],
  ["📅 ${prod.effDate || '-'}", "${prod.effDate || '-'}"],
  ['📅 ${rec.effDate}', '${rec.effDate}'],
  ['📅 Registros Individuais do PID ${item.productId} (Clique nos cabeçalhos para ordenar)', 'Registros individuais do PID ${item.productId}'],
];

function build() {
  const srcPath = findSource();
  let html = fs.readFileSync(srcPath, 'utf8');
  const original = html.length;

  // 1) Sistema visual: troca o <style> do painel pelo do TFPSystem.
  const css = fs.readFileSync(path.join(__dirname, 'inventario.css'), 'utf8');
  if (!/<style>[\s\S]*?<\/style>/.test(html)) throw new Error('Bloco <style> não encontrado no painel.');
  html = html.replace(/<style>[\s\S]*?<\/style>/, () => `<style>\n${css}\n  </style>`);

  // 2) Barra de módulos logo após <body>.
  if (!/<body[^>]*>/.test(html)) throw new Error('<body> não encontrado no painel.');
  html = html.replace(/<body[^>]*>/, (m) => `${m}\n${TOPBAR}`);

  // 3) Texto: pictogramas fora, rótulos formais.
  for (const [from, to] of [...TEXT_REPLACEMENTS, ...JS_REPLACEMENTS]) {
    html = html.split(from).join(to);
  }
  // Botão de fechar do modal vira ícone.
  html = html.replace(
    /<button([^>]*class="modal-close-btn"[^>]*)>\s*[✕✖×]\s*<\/button>/,
    `<button$1 aria-label="Fechar">${ICONS.close}</button>`
  );
  // Emoji solto no estado vazio -> ícone.
  html = html.replace(
    /<div style="font-size: ?3\.5rem[^"]*">\s*🏢\s*<\/div>/,
    `<div style="margin-bottom:14px; color:#c6c6c6; display:flex; justify-content:center;">${ICONS.building}</div>`
  );
  // Varredura final: remove pictogramas remanescentes preservando o texto.
  html = html.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '');

  // 4) Estilos inline que brigam com o sistema visual (cantos grandes, sombras).
  html = html
    .replace(/border-radius:\s*(8|10|12|16)px/g, 'border-radius: 4px')
    .replace(/box-shadow:\s*0 [^;"]*rgba\(0,\s*0,\s*0,\s*0\.0[0-9]+\)/g, 'box-shadow: none')
    .replace(/border-left:\s*5px solid/g, 'border-left: 2px solid');

  // 5) Persistência no MongoDB (sobrescreve as funções do painel).
  const bridge = fs.readFileSync(path.join(__dirname, 'inventario-bridge.js'), 'utf8');
  html = html.replace(/<\/body>/, `<script>\n${bridge}\n</script>\n</body>`);

  fs.writeFileSync(OUT, html);
  console.log(`Painel:  ${path.relative(ROOT, srcPath)} (${(original / 1024).toFixed(0)} KB)`);
  console.log(`Gerado:  ${path.relative(ROOT, OUT)} (${(html.length / 1024).toFixed(0)} KB)`);
  const leftovers = html.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu);
  console.log(`Pictogramas restantes: ${leftovers ? leftovers.length : 0}`);
}

build();
