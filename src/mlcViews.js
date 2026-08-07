'use strict';

/*
 * As três visões do MLC que vão para a reunião com o cliente.
 *
 * Nenhuma delas recalcula fatura: todas leem o que computeMlcView (src/mlc.js) já
 * produziu mês a mês. O que este módulo faz é FECHAR e ROTULAR — somar o ano,
 * confrontar com os tetos contratados, alinhar anos diferentes na mesma régua de
 * 1 a 12 e escrever a conclusão. Assim a tela e o .pptx nunca discordam da conta.
 *
 *   1. ANO DE MLC (R$)      — os 12 meses do ano, com o CAP contratado e o CBA.
 *   2. COMPARATIVO DE ANOS  — Ano 1 × Ano 2 × Ano 3 sobrepostos em MSU.
 *   3. PLANEJADO × CONTRATADO — consumido, planejado e baseline por ano, e o que
 *                               isso obriga a fazer no contrato.
 *
 * DEFASAGEM MED/INV. O mês MEDIDO (o do SCRT) aparece no inventário/fatura alguns
 * meses depois: "Med/Jun 25" vira "Inv/Ago 25". Isso é ROTULAGEM, não conta — o
 * valor do mês continua sendo o do mês medido, e o total confrontado com o CAP é o
 * dos 12 meses medidos. Foi assim que a planilha de origem apurou (o mesmo
 * 266.849.449,67 aparece como total da tabela e como "Total CAP Consumido").
 *
 * ANO EM CURSO. Ano que ainda não fechou é completado com o CONSUMO PLANEJADO
 * cadastrado (plannedAnnualMsu / 12 por mês que falta) — não com a projeção
 * estatística do capacity planning. São coisas diferentes: planejado é número que
 * o cliente entrega, projeção é número que o modelo calcula.
 */

const { addMonths, labelOf, MESES_PT } = require('./mlc');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (parte, todo) => (todo > 0 ? (parte / todo) * 100 : null);

/* Paleta das séries de ano — a mesma ordem em todo lugar (tela e slide), para
   "a linha laranja" querer dizer o mesmo ano nos dois. */
const CORES_ANO = ['0F62FE', 'FF832B', '198038', '8A3FFC', '009D9A', 'B28600'];

/** "2025-06" + lag -> { key, label } do mês de inventário. */
function mesDeInventario(periodKey, lag) {
  const key = addMonths(periodKey, Math.round(num(lag)));
  return { key, label: labelOf(key) };
}

/** "Jun/25 a Mai/26" */
const faixa = (de, ate) => (de && ate ? `${labelOf(de)} a ${labelOf(ate)}` : '—');

/** Rótulo do CBA do ano: um só, ou a faixa quando um aditivo mudou no meio. */
function rotuloCba(ano) {
  const vistos = [...new Set(ano.months.map((m) => num(m.cbaPct)))];
  const fmt = (p) => `${(p * 100).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}%`;
  if (vistos.length <= 1) return fmt(vistos[0] || 0);
  return `${fmt(vistos[0])} a ${fmt(vistos[vistos.length - 1])}`;
}

/* ── 1. Ano de MLC em R$ ─────────────────────────────────────────────────── */

/**
 * Fecha um ano do MLC: os 12 meses em R$, o total e o confronto com o CAP.
 * @param {object} view resultado de computeMlcView
 * @param {number} indice índice do ano (0-based)
 * @param {{ lag?: number, cadastro?: object }} opts `cadastro` é o year cru do
 *        contrato, de onde saem capAnualRs / capCbaRs (a view não os carrega).
 */
