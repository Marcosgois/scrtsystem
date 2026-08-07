'use strict';

/*
 * As visões de CONSUMO (MSU) por ano contratual — o assunto do zOTC.
 *
 * Nasceram junto com o relatório de MLC, mas não são de MLC: o MLC responde
 * "quanto se paga" (R$), estas respondem "quanto se consome" (MSU) e o que isso
 * obriga a fazer no contrato zOTC. Por isso vivem aqui e aparecem na tela de
 * Consumo zOTC.
 *
 *   COMPARATIVO      — Ano 1 × Ano 2 × Ano 3 sobrepostos na régua de 1 a 12.
 *   PLANEJADO        — consumido, planejado e baseline por ano, e a conclusão.
 *
 * O eixo do comparativo é a POSIÇÃO do mês dentro do ano contratual, não o mês
 * do calendário: é o que permite comparar o mesmo ponto do ciclo em anos
 * diferentes. Só uma estrutura com 12 casas fixas garante isso — com `null` onde
 * não houve SCRT, para a posição nunca escorregar.
 */

const { addMonths, labelOf } = require('./mlc');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (parte, todo) => (todo > 0 ? (parte / todo) * 100 : null);
const ehChave = (k) => /^\d{4}-\d{2}$/.test(String(k || ''));

/* Paleta das séries de ano — a mesma ordem em todo lugar (tela e slide), para
   "a linha laranja" querer dizer o mesmo ano nos dois. */
const CORES_ANO = ['0F62FE', 'FF832B', '198038', '8A3FFC', '009D9A', 'B28600'];

const faixa = (de, ate) => (de && ate ? `${labelOf(de)} a ${labelOf(ate)}` : '—');

/**
 * Os anos contratuais do cliente, cada um com 12 casas de consumo.
 *
 * Diferente do MLC, aqui NÃO se exige contrato de preço cadastrado: basta o mês
 * de início do ano contratual. Um cliente que ainda não tem MLC configurado
 * continua tendo ano contratual — e é justamente ele que precisa enxergar o
 * consumo contra o baseline.
 *
 * @param {{ startPeriodKey: string, years?: Array }} contrato
 * @param {object} consumoByPeriod periodKey -> MSU
 */
function anosDeConsumo(contrato, consumoByPeriod) {
  const start = contrato && contrato.startPeriodKey;
  if (!ehChave(start)) return [];

  const consumoDe = (k) => {
    if (!consumoByPeriod) return null;
    const v = consumoByPeriod instanceof Map ? consumoByPeriod.get(k) : consumoByPeriod[k];
    return v == null ? null : Number(v);
  };

  /* Quantos anos desenhar: os cadastrados, e no mínimo o suficiente para cobrir
     o último mês com SCRT. Sem isso, um cliente com anos de consumo e nenhum ano
     de contrato cadastrado veria uma tela vazia. */
  const cadastrados = (contrato && contrato.years) || [];
  const chaves = Object.keys(consumoByPeriod || {}).filter(ehChave).sort();
  const ultimo = chaves[chaves.length - 1];
  const abs = (k) => { const [y, m] = k.split('-').map(Number); return y * 12 + (m - 1); };
  const necessarios = ultimo && abs(ultimo) >= abs(start)
    ? Math.floor((abs(ultimo) - abs(start)) / 12) + 1
    : 0;
  const total = Math.max(cadastrados.length, necessarios);
  if (!total) return [];

  return Array.from({ length: total }, (_, i) => {
    const yr = cadastrados[i] || {};
    const months = [];
    for (let mi = 0; mi < 12; mi++) {
      const periodKey = addMonths(start, i * 12 + mi);
      const consumedMsu = consumoDe(periodKey);
      months.push({
        periodKey,
        label: labelOf(periodKey),
        consumedMsu,
        source: consumedMsu == null ? null : 'scrt',
      });
    }
    const comDados = months.filter((m) => m.source === 'scrt');
    return {
      label: yr.label || `Ano ${i + 1}`,
      firstPeriodKey: months[0].periodKey,
      lastPeriodKey: months[months.length - 1].periodKey,
      months,
      totals: {
        monthsWithScrt: comDados.length,
        monthsInYear: 12,
        consumedMsu: comDados.reduce((a, m) => a + (m.consumedMsu || 0), 0),
      },
      cadastro: yr,
    };
  });
}

/** Baseline zOTC do ano: o cadastrado, ou o teto único do cliente. */
function baselineZotcDoAno(cadastro, baselinePadraoAnual) {
  const proprio = num(cadastro && cadastro.baselineZotcAnualMsu);
  return proprio > 0 ? proprio : num(baselinePadraoAnual);
}

/* ── Comparativo de anos ─────────────────────────────────────────────────── */

