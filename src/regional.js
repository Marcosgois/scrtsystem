'use strict';

/*
 * Agregação do painel gerencial: dado um recorte de clientes (uma região com as
 * descendentes, ou uma seleção avulsa), responde consumo total de MSU, evolução
 * mês a mês, top 5 clientes, parque instalado por geração e o agregado de MLC.
 *
 * REGRA QUE NÃO PODE SER QUEBRADA: o consumo faturável de cada cliente depende
 * das TAGS DE MÁQUINA dele — máquina de tag ignorada (dev/test) sai da conta. Por
 * isso o cálculo é feito POR CLIENTE, com o mergeByMonth e o tagContextOf da tela
 * individual, e só DEPOIS somado. Somar os relatórios crus daria um total maior e
 * o painel não bateria com a soma das telas de cliente.
 *
 * Funções puras (recebem os dados já lidos do banco) para poderem ser testadas
 * sem subir servidor.
 */

const id = (v) => (v == null ? null : String(v && v._id ? v._id : v));

/**
 * Série mensal faturável de UM cliente, com a mesma regra da tela dele.
 * @returns Map periodKey -> MSU faturável
 */
function serieDoCliente(client, reports, { mergeByMonth, tagContextOf }) {
  const meses = mergeByMonth(reports || [], tagContextOf(client));
  const m = new Map();
  for (const r of meses) m.set(r.periodKey, Number(r.totalMsuConsumed) || 0);
  return m;
}

/**
 * Consumo do recorte: total, evolução mensal e ranking de clientes.
 *
 * @param clients  [{ _id, name, machineTags, machineTagDefs }]
 * @param reportsByClient  Map clientId -> [relatórios do cliente]
 * @param helpers  { mergeByMonth, tagContextOf } vindos do routes.js
 * @param meses    janela do ranking (padrão 12 últimos meses com dado)
 */
function agregarConsumo(clients, reportsByClient, helpers, { meses = 12 } = {}) {
  const porCliente = new Map();
  const totaisMes = new Map();

  for (const c of clients) {
    const serie = serieDoCliente(c, reportsByClient.get(id(c)) || [], helpers);
    porCliente.set(id(c), serie);
    for (const [k, v] of serie) totaisMes.set(k, (totaisMes.get(k) || 0) + v);
  }

  const chaves = [...totaisMes.keys()].sort();
  const evolucao = chaves.map((k) => ({ periodKey: k, totalMsuConsumed: totaisMes.get(k) }));

  // Janela do ranking: os N últimos meses que TÊM dado (não os N do calendário),
  // senão um mês ainda sem SCRT zeraria a comparação entre clientes.
  const janela = new Set(chaves.slice(-meses));
  const ranking = clients.map((c) => {
    const serie = porCliente.get(id(c)) || new Map();
    let total = 0;
    for (const k of janela) total += serie.get(k) || 0;
    return { clientId: id(c), name: c.name, totalMsuConsumed: total, mesesComDado: [...serie.keys()].filter((k) => janela.has(k)).length };
  }).sort((a, b) => b.totalMsuConsumed - a.totalMsuConsumed);

  const totalJanela = ranking.reduce((a, r) => a + r.totalMsuConsumed, 0);
  for (const r of ranking) r.pctDoTotal = totalJanela > 0 ? (r.totalMsuConsumed / totalJanela) * 100 : 0;

  return {
    evolucao,
    ultimoPeriodKey: chaves.length ? chaves[chaves.length - 1] : null,
    totalUltimoMes: chaves.length ? totaisMes.get(chaves[chaves.length - 1]) : 0,
    janelaMeses: [...janela].sort(),
    totalJanela,
    ranking,
    top5: ranking.slice(0, 5),
  };
}

/**
 * Type (código de 4 dígitos) da máquina — a chave da tabela de ciclo de vida.
 *
 * `model` é texto livre e cada cliente preencheu de um jeito: o BB gravou
 * "IBM Z z16/700" e a CAIXA gravou "3931". Quem tem o código sempre é o
 * `lsprModel` ("3931-7C9"), então ele vem primeiro; sem ele, aceita-se o modelo
 * quando ele COMEÇA com o código ("3931", "3931-7C6"). Um 4 dígitos no meio do
 * texto não serve: "IBM z16 2022" traria 2022, que é o type do z900. Sem nenhum
 * dos dois não dá para cruzar com o ciclo de vida — devolve null e a máquina cai
 * no grupo "sem ciclo de vida" com o texto que o cliente digitou.
 */
function typeDaMaquina(m) {
  const doLspr = String(m.lsprModel || '').trim().split('-')[0].trim();
  if (/^\d{4}$/.test(doLspr)) return doLspr;
  const doModel = String(m.model || '').trim().match(/^(\d{4})\b/);
  return doModel ? doModel[1] : null;
}

/**
 * Parque instalado por geração, cruzando o type da máquina com a tabela de
 * ciclo de vida IBM.
 *
 * `hoje` entra por parâmetro (e não Date.now() aqui dentro) para o teste poder
 * fixar a data e não ficar dependendo do dia em que roda.
 */