function visaoAnoMlc(view, indice, { lag = 2, cadastro = null } = {}) {
  const ano = view && view.years && view.years[indice];
  if (!ano) return null;

  const colunas = ano.months.map((m) => {
    const inv = mesDeInventario(m.periodKey, lag);
    return {
      medPeriodKey: m.periodKey,
      medLabel: m.label,
      invPeriodKey: inv.key,
      invLabel: inv.label,
      temScrt: m.source === 'scrt',
      consumoRs: m.monthlyWithGrowthRs,
      comCbaRs: m.withCbaRs,
      consumedMsu: m.consumedMsu,
      cbaPct: m.cbaPct,
    };
  });

  const totais = {
    consumoRs: ano.totals.monthlyWithGrowthRs,
    comCbaRs: ano.totals.withCbaRs,
    consumedMsu: ano.totals.consumedMsu,
    mesesComScrt: ano.totals.monthsWithScrt,
    mesesNoAno: colunas.length,
    fechado: ano.totals.monthsWithScrt === colunas.length,
  };

  const primeiraInv = colunas.length ? colunas[0].invPeriodKey : null;
  const ultimaInv = colunas.length ? colunas[colunas.length - 1].invPeriodKey : null;

  /* O CAP é opcional. Sem ele cadastrado o bloco inteiro some da tela e do slide —
     mostrar "Saldo: −266.849.449,67" porque o teto ficou em zero seria pior do que
     não mostrar nada. */
  const capAnualRs = num(cadastro && cadastro.capAnualRs);
  const capCbaRs = num(cadastro && cadastro.capCbaRs);
  const cap = capAnualRs > 0 ? {
    anualRs: capAnualRs,
    mensalRs: capAnualRs / 12,
    consumidoRs: totais.consumoRs,
    saldoRs: capAnualRs - totais.consumoRs,
    usoPct: pct(totais.consumoRs, capAnualRs),
    estourado: totais.consumoRs > capAnualRs,
    // A janela do CAP é a de INVENTÁRIO: é quando as faturas caem.
    janelaLabel: faixa(primeiraInv, ultimaInv),
    cba: capCbaRs > 0 ? {
      anualRs: capCbaRs,
      consumidoRs: totais.comCbaRs,
      saldoRs: capCbaRs - totais.comCbaRs,
      usoPct: pct(totais.comCbaRs, capCbaRs),
      estourado: totais.comCbaRs > capCbaRs,
      // O desconto que os dois tetos negociados implicam — quase 19%, nunca exato.
      descontoPct: pct(capAnualRs - capCbaRs, capAnualRs),
    } : null,
  } : null;

  return {
    indice,
    label: ano.label,
    firstPeriodKey: ano.firstPeriodKey,
    lastPeriodKey: ano.lastPeriodKey,
    periodoLabel: faixa(ano.firstPeriodKey, ano.lastPeriodKey),
    invFirstPeriodKey: primeiraInv,
    invLastPeriodKey: ultimaInv,
    invPeriodoLabel: faixa(primeiraInv, ultimaInv),
    lagMonths: Math.round(num(lag)),
    cbaLabel: rotuloCba(ano),
    baselineMensalMsu: ano.baselineMensalMsu,
    baselineAnnualMsu: ano.baselineAnnualMsu,
    temVariacaoDePreco: ano.temVariacao,
    trechos: ano.trechos,
    colunas,
    totais,
    cap,
  };
}

/* ── 2. Comparativo de anos (MSU) ────────────────────────────────────────── */

/** Baseline zOTC do ano: o cadastrado, ou o teto único do cliente. */
function baselineZotcDoAno(cadastro, baselinePadraoAnual) {
  const proprio = num(cadastro && cadastro.baselineZotcAnualMsu);
  return proprio > 0 ? proprio : num(baselinePadraoAnual);
}

/**
 * Ano 1 × Ano 2 × Ano 3 na mesma régua de 1 a 12.
 *
 * O eixo é a POSIÇÃO dentro do ano contratual, não o mês do calendário — é o que
 * permite ver "o mês 7 deste ano contra o mês 7 do ano passado". Só a estrutura
 * de computeMlcView garante isso: ela sempre gera 12 casas, com null onde não
 * houve SCRT, então a posição nunca escorrega.
 */