function visaoComparativoAnos(anos, { baselinePadraoAnual = 0 } = {}) {
  const series = (anos || []).map((ano, i) => {
    const cad = ano.cadastro || {};
    const reais = ano.months.map((m) => (m.source === 'scrt' ? m.consumedMsu : null));
    while (reais.length < 12) reais.push(null);
    const comDado = reais.map((v, k) => ({ v, k })).filter((x) => x.v != null);

    /* Ano em curso é completado com o CONSUMO PLANEJADO cadastrado, um doze avos
       por mês que falta — a mesma regra da visão de planejado, para as duas
       contarem a mesma história. Sem planejado cadastrado a linha simplesmente
       para no último SCRT: melhor uma linha curta do que uma linha inventada. */
    const planejadoMes = num(cad.plannedAnnualMsu) / 12;
    const pontos = reais.map((v, k) => {
      if (v != null) return v;
      const depoisDoUltimoReal = comDado.length > 0 && k > comDado[comDado.length - 1].k;
      return depoisDoUltimoReal && planejadoMes > 0 ? planejadoMes : null;
    });
    const preenchidos = pontos.map((v, k) => ({ v, k })).filter((x) => x.v != null);

    return {
      indice: i,
      label: ano.label,
      periodoLabel: faixa(ano.firstPeriodKey, ano.lastPeriodKey),
      cor: CORES_ANO[i % CORES_ANO.length],
      pontos,
      reais,
      mesesComDado: comDado.length,
      mesesPlanejados: preenchidos.length - comDado.length,
      posicaoUltimoReal: comDado.length ? comDado[comDado.length - 1].k + 1 : null,
      emCurso: comDado.length > 0 && comDado.length < 12,
      primeiro: comDado.length ? { posicao: comDado[0].k + 1, valor: comDado[0].v } : null,
      ultimo: preenchidos.length
        ? {
          posicao: preenchidos[preenchidos.length - 1].k + 1,
          valor: preenchidos[preenchidos.length - 1].v,
          planejado: preenchidos.length > comDado.length,
        }
        : null,
      baselineZotcAnualMsu: baselineZotcDoAno(cad, baselinePadraoAnual),
    };
  }).filter((a) => a.mesesComDado > 0);

  if (!series.length) return { anos: [], baseline: null, estouro: null };

  // A régua de referência é a do ano mais recente com dado — é o compromisso vigente.
  const atual = series[series.length - 1];
  const baselineAnual = atual.baselineZotcAnualMsu;
  const baseline = baselineAnual > 0 ? {
    anoIndice: atual.indice,
    anoLabel: atual.label,
    anualMsu: baselineAnual,
    mensalMsu: baselineAnual / 12,
    label: `Média mensal do baseline (${atual.label})`,
  } : null;

  /* "Estouro do baseline": o mês em que o ACUMULADO do ano passa do baseline
     anual — ou seja, o mês em que a franquia do ano acabou. Não é "o mês em que
     o consumo passou da média mensal": num ano que começa acima da média isso
     seria o mês 1, e não diria nada sobre o contrato. */
  let estouro = null;
  if (baseline) {
    let acc = 0;
    for (let k = 0; k < atual.pontos.length; k++) {
      const v = atual.pontos[k];
      if (v == null) continue;
      acc += v;
      if (acc > baseline.anualMsu) {
        estouro = {
          anoIndice: atual.indice,
          anoLabel: atual.label,
          posicao: k + 1,
          valor: v,
          acumuladoMsu: acc,
          planejado: atual.posicaoUltimoReal != null && k + 1 > atual.posicaoUltimoReal,
          texto: `Estouro do Baseline (${atual.label})`,
        };
        break;
      }
    }
  }

  return { anos: series, baseline, estouro };
}

/* ── Consumido × planejado × contratado ──────────────────────────────────── */

