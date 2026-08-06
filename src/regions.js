'use strict';

/*
 * Hierarquia de regiões: LA contém Brasil, Brasil contém clientes — e LA soma os
 * clientes do Brasil mais os das outras filhas.
 *
 * A região guarda só o PAI. A lista de clientes de um nível é CALCULADA
 * percorrendo os descendentes, nunca gravada: lista fechada em cada nível ficaria
 * desatualizada toda vez que um cliente entrasse numa folha.
 *
 * Todo percurso aqui é protegido contra ciclo (A pai de B, B pai de A). Sem isso
 * um dado ruim — ou um clique errado na tela — trava o servidor em laço infinito.
 */

const id = (v) => (v == null ? null : String(v && v._id ? v._id : v));

/** Filhas diretas de cada região, indexadas pelo id do pai. */
function indexarFilhas(regions) {
  const porPai = new Map();
  for (const r of regions) {
    const p = id(r.parent) || 'raiz';
    if (!porPai.has(p)) porPai.set(p, []);
    porPai.get(p).push(r);
  }
  return porPai;
}

/**
 * A região e TODAS as descendentes. Com corte por visitados: um ciclo devolve o
 * que já foi visto em vez de rodar para sempre.
 */
function comDescendentes(regions, regionId) {
  const porPai = indexarFilhas(regions);
  const alvo = regions.find((r) => id(r) === id(regionId));
  if (!alvo) return [];
  const vistos = new Set([id(alvo)]);
  const saida = [alvo];
  const fila = [alvo];
  while (fila.length) {
    const atual = fila.shift();
    for (const f of porPai.get(id(atual)) || []) {
      if (vistos.has(id(f))) continue;      // ciclo: para aqui
      vistos.add(id(f));
      saida.push(f);
      fila.push(f);
    }
  }
  return saida;
}

/** Ids dos clientes de uma região, somando os das descendentes. */
function clientesDaRegiao(regions, clients, regionId) {
  const ids = new Set(comDescendentes(regions, regionId).map((r) => id(r)));
  return clients.filter((c) => c.region && ids.has(id(c.region)));
}

/** Caminho da raiz até a região ("LA › Brasil"), com corte de ciclo. */
function caminho(regions, regionId) {
  const porId = new Map(regions.map((r) => [id(r), r]));
  const nomes = [];
  const vistos = new Set();
  let atual = porId.get(id(regionId));
  while (atual && !vistos.has(id(atual))) {
    vistos.add(id(atual));
    nomes.unshift(atual.name);
    atual = atual.parent ? porId.get(id(atual.parent)) : null;
  }
  return nomes;
}

/**
 * Árvore para a tela, com a contagem de clientes de cada nível (própria +
 * herdada das descendentes).
 */
function montarArvore(regions, clients) {
  const porPai = indexarFilhas(regions);
  const diretos = new Map();
  for (const c of clients) {
    const r = id(c.region);
    if (!r) continue;
    diretos.set(r, (diretos.get(r) || 0) + 1);
  }
  const vistos = new Set();
  const construir = (r) => {
    if (vistos.has(id(r))) return null;     // ciclo
    vistos.add(id(r));
    const filhas = (porPai.get(id(r)) || []).map(construir).filter(Boolean);
    const total = (diretos.get(id(r)) || 0) + filhas.reduce((a, f) => a + f.totalClientes, 0);
    return {
      _id: id(r),
      name: r.name,
      parent: id(r.parent),
      clientesDiretos: diretos.get(id(r)) || 0,
      totalClientes: total,                 // inclui os das descendentes
      filhas,
    };
  };
  return (porPai.get('raiz') || []).map(construir).filter(Boolean);
}

/**
 * Uma região não pode ser filha de si mesma nem de uma descendente sua — isso
 * criaria o ciclo que todo percurso acima teria de aparar.
 */
function validarPai(regions, regionId, novoPaiId) {
  if (!novoPaiId) return null;
  if (id(regionId) === id(novoPaiId)) return 'Uma região não pode ser pai dela mesma.';
  const descendentes = comDescendentes(regions, regionId).map((r) => id(r));
  if (descendentes.includes(id(novoPaiId))) {
    return 'Essa região não pode ficar dentro de uma região que já está dentro dela.';
  }
  return null;
}

module.exports = { comDescendentes, clientesDaRegiao, caminho, montarArvore, validarPai, indexarFilhas };