function visaoComparativoAnos(view, { anosCadastro = [], baselinePadraoAnual = 0 } = {}) {
  const anos = ((view && view.years) || []).map((ano, i) => {
    const reais = ano.months.map((m) => (m.source === 'scrt' ? m.consumedMsu : null));
    while (reais.length < 12) reais.push(null);
    const comDado = reais.map((v, k) => ({ v, k })).filter((x) => x.v != null);

    /* Ano em curso é completado com o CONSUMO PLANEJADO cadastrado, um doze avos
       por mês que falta — a mesma regra da visão 3, para as duas contarem a mesma
       história. Sem planejado cadastrado a linha simplesmente para no último SCRT:
       melhor uma linha curta do que uma linha inventada. */
    const planejadoMes = num(anosCadastro[i] && anosCadastro[i].plannedAnnualMsu) / 12;
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
      pontos,                                    // real + planejado (o que o gráfico desenha)
      reais,                                     // só o que veio de SCRT
      mesesComDado: comDado.length,
      mesesPlanejados: preenchidos.length - comDado.length,
      // Onde a linha deixa de ser medida e passa a ser planejada (1-based; null = tudo medido).
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
      baselineZotcAnualMsu: baselineZotcDoAno(anosCadastro[i], baselinePadraoAnual),
    };
  }).filter((a) => a.mesesComDado > 0);

  if (!anos.length) return { anos: [], baseline: null, estouro: null };

  // A régua de referência é a do ano mais recente com dado — é o compromisso vigente.
  const atual = anos[anos.length - 1];
  const baselineAnual = atual.baselineZotcAnualMsu;
  const baseline = baselineAnual > 0 ? {
    anoIndice: atual.indice,
    anoLabel: atual.label,
    anualMsu: baselineAnual,
    mensalMsu: baselineAnual / 12,
    label: `Média mensal do baseline ajustado (${atual.label})`,
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
          // Marca se o mês do estouro já aconteceu ou é do trecho planejado — a
          // diferença entre "estourou" e "vai estourar" muda a conversa.
          planejado: atual.posicaoUltimoReal != null && k + 1 > atual.posicaoUltimoReal,
          texto: `Estouro do Baseline (${atual.label})`,
        };
        break;
      }
    }
  }

  return { anos, baseline, estouro, meses: MESES_PT };
}

/* ── 3. Planejado × Contratado × Consumido ───────────────────────────────── */

/**
 * Uma linha por ano contratual: o que foi planejado, o que o contrato cobre e o
 * que de fato foi consumido — e o que isso obriga a fazer.
 *
 * Ano que ainda não fechou é completado com o consumo PLANEJADO dos meses que
 * faltam (plannedAnnualMsu / 12 cada), e a linha é marcada como estimada. Sem
 * planejado cadastrado o ano fica com o real e é marcado como parcial: melhor
 * mostrar um ano incompleto do que inventar um cheio.
 */
function visaoPlanejadoVsContratado(view, { anosCadastro = [], baselinePadraoAnual = 0 } = {}) {
  const anos = ((view && view.years) || []).map((ano, i) => {
    const cad = anosCadastro[i] || {};
    const planejadoAnual = num(cad.plannedAnnualMsu);
    const baselineZotc = baselineZotcDoAno(cad, baselinePadraoAnual);

    const mesesNoAno = ano.months.length || 12;
    const mesesReais = ano.totals.monthsWithScrt;
    /* Só os meses DEPOIS do último medido são completados pelo planejado — a
       mesma regra da visão 2, para as duas contarem a mesma história.
       Contar `mesesNoAno − mesesReais` incluiria buraco no MEIO do ano, e um mês
       de SCRT perdido em 2023 viraria "mês que falta" preenchido com previsão:
       a tabela do slide 3 fecharia num total que o gráfico do slide 2 não tem. */
    const ultimoRealIdx = ano.months.reduce((acc, m, k) => (m.source === 'scrt' ? k : acc), -1);
    const mesesFaltando = ultimoRealIdx < 0 ? 0 : Math.max(0, mesesNoAno - (ultimoRealIdx + 1));
    const mesesSemScrt = mesesNoAno - mesesReais - mesesFaltando; // buracos no meio
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
      // Meses sem SCRT no MEIO do ano: não são estimados, só declarados.
      mesesSemScrt,
      mesesNoAno,
      fechado: mesesFaltando === 0,
      estimado: planejadoRestanteMsu > 0,
      // Ano em curso SEM planejado cadastrado: o total é só o que já veio de SCRT.
      parcialSemPlanejado: mesesFaltando > 0 && planejadoRestanteMsu === 0,
      vsPlanejadoPct: pct(consumidasMsu, planejadoAnual),
      vsContratadoPct: pct(consumidasMsu, baselineZotc),
      excedeBaseline: baselineZotc > 0 && consumidasMsu > baselineZotc,
    };
  }).filter((a) => a.realMsu > 0 || a.planejadoMsu > 0);

  /* Destaque: o baseline deste ano é exatamente o consumo do ano anterior — o
     desenho clássico do aditivo que "sobe a curva" para o realizado. */
  for (let i = 1; i < anos.length; i++) {
    const antes = anos[i - 1];
    // Tolerância relativa: o aditivo arredonda o número do ano anterior, então
    // exigir igualdade ao MSU faria o destaque nunca aparecer no caso real.
    const folga = Math.max(1, antes.consumidasMsu * 0.0005);
    anos[i].baselineIgualConsumoAnterior =
      antes.consumidasMsu > 0 && Math.abs(anos[i].baselineZotcMsu - antes.consumidasMsu) <= folga;
  }

  return { anos, conclusoes: conclusoesDe(anos), notas: notasDe(anos) };
}