function visaoPlanejadoVsContratado(anos, { baselinePadraoAnual = 0 } = {}) {
  const linhas = (anos || []).map((ano, i) => {
    const cad = ano.cadastro || {};
    const planejadoAnual = num(cad.plannedAnnualMsu);
    const baselineZotc = baselineZotcDoAno(cad, baselinePadraoAnual);

    const mesesNoAno = ano.months.length || 12;
    const mesesReais = ano.totals.monthsWithScrt;
    /* Só os meses DEPOIS do último medido são completados pelo planejado.
       Contar `mesesNoAno − mesesReais` incluiria buraco no MEIO do ano, e um mês
       de SCRT perdido viraria "mês que falta" preenchido com previsão: a tabela
       fecharia num total que o gráfico do comparativo não tem. */
    const ultimoRealIdx = ano.months.reduce((acc, m, k) => (m.source === 'scrt' ? k : acc), -1);
    const mesesFaltando = ultimoRealIdx < 0 ? 0 : Math.max(0, mesesNoAno - (ultimoRealIdx + 1));
    const mesesSemScrt = mesesNoAno - mesesReais - mesesFaltando;
    const realMsu = ano.totals.consumedMsu;
    const planejadoRestanteMsu = mesesFaltando > 0 && planejadoAnual > 0
      ? (planejadoAnual / 12) * mesesFaltando
      : 0;
    const consumidasMsu = realMsu + planejadoRestanteMsu;

    return {
      indice: i,
      label: ano.label,
      periodoLabel: faixa(ano.firstPeriodKey, ano.lastPeriodKey),
      planejadoMsu: planejadoAnual,
      baselineZotcMsu: baselineZotc,
      consumidasMsu,
      realMsu,
      planejadoRestanteMsu,
      mesesReais,
      mesesPlanejados: planejadoRestanteMsu > 0 ? mesesFaltando : 0,
      mesesSemScrt,
      mesesNoAno,
      fechado: mesesFaltando === 0,
      estimado: planejadoRestanteMsu > 0,
      parcialSemPlanejado: mesesFaltando > 0 && planejadoRestanteMsu === 0,
      vsPlanejadoPct: pct(consumidasMsu, planejadoAnual),
      vsContratadoPct: pct(consumidasMsu, baselineZotc),
      excedeBaseline: baselineZotc > 0 && consumidasMsu > baselineZotc,
    };
  }).filter((a) => a.realMsu > 0 || a.planejadoMsu > 0);

  /* Destaque: o baseline deste ano é exatamente o consumo do ano anterior — o
     desenho clássico do aditivo que "sobe a curva" para o realizado. */
  for (let i = 1; i < linhas.length; i++) {
    const antes = linhas[i - 1];
    // Tolerância relativa: o aditivo arredonda o número do ano anterior.
    const folga = Math.max(1, antes.consumidasMsu * 0.0005);
    linhas[i].baselineIgualConsumoAnterior =
      antes.consumidasMsu > 0 && Math.abs(linhas[i].baselineZotcMsu - antes.consumidasMsu) <= folga;
  }

  return { anos: linhas, conclusoes: conclusoesDe(linhas), notas: notasDe(linhas) };
}

const msu = (v) => Math.round(num(v)).toLocaleString('pt-BR');
const umaCasa = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A conclusão do relatório, escrita a partir dos números — e só do que eles
 * sustentam. Cada frase carrega os valores que a justificam, para quem estiver
 * na reunião poder conferir na própria tabela.
 */