function agregarParque(machines, lifecycles, { hoje = new Date().toISOString().slice(0, 10) } = {}) {
  const porType = new Map();
  for (const l of lifecycles || []) {
    // Um type pode ter mais de um model (2064 = z900 G1 e G2). Para o parque
    // interessa a geração, então basta o primeiro que casar.
    if (!porType.has(String(l.type))) porType.set(String(l.type), l);
  }

  const grupos = new Map();
  for (const m of machines || []) {
    if (m.status === 'substituida' || m.status === 'desativada') continue;   // fora do parque vivo
    const type = typeDaMaquina(m);
    const lc = type ? (porType.get(type) || null) : null;
    const chave = lc ? lc.family : (String(m.model || '').trim() || type || 'desconhecido');
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        family: chave,
        type: type || null,
        quantidade: 0,
        dormentes: 0,
        hwWdfm: lc ? lc.hwWdfm : null,
        coslEos: lc ? lc.coslEos : null,
        // Fora de suporte = já passou do fim de serviço anunciado.
        foraDeSuporte: !!(lc && lc.coslEos && lc.coslEos < hoje),
        semCicloDeVida: !lc,
      });
    }
    const g = grupos.get(chave);
    g.quantidade += 1;
    if (m.status === 'dormente') g.dormentes += 1;
  }

  const geracoes = [...grupos.values()].sort((a, b) => b.quantidade - a.quantidade);
  return {
    geracoes,
    totalMaquinas: geracoes.reduce((a, g) => a + g.quantidade, 0),
    maquinasForaDeSuporte: geracoes.filter((g) => g.foraDeSuporte).reduce((a, g) => a + g.quantidade, 0),
  };
}

/**
 * Capacidade INSTALADA por cliente — o tamanho do parque, não o consumo.
 *
 * Cuidado com a origem de cada número, que é onde dá para errar feio:
 *  - MIPS vem da linha LSPR do modelo da máquina ("3931-7C9"), que é a
 *    capacidade nominal daquele modelo. É o único jeito: MIPS não aparece no
 *    SCRT nem é digitado à mão.
 *  - IFLs vem do CADASTRO da máquina (iflsActive/iflsSpare), não do LSPR. O
 *    campo `ifls` da tabela LSPR é o MÁXIMO que o modelo comporta — usar ele
 *    diria que todo cliente tem 200 IFLs, o que seria uma mentira grande.
 *
 * Máquina substituída ou desativada fica de fora, como no parque.
 */
function agregarCapacidade(machines, lsprModels) {
  const porModelo = new Map((lsprModels || []).map((l) => [String(l.model), l]));
  const porCliente = new Map();
  for (const m of machines || []) {
    if (m.status === 'substituida' || m.status === 'desativada') continue;
    const k = id(m.client);
    if (!porCliente.has(k)) {
      porCliente.set(k, { maquinas: 0, mips: 0, cps: 0, ziips: 0, iflsAtivos: 0, iflsSpare: 0, semLspr: 0 });
    }
    const c = porCliente.get(k);
    c.maquinas += 1;
    c.cps += Number(m.cps) || 0;
    c.ziips += Number(m.ziips) || 0;
    c.iflsAtivos += Number(m.iflsActive) || 0;
    c.iflsSpare += Number(m.iflsSpare) || 0;
    const l = porModelo.get(String(m.lsprModel || ''));
    if (l && Number.isFinite(l.mips)) c.mips += l.mips;
    else c.semLspr += 1;                 // sem vínculo LSPR não dá para somar MIPS
  }
  return porCliente;
}

/**
 * Junta a capacidade instalada em cada linha do ranking de consumo.
 * Cliente sem máquina cadastrada fica com null (a tela mostra "—"), NÃO com
 * zero: zero afirmaria que o parque é vazio, quando na verdade é desconhecido.
 */
function anexarCapacidade(ranking, porCliente) {
  return ranking.map((r) => {
    const c = porCliente.get(String(r.clientId));
    return {
      ...r,
      maquinas: c ? c.maquinas : 0,
      mips: c && c.mips ? c.mips : null,
      ifls: c ? c.iflsAtivos : null,
      iflsSpare: c ? c.iflsSpare : null,
      mipsParcial: !!(c && c.semLspr),   // parte das máquinas sem vínculo LSPR
    };
  });
}

/** Agregado comercial: quantos clientes têm contrato e a soma dos baselines. */
function agregarContratos(clients) {
  let comContrato = 0;
  let baselineMensalTotal = 0;
  const porCliente = [];
  for (const c of clients) {
    const periodos = c.contractPeriods || [];
    const vigente = periodos.filter((p) => !p.endPeriodKey).pop() || periodos[periodos.length - 1] || null;
    const temMlc = !!(vigente && (vigente.years || []).length);
    if (temMlc) comContrato += 1;
    const baseline = Number(c.monthlyBaselineMsu) || 0;
    baselineMensalTotal += baseline;
    porCliente.push({
      clientId: id(c),
      name: c.name,
      contrato: vigente ? vigente.name : null,
      inicio: vigente ? vigente.startPeriodKey : null,
      fim: vigente ? vigente.endPeriodKey : null,
      anos: vigente ? (vigente.years || []).length : 0,
      baselineMensalMsu: baseline || null,
    });
  }
  return { comContrato, semContrato: clients.length - comContrato, baselineMensalTotal, porCliente };
}

module.exports = { agregarConsumo, agregarParque, agregarContratos, agregarCapacidade, anexarCapacidade, serieDoCliente, typeDaMaquina };
