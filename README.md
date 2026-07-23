# TFPSystem

Sistema de acompanhamento de consumo **TFP (Tailored Fit Pricing)** de mainframe por cliente.
Você sobe o relatório **SCRT** (CSV gerado pelo IBM Sub-Capacity Reporting Tool), escolhe o cliente
no menu, e o sistema interpreta, salva no **MongoDB** e monta o dashboard de consumo mensal.

## Regra de interpretação do SCRT

> **Consumo mensal = soma da linha `Machine MSU Consumed` de todas as máquinas do Multiplex** (seção `==B5` do SCRT).

O total dos containers (`TOTAL MSU Consumption`) também é lido e usado como conferência — se divergir
da soma das máquinas, o sistema mostra um aviso, mas o valor oficial é sempre a soma das máquinas.

Também são extraídos e salvos por relatório: período (ex.: Jun/2026), nome do cliente no SCRT,
release da ferramenta, máquinas (serial, tipo-modelo, capacidade nominal, pico de utilização,
MSU consumido, flags de dados faltantes), containers, responsável pelo envio e as **LPARs**:

- **Seção `==N7` (DETAIL LPAR USAGE DATA)** — Total MSU Consumed, pico horário e OS por LPAR.
  A soma das LPARs de cada máquina é conferida contra o "Machine MSU Consumed" da máquina
  (e contra a linha CPC da própria seção); divergência gera aviso.
- **Seção `==N5` (DETAIL LPAR DATA)** — maior e 2ª maior 4HRA por LPAR, com data/hora.

Os pares N5/N7 aparecem uma vez por máquina, na ordem das máquinas da seção B5 — o parser
usa essa ordem e valida a associação pelo total CPC.

## Módulos

O sistema tem dois módulos, acessíveis pelo menu no topo:

| Módulo | Rota | O que faz |
|---|---|---|
| **Consumo (SCRT)** | `/` | Upload do SCRT mensal, dashboard de MSUs, LPARs, grupos e comparativo mês a mês |
| **Inventário** | `/inventario` | Upload do relatório IBM SW Material, análise de produtos/PIDs, licenças e S&S |

Os dois compartilham a **mesma lista de clientes**: cadastre o cliente uma vez (no módulo de
Consumo) e ele aparece nos dois. O inventário fica salvo no MongoDB (um inventário atual por
cliente; recarregar substitui o anterior).

## Como rodar

```bash
npm install
npm start
```

Abra `http://localhost:3000`, cadastre o cliente (ex.: CAIXA, BRB), e arraste o `.csv` do SCRT
para a tela (ou use o botão **Subir SCRT**).

### Onde ficam os dados

Por padrão o `npm start` sobe um **MongoDB local persistente junto com a aplicação**, com os
dados gravados em **`./data/mongodb`** (dentro da própria pasta do app). Nada é instalado no
sistema — o binário `mongod` é gerenciado pelo próprio projeto. O banco atende em
`mongodb://127.0.0.1:27017/tfpsystem` (dá para inspecionar com `mongosh` ou Compass), a porta
é configurável via `LOCAL_DB_PORT` no `.env`, e fazer **backup = copiar a pasta `data/`**.

Para usar outro banco (MongoDB Atlas ou um servidor seu), copie `.env.example` para `.env` e
defina `MONGODB_URI` — com a URI definida, o banco local embutido não é iniciado.

### Modo demo (dados descartáveis)

```bash
npm run demo
```

Sobe com um MongoDB **em memória** — bom para testar à vontade, **os dados são perdidos ao encerrar**.

## Comportamentos importantes

- **Vários SCRTs no mesmo mês são somados**: quando o cliente tem sites/máquinas separados
  (ex.: BRB com SCN e SIG), suba os dois arquivos e o mês passa a ser a soma deles. O sistema
  identifica cada origem pelas **máquinas que ela reporta** (número de série), então:
  - arquivo com máquinas novas → **soma** ao mês (aparece o selo "N SCRTs" no histórico);
  - reenvio do mesmo conjunto de máquinas → **substitui** aquela origem (não duplica);
  - máquina repetida em duas origens do mesmo mês → **conflito**, sinalizado em vermelho no
    histórico e no detalhe do mês, porque o consumo estaria contado em dobro.

  No card de máquinas há a lista "N SCRTs somados neste mês", com o arquivo, as máquinas e o
  consumo de cada origem — e um botão para remover uma origem específica sem apagar o mês inteiro.
- **Cliente errado**: se o `Customer Name` do SCRT não bater com o cliente selecionado
  (ex.: subir SCRT da CAIXA no BRB), o upload funciona mas mostra um aviso.
- **Baseline mensal** (opcional, por cliente): defina o teto contratual em "Definir baseline" para
  habilitar a linha de baseline no gráfico, o KPI de folga/excedente e as tags Acima/Abaixo baseline.
- **Encoding**: aceita SCRT em ISO-8859-1 (padrão da ferramenta IBM) e UTF-8, com linhas CRLF/CR/LF.

### Formatos de SCRT aceitos