function conclusoesDe(anos) {
  const out = [];
  if (!anos.length) return out;

  const fechados = anos.filter((a) => a.fechado);
  const estourados = fechados.filter((a) => a.excedeBaseline);
  const atual = anos[anos.length - 1];
  /* Ano SEM baseline cadastrado não tem % nenhuma. Afirmar "nenhum ano
     ultrapassou o baseline" quando não há baseline é pior do que não afirmar
     nada — é o slide dando conformidade contratual de graça. */
  const comBaseline = fechados.filter((a) => a.vsContratadoPct != null);
  const meses = (n) => `${n} ${n === 1 ? 'mês que falta' : 'meses que faltam'}`;

  if (estourados.length) {
    const a = estourados[estourados.length - 1];
    out.push(
      `O ${a.label} consumiu ${msu(a.consumidasMsu)} MSU contra um baseline contratado de `
      + `${msu(a.baselineZotcMsu)} MSU (${umaCasa(a.vsContratadoPct)}%). O excedente de `
      + `${msu(a.consumidasMsu - a.baselineZotcMsu)} MSU precisa ser regularizado por aditivo ao contrato.`
    );
  } else if (comBaseline.length) {
    const pior = comBaseline.reduce((m, a) => (a.vsContratadoPct > m.vsContratadoPct ? a : m));
    out.push(
      `Nenhum ano fechado ultrapassou o baseline contratado. O maior uso foi de `
      + `${umaCasa(pior.vsContratadoPct)}% no ${pior.label} (${msu(pior.consumidasMsu)} de ${msu(pior.baselineZotcMsu)} MSU).`
    );
  } else if (fechados.length) {
    out.push(
      `Não há baseline zOTC cadastrado para os anos deste contrato: o consumo não pôde ser confrontado `
      + `com o teto contratual. Informe o baseline do ano no contrato.`
    );
  }

  if (!atual.fechado && atual.estimado && atual.excedeBaseline) {
    out.push(
      `Com o consumo planejado para ${meses(atual.mesesPlanejados)}, o ${atual.label} chega a `
      + `${msu(atual.consumidasMsu)} MSU — ${umaCasa(atual.vsContratadoPct)}% do baseline de `
      + `${msu(atual.baselineZotcMsu)} MSU. Será necessário aditivar o contrato antes do fim do ano.`
    );
  } else if (!atual.fechado && atual.estimado && atual.vsContratadoPct != null) {
    out.push(
      `Com o consumo planejado para ${meses(atual.mesesPlanejados)}, o ${atual.label} fecha em `
      + `${msu(atual.consumidasMsu)} MSU, dentro do baseline de ${msu(atual.baselineZotcMsu)} MSU `
      + `(${umaCasa(atual.vsContratadoPct)}%).`
    );
  } else if (!atual.fechado && atual.estimado) {
    out.push(
      `Com o consumo planejado para ${meses(atual.mesesPlanejados)}, o ${atual.label} fecha em `
      + `${msu(atual.consumidasMsu)} MSU. Sem baseline zOTC cadastrado, não há teto para comparar.`
    );
  } else if (atual.parcialSemPlanejado) {
    out.push(
      `O ${atual.label} tem ${atual.mesesReais} de ${atual.mesesNoAno} meses medidos e não há consumo planejado `
      + `cadastrado: o total do ano ainda não pode ser estimado.`
    );
  }

  // Crescimento entre os dois últimos anos comparáveis (ambos com 12 meses).
  const comparaveis = anos.filter((a) => a.fechado);
  if (comparaveis.length >= 2) {
    const b = comparaveis[comparaveis.length - 1];
    const a = comparaveis[comparaveis.length - 2];
    if (a.consumidasMsu > 0) {
      const cresc = ((b.consumidasMsu - a.consumidasMsu) / a.consumidasMsu) * 100;
      out.push(
        `Do ${a.label} para o ${b.label} o consumo ${cresc >= 0 ? 'cresceu' : 'caiu'} `
        + `${umaCasa(Math.abs(cresc))}% (${msu(a.consumidasMsu)} → ${msu(b.consumidasMsu)} MSU).`
      );
    }
  }

  const desalinhado = anos.filter((a) => a.planejadoMsu > 0 && a.vsPlanejadoPct != null && a.vsPlanejadoPct > 100);
  if (desalinhado.length) {
    const a = desalinhado[desalinhado.length - 1];
    out.push(
      `O consumo do ${a.label} ficou ${umaCasa(a.vsPlanejadoPct - 100)}% acima do planejado `
      + `(${msu(a.consumidasMsu)} contra ${msu(a.planejadoMsu)} MSU): a curva de crescimento usada no `
      + `planejamento está abaixo do realizado.`
    );
  }

  return out;
}

/** Notas de rodapé numeradas, na ordem em que aparecem na tabela. */
function notasDe(anos) {
  const notas = [];
  const marca = () => `(${notas.length + 1})`;
  if (anos.some((a) => a.baselineIgualConsumoAnterior)) {
    notas.push({ marca: marca(), texto: 'A ser regularizado via aditivo ao contrato.', tipo: 'baseline' });
  }
  if (anos.some((a) => a.estimado)) {
    const a = anos.find((x) => x.estimado);
    notas.push({ marca: marca(), texto: `Consumo estimado (${a.label}): ${a.mesesReais} meses medidos + ${a.mesesPlanejados} meses no consumo planejado.`, tipo: 'estimado' });
  }
  if (anos.some((a) => a.parcialSemPlanejado)) {
    const a = anos.find((x) => x.parcialSemPlanejado);
    notas.push({ marca: marca(), texto: `Ano parcial (${a.label}): ${a.mesesReais} de ${a.mesesNoAno} meses medidos, sem consumo planejado cadastrado.`, tipo: 'parcial' });
  }
  const comBuraco = anos.filter((a) => a.mesesSemScrt > 0);
  if (comBuraco.length) {
    const quais = comBuraco.map((a) => `${a.label} (${a.mesesSemScrt})`).join(', ');
    notas.push({ marca: marca(), texto: `Meses sem SCRT recebido, não estimados: ${quais}. O total do ano é o dos meses medidos.`, tipo: 'buraco' });
  }
  return notas;
}

/**
 * As duas visões de uma vez, no formato que a tela do zOTC e o .pptx consomem.
 * @param {object} contrato { startPeriodKey, years[] }
 * @param {object} consumoByPeriod periodKey -> MSU
 */
function montarVisoesZotc(contrato, consumoByPeriod, { baselinePadraoAnual = 0 } = {}) {
  const anos = anosDeConsumo(contrato, consumoByPeriod);
  return {
    temAnoContratual: anos.length > 0,
    comparativo: visaoComparativoAnos(anos, { baselinePadraoAnual }),
    planejado: visaoPlanejadoVsContratado(anos, { baselinePadraoAnual }),
  };
}

module.exports = {
  montarVisoesZotc,
  anosDeConsumo,
  visaoComparativoAnos,
  visaoPlanejadoVsContratado,
  conclusoesDe,
  baselineZotcDoAno,
  CORES_ANO,
};
