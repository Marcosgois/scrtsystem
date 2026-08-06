'use strict';

/*
 * Converte o "Configuration Summary" do zPCR (CheatSheet*.html que o zPCR salva)
 * no src/data/lspr.json que o servidor carrega.
 *
 *   node scripts/parse-lspr-cheatsheet.js <arquivo.html> [--write] [--json saida.json]
 *
 * Sem --write só compara com o lspr.json atual e imprime o diff (modelos novos,
 * sumidos e com número diferente) — é assim que se confere se o banco está
 * atualizado quando a IBM publica uma versão nova do zPCR.
 *
 * O arquivo do zPCR é uma sequência de tabelas, uma por família ("IBM Z z17/700"),
 * todas com as MESMAS 9 colunas: Model, MIPS, MSU, #Partitions, #CPs, #IFLs,
 * #ICFs, #zAAPs, #zIIPs. O parser é estrito de propósito: se aparecer uma tabela
 * com outro número de colunas ou uma linha que não case, ele PARA em vez de
 * gravar um dado pela metade — dado de capacidade errado no banco vira proposta
 * comercial errada.
 */

const fs = require('fs');
const path = require('path');

const ARQ_JSON = path.join(__dirname, '..', 'src', 'data', 'lspr.json');

const COLUNAS = ['model', 'mips', 'msu', 'partitions', 'cps', 'ifls', 'icfs', 'zaaps', 'ziips'];

const semTags = (s) => s.replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8482;/g, '™')
  .trim();