O parser lida com as variações que aparecem na prática (todas validadas contra arquivos reais
em `SCRT/`):

| Variação | Exemplo | Como é tratada |
|---|---|---|
| **Enterprise TFP · multiplex** | CAIXA (6 máquinas), BB (9 máquinas) | Matriz com uma coluna por máquina; consumo = soma do `Machine MSU Consumed` |
| **Sub-Capacity / MVM · máquina única** | BRB | Campos planos `chave,valor` na B5; `Reporting Period` e `Tool Release` vêm da seção `==C5` |
| **CSV duplo-codificado** | BB | Cada linha vem empacotada como um único campo (`"Customer Name,""BANCO DO BRASIL"""`); o parser detecta e re-interpreta |
| **Separador `;` + aspas simples** | ITAÚ | Delimitado por ponto e vírgula, valores entre aspas simples (`Customer Name;'BANCO ITAU SA'`), UTF-8 com BOM; o separador é detectado automaticamente |
| **Planilha `.xlsx` (aba = máquina)** | ITAÚ | Uma aba por máquina; o sistema lê todas as abas e as combina num único multiplex (soma o consumo, une máquinas/LPARs) |
| **Linha extra antes do banner** | Excel (`sep=,`) | O banner `==B5` é localizado em qualquer posição |

## Dashboard

- KPIs: consumo do mês (com MoM), crescimento ano-a-ano (YTY), média e acumulado de 12 meses,
  baseline com folga/excedente.
- Gráfico com três modos: **Mensal** (barras + tendência por regressão linear + baseline mensal),
  **Por grupo** (barras empilhadas com o consumo de cada grupo de LPARs em cor própria; meses sem
  seções N7 aparecem como "Sem detalhe por LPAR") e **Acumulado 12M** (soma móvel de 12 meses de
  calendário + baseline anual = 12 × mensal).
- **Clique em um mês no gráfico** (qualquer modo) para focar o dashboard inteiro nele: KPIs,
  histórico, máquinas e LPARs passam a refletir o mês clicado, e a barra dele fica destacada.
- Histórico mensal com MoM, YTY e coluna **Acum. 12M** — clique em um mês para ver o detalhe.
- **Todas as tabelas são ordenáveis**: clique no cabeçalho da coluna para ordenar (MSU consumido,
  % do total, capacidade, pico, variação, contribuição, nome, mês…). O primeiro clique ordena do
  maior para o menor, o segundo inverte, e o terceiro volta à ordem padrão da tabela. A coluna
  ativa fica destacada com ▼/▲.
- Detalhe por máquina: tipo-modelo, capacidade nominal, pico, MSU consumido e % do total.
  **Clique em uma máquina para filtrar o card de LPARs por ela** (o % passa a ser relativo à
  máquina; um chip "Máquina X ✕" mostra o filtro ativo — clique nele ou na máquina de novo
  para limpar). O filtro vale nas duas visões (explodida/agrupada) e abas (N7/N5), e é mantido
  ao navegar entre meses do mesmo cliente.
- **Capacity planning** — projeta o consumo de 1 a 5 anos à frente, por dois métodos escolhidos
  na hora: **regressão linear** (tendência) e **SARIMA** (tendência + sazonalidade). Mostra o
  gráfico de histórico + projeção com intervalo de 95% e a tabela consolidada por ano, com
  crescimento e % do baseline anual — o material para a conversa de capacidade com o cliente.

  > **Quanto histórico é preciso:** a sazonalidade de 12 meses só é estimada com **24 meses ou
  > mais** (dois ciclos). Com menos, o SARIMA roda sem a parte sazonal (vira ARIMA) e o sistema
  > avisa na tela; com menos de 6 meses cai para a regressão linear; com menos de 3 meses recusa.
  > Como esses gráficos vão para o cliente, a limitação é sempre declarada em vez de mascarada.

- **Comparativo mês a mês** — responde "quem puxou o consumo pra cima?" em duas etapas:
  primeiro a variação por **máquina** (ordenada do maior aumento para a maior queda, com a
  contribuição de cada uma na variação total), depois **clique na máquina** para ver a variação
  das **LPARs dentro dela**. A soma das variações fecha sempre com a variação total do mês.
  O mês base é o anterior por padrão, e pode ser trocado no seletor "comparar com" para comparar
  com qualquer outro mês (ex.: mesmo mês do ano passado). Máquinas/LPARs que aparecem ou somem
  entre os meses são marcadas como **nova** / **removida**.
- **Consumo por LPAR** do mês selecionado, em duas abas: **Uso (N7)** — MSU consumido, % do
  total, pico horário — e **Picos 4HRA (N5)** — maior e 2ª maior 4HRA com data/hora.
- **Grupos de LPARs** (por cliente, salvos no MongoDB): em **⚙ Grupos** você cria grupos como
  "Produção" = P0, P4, PC…; cada LPAR pertence a no máximo um grupo. A visão **Agrupada** soma
  o consumo (N7) por grupo — nos picos (N5), mostra os dois maiores picos individuais do grupo,
  já que 4HRA não é somável — e LPARs sem grupo continuam aparecendo individualmente.
  A visão **Explodida** mostra LPAR a LPAR, como sempre. Na agrupada, **clique na linha do
  grupo (chevron ▸)** para expandir e ver as LPARs que o compõem.