const msu = (v) => Math.round(num(v)).toLocaleString('pt-BR');
const umaCasa = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A conclusão do relatório, escrita a partir dos números — e só do que eles
 * sustentam. Cada frase carrega os valores que a justificam, para quem estiver na
 * reunião poder conferir na própria tabela.
 */
function conclusoesDe(anos) {
  const out = [];
  if (!anos.length) return out;

  const fechados = anos.filter((a) => a.fechado);
  const estourados = fechados.filter((a) => a.excedeBaseline);
  const atual = anos[anos.length - 1];
  /* Ano SEM baseline zOTC cadastrado não tem % nenhuma: pct() devolve null e
     umaCasa(null) imprimiria "0,00". Afirmar "nenhum ano ultrapassou o baseline"
     quando não há baseline é pior do que não afirmar nada — é o slide dando
     conformidade contratual de graça. */
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
      + `com o teto contratual. Informe o baseline do ano no contrato de MLC.`
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
  /* Buraco de SCRT no meio do ano NÃO é preenchido — mas o total sairia menor
     sem explicação, e ninguém procuraria o motivo. */
  const comBuraco = anos.filter((a) => a.mesesSemScrt > 0);
  if (comBuraco.length) {
    const quais = comBuraco.map((a) => `${a.label} (${a.mesesSemScrt})`).join(', ');
    notas.push({ marca: marca(), texto: `Meses sem SCRT recebido, não estimados: ${quais}. O total do ano é o dos meses medidos.`, tipo: 'buraco' });
  }
  return notas;
}

/**
 * As três visões de uma vez, no formato que a tela e o .pptx consomem.
 * @param {object} view resultado de computeMlcView
 * @param {object} contract o contrato cru (de onde vêm os campos de cadastro)
 * @param {{ lag?: number, baselinePadraoAnual?: number, ano?: number }} opts
 */
function montarVisoes(view, contract, { lag = 2, baselinePadraoAnual = 0, ano = null } = {}) {
  const anosCadastro = (contract && contract.years) || [];
  const total = ((view && view.years) || []).length;
  // Sem ano escolhido, abre no último com SCRT — é o que interessa numa reunião.
  const comDados = ((view && view.years) || [])
    .map((y, i) => ({ i, n: y.totals.monthsWithScrt }))
    .filter((x) => x.n > 0);
  const escolhido = Number.isInteger(ano) && ano >= 0 && ano < total
    ? ano
    : (comDados.length ? comDados[comDados.length - 1].i : 0);

  return {
    anoSelecionado: escolhido,
    anosDisponiveis: ((view && view.years) || []).map((y, i) => ({
      indice: i,
      label: y.label,
      periodoLabel: faixa(y.firstPeriodKey, y.lastPeriodKey),
      mesesComScrt: y.totals.monthsWithScrt,
    })),
    anoMlc: visaoAnoMlc(view, escolhido, { lag, cadastro: anosCadastro[escolhido] }),
    comparativo: visaoComparativoAnos(view, { anosCadastro, baselinePadraoAnual }),
    planejado: visaoPlanejadoVsContratado(view, { anosCadastro, baselinePadraoAnual }),
  };
}

module.exports = {
  montarVisoes,
  visaoAnoMlc,
  visaoComparativoAnos,
  visaoPlanejadoVsContratado,
  conclusoesDe,
  mesDeInventario,
  baselineZotcDoAno,
  rotuloCba,
  CORES_ANO,
};