/** "2,477" -> 2477 · "" / "-" -> null */
function numero(txt) {
  const t = String(txt).replace(/,/g, '').trim();
  if (!t || t === '-' || t === '—' || t === 'n/a') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Geração a partir do nome da família ("IBM Z z17/700" -> "z17").
 * As famílias LinuxONE não trazem a geração no nome ("LinuxONE Emperor 5
 * 9175/400"), então elas herdam a geração pelo machine type — daí este parser
 * rodar em duas passadas.
 */
function geracaoDaFamilia(family) {
  const base = family.split('/')[0].trim();
  if (/^LinuxONE/i.test(base)) return null;
  const m = base.match(/^(?:IBM Z|System|zEnterprise)\s+(.+)$/i);
  const nome = (m ? m[1] : base).trim();
  if (/^EC12$/i.test(nome)) return 'zEC12';
  if (/^zBC12$/i.test(nome)) return 'zBC12';
  if (/^196$/.test(nome)) return 'z196';
  return nome;                       // z17, z16, z13s, z114, "z10 EC", "z9 BC"…
}

function parseCheatSheet(html) {
  const linhas = html.split(/<tr\b[^>]*>/i).slice(1);
  const modelos = [];
  const familias = [];
  let familia = null;

  for (const bruto of linhas) {
    const bloco = bruto.split(/<\/tr>/i)[0];

    // Cabeçalho da família: <th colspan=9>…IBM Z z17/700…</th>
    const cab = bloco.match(/<th[^>]*colspan=(\d+)[^>]*>([\s\S]*?)<\/th>/i);
    if (cab) {
      if (Number(cab[1]) !== COLUNAS.length) {
        throw new Error(`tabela com ${cab[1]} colunas (esperado ${COLUNAS.length}): ${semTags(cab[2])}`);
      }
      familia = semTags(cab[2]);
      familias.push(familia);
      continue;
    }
    if (/<th\b/i.test(bloco)) continue;           // linha de rótulo das colunas

    const celulas = [...bloco.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => semTags(c[1]));
    if (!celulas.length) continue;
    if (!familia) throw new Error(`linha de dados antes de qualquer família: ${celulas.join(' | ')}`);
    if (celulas.length !== COLUNAS.length) {
      throw new Error(`linha com ${celulas.length} células em "${familia}": ${celulas.join(' | ')}`);
    }

    // O próprio zPCR desempata o modelo que aparece nas duas tabelas (9175-401 em
    // "IBM Z z17/400" e em "LinuxONE Emperor 5") com o sufixo _L. Não somos nós
    // que inventamos o sufixo — ele vem do arquivo.
    const modelo = celulas[0];
    if (!/^[0-9]{4}-[A-Z0-9]{2,4}(_[A-Z])?$/.test(modelo)) {
      throw new Error(`modelo fora do padrão NNNN-XXX em "${familia}": ${modelo}`);
    }
    const reg = { model: modelo, machineType: modelo.split('-')[0], generation: '', family: familia };
    COLUNAS.slice(1).forEach((c, i) => { reg[c] = numero(celulas[i + 1]); });
    modelos.push(reg);
  }

  // 2ª passada: geração. As famílias IBM Z trazem no nome; as LinuxONE herdam
  // pelo machine type (9175 -> z17), que é como a tabela atual foi montada.
  const porTipo = new Map();
  for (const m of modelos) {
    const g = geracaoDaFamilia(m.family);
    if (g && !porTipo.has(m.machineType)) porTipo.set(m.machineType, g);
  }
  for (const m of modelos) {
    m.generation = geracaoDaFamilia(m.family) || porTipo.get(m.machineType) || '';
    if (!m.generation) throw new Error(`sem geração para ${m.model} (${m.family})`);
  }

  // `model` é chave única no banco: uma repetição aqui viraria perda silenciosa
  // de linha no insertMany(ordered:false).
  const chaves = new Set();
  for (const m of modelos) {
    if (chaves.has(m.model)) throw new Error(`modelo duplicado no arquivo: ${m.model} (${m.family})`);
    chaves.add(m.model);
  }

  return { modelos, familias };
}

/* ── Diff contra o lspr.json atual ───────────────────────────────────────── */
const CAMPOS = ['mips', 'msu', 'partitions', 'cps', 'ifls', 'icfs', 'zaaps', 'ziips', 'family', 'generation', 'machineType'];

function comparar(atuais, novos) {
  const a = new Map(atuais.map((m) => [m.model, m]));
  const n = new Map(novos.map((m) => [m.model, m]));
  const adicionados = novos.filter((m) => !a.has(m.model));
  const removidos = atuais.filter((m) => !n.has(m.model));
  const alterados = [];
  for (const [k, novo] of n) {
    const velho = a.get(k);
    if (!velho) continue;
    const difs = CAMPOS.filter((c) => (velho[c] ?? null) !== (novo[c] ?? null))
      .map((c) => ({ campo: c, de: velho[c] ?? null, para: novo[c] ?? null }));
    if (difs.length) alterados.push({ model: k, family: novo.family, difs });
  }
  return { adicionados, removidos, alterados };
}

function main() {
  const args = process.argv.slice(2);
  const arquivo = args.find((a) => !a.startsWith('--'));
  if (!arquivo) {
    console.error('uso: node scripts/parse-lspr-cheatsheet.js <CheatSheet.html> [--write] [--json saida.json]');
    process.exit(2);
  }
  const gravar = args.includes('--write');
  const saidaIdx = args.indexOf('--json');
  const saida = saidaIdx >= 0 ? args[saidaIdx + 1] : null;

  const { modelos, familias } = parseCheatSheet(fs.readFileSync(arquivo, 'utf8'));
  console.log(`Arquivo: ${arquivo}`);
  console.log(`  ${familias.length} família(s), ${modelos.length} modelo(s).`);

  const atualRaw = JSON.parse(fs.readFileSync(ARQ_JSON, 'utf8'));
  const atuais = atualRaw.models || atualRaw;
  console.log(`Banco/arquivo atual: ${new Set(atuais.map((m) => m.family)).size} família(s), ${atuais.length} modelo(s).\n`);

  const { adicionados, removidos, alterados } = comparar(atuais, modelos);
  console.log(`+ ${adicionados.length} modelo(s) NOVO(S)`);
  console.log(`- ${removidos.length} modelo(s) que sumiram`);
  console.log(`~ ${alterados.length} modelo(s) com número diferente`);

  const porFamilia = (lista) => {
    const m = new Map();
    for (const x of lista) m.set(x.family, (m.get(x.family) || 0) + 1);
    return [...m.entries()].sort((p, q) => q[1] - p[1]);
  };
  if (adicionados.length) {
    console.log('\nNOVOS por família:');
    for (const [f, n] of porFamilia(adicionados)) console.log(`  ${String(n).padStart(4)}  ${f}`);
  }
  if (removidos.length) {
    console.log('\nSUMIRAM por família:');
    for (const [f, n] of porFamilia(removidos)) console.log(`  ${String(n).padStart(4)}  ${f}`);
  }
  if (alterados.length) {
    console.log('\nALTERADOS (até 40):');
    for (const x of alterados.slice(0, 40)) {
      console.log(`  ${x.model.padEnd(12)} ${x.difs.map((d) => `${d.campo}: ${d.de} -> ${d.para}`).join(' · ')}`);
    }
    if (alterados.length > 40) console.log(`  … e mais ${alterados.length - 40}.`);
  }

  // Procedência: o zPCR exporta o CheatSheet com nome temporário e sem número de
  // versão em lugar nenhum do HTML. O que identifica a versão, então, é a data do
  // arquivo somada à geração mais nova que ele traz — é isso que responde "essa
  // tabela já conhece o z17 ME2?" sem precisar reabrir o zPCR.
  const geracoes = [...new Set(modelos.map((m) => m.generation))];
  const tipos = [...new Set(modelos.map((m) => m.machineType))].sort();
  const conteudo = {
    source: atualRaw.source || 'IBM Z zPCR Configuration Summary (LSPR)',
    generatedFrom: 'CP3000 / Configuration Summary',
    sourceFile: path.basename(arquivo),
    exportedAt: fs.statSync(arquivo).mtime.toISOString().slice(0, 10),
    count: modelos.length,
    machineTypes: tipos,
    generations: geracoes,
    models: modelos,
  };
  if (saida) { fs.writeFileSync(saida, `${JSON.stringify(conteudo, null, 0)}\n`); console.log(`\nJSON gravado em ${saida}`); }
  if (gravar) { fs.writeFileSync(ARQ_JSON, `${JSON.stringify(conteudo, null, 0)}\n`); console.log(`\n${ARQ_JSON} ATUALIZADO — rode "npm run import:lspr" para levar ao banco.`); }
  if (!saida && !gravar) console.log('\n(nada foi gravado — use --write para atualizar src/data/lspr.json)');
}

if (require.main === module) main();
module.exports = { parseCheatSheet, comparar, geracaoDaFamilia, numero };