## Testes

```bash
npm run test:parser     # parser contra os SCRTs reais + casos sintéticos
npm run test:migration  # migração de bancos criados por versões anteriores
npm run test:e2e        # API completa com MongoDB em memória
```

### Migração automática do banco

Bancos criados por versões anteriores são migrados na inicialização
([src/db.js](src/db.js)): índices obsoletos são removidos e campos novos são preenchidos.
Isso é necessário porque o Mongoose cria índices novos mas **não remove os antigos** — e um
índice obsoleto continua sendo aplicado. Exemplo: o índice `{client, periodKey}` da época em que
só existia um SCRT por mês impedia subir o segundo site do mesmo mês (erro `E11000`).

## API (resumo)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/clients` | Lista clientes (com nº de relatórios e último mês) |
| POST | `/api/clients` | Cria cliente `{name, monthlyBaselineMsu?}` |
| PATCH | `/api/clients/:id` | Atualiza nome/baseline |
| DELETE | `/api/clients/:id` | Exclui cliente **e todos os relatórios dele** |
| POST | `/api/clients/:id/reports` | Upload do SCRT (multipart, campo `file`) — soma ao mês ou substitui a origem |
| GET | `/api/clients/:id/reports` | Lista relatórios do cliente |
| GET | `/api/clients/:id/months/:periodKey` | Mês fundido (soma das origens, com conflitos) |
| DELETE | `/api/clients/:id/months/:periodKey` | Exclui o mês inteiro (todas as origens) |
| GET | `/api/clients/:id/dashboard` | Série mensal com MoM/YTY + último relatório |
| GET | `/api/clients/:id/compare?target=&base=` | Variação entre dois meses, por máquina e por LPAR |
| GET | `/api/clients/:id/forecast?method=&years=` | Projeção (`linear`\|`sarima`), 1 a 5 anos |
| GET | `/api/reports/:id` | Relatório completo (máquinas, containers) |
| DELETE | `/api/reports/:id` | Exclui um relatório |
| GET | `/api/inventories` | Lista os inventários (resumo por cliente) |
| GET | `/api/clients/:id/inventory` | Inventário completo do cliente |
| PUT | `/api/clients/:id/inventory` | Salva/substitui o inventário (JSON já parseado) |
| DELETE | `/api/clients/:id/inventory` | Exclui o inventário do cliente |

## Estrutura

```
server.js              # Express + estáticos + conexão MongoDB + banco local
src/scrtParser.js      # parser do CSV SCRT (latin-1/UTF-8, seções ==B5 etc.)
src/models.js          # Mongoose: Client, ScrtReport, Inventory
src/routes.js          # API REST (consumo + inventário)
src/localDb.js         # MongoDB local persistente em ./data/mongodb
public/index.html      # módulo Consumo (SCRT)
public/inventario.html # módulo Inventário (parser roda no navegador, dados no MongoDB)
SCRT/<CLIENTE>/        # arquivos SCRT de cada cliente
```

> **Inventário:** o parse do relatório IBM (HTML) continua sendo feito no navegador — é o código
> original do painel de inventário, preservado. A diferença é que o resultado, em vez de ficar no
> `localStorage` de um navegador só, é enviado para a API e gravado no MongoDB, ficando disponível
> em qualquer máquina que acesse o sistema.

### Link para o IBM ProductPages (w3)

No modal de cada produto há o link **"Ver &lt;PID&gt; no IBM ProductPages"**, que abre
`https://w3.ibm.com/systems/productpages/index.html?pid=<PID>` — onde ficam equipe (manager,
desenvolvedor), carta de anúncio, EOS e GA.

Por que só o link, e não os dados trazidos para cá: o portal é uma SPA cuja API
(`/systems/productpages/pp/product/*`) exige sessão autenticada do w3 (IBM SSO) — sem ela, os
endpoints respondem vazio — e não envia cabeçalhos CORS, o que também impede o navegador do
usuário de consultá-la a partir do TFPSystem. Um crawler exigiria credenciais de SSO, então o
link (que abre a página onde o usuário já está autenticado) é a alternativa viável.

### Atualizando o painel de inventário

`public/inventario.html` é **gerado** — não edite à mão. Quando chegar uma versão nova do painel:

1. coloque o arquivo em `Inventario/` (o build pega o `app_inventario*.html` mais recente);
2. rode:

```bash
npm run build:inventario
```

O build ([scripts/build-inventario.js](scripts/build-inventario.js)) aplica o sistema visual
([scripts/inventario.css](scripts/inventario.css)), insere a barra de módulos, remove os
pictogramas e anexa a ponte de persistência ([scripts/inventario-bridge.js](scripts/inventario-bridge.js)),
que sobrescreve as funções de armazenamento do painel para gravar no MongoDB. O código original
do painel (parser, filtros, tabelas, exportações) não é tocado.
