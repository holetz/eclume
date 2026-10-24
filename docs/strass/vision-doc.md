# Lumea — Vision Doc

**Input:** `jtbd.md`, `market-scan.md`, `vpc.md`, `bmc.md`, `personas.md`, `risks-assumptions.md`.
**Fonte primária:** questionário de discovery respondido por Jane Doe (EK), 03/08/2026.

**Revisão v1.1 (2026-09-13):** `[DITO]` — feedback do dono do produto rejeitou o corte
original da biblioteca de ações (4 → 1 tipo), por ter sido justificado, ainda que
parcialmente, por esforço/velocidade de codar. Instrução literal: "melhor repensar MVP, ao
invés de mínimo viável, temos que pensar no MELHOR VALOR POSSÍVEL, tirar o viés de
escassez de código e demora para codar, o que importa é pensar em gerar valor." O recorte
abaixo foi refeito sob esse critério — ver "Critério de corte do MVP". Não há evidência no
discovery de prazo rígido que justificasse cortar por esforço (`risks-assumptions.md`
registra "ausência de prazo/orçamento definidos" como risco em aberto, não como restrição
confirmada).

**Revisão v1.2 (2026-09-13) — validação da fundadora:** Jane Doe respondeu as 12
perguntas em aberto que bloqueavam o handoff (`risks-assumptions.md`, `handoff-strategy.yaml`).
Três respostas mudam o recorte de MVP abaixo, não apenas confirmam o que já estava escrito:
(1) o líder de área (Carla) entra na v1, não em v1.1, e com **permissionamento por papel**
(RH vê a estrutura completa; líder vê só a hierarquia abaixo dele) — requisito novo, não
confirmação; (2) a plataforma de assessment entra no escopo técnico deste projeto agora,
como insumo do diagnóstico, não como integração futura; (3) os dois tiers comerciais
(Self-Service e "Lumea + EK") serão testados **ao mesmo tempo**, revertendo a suposição
anterior de que "Lumea + EK" seria testado primeiro. As demais respostas confirmam decisões
já tomadas (RAT = H1, profundidade das quatro ações, ponto de entrada, frequência de uso por
persona). Handoff liberado — ver `handoff-strategy.yaml`, `owner_approved: true`.

---

## Vision

Um motor de inteligência organizacional que junta o desenho da estrutura, o diagnóstico de
liderança e equipes, e a recomendação de ação num só lugar — para que RH, consultorias de
RH e líderes parem de tomar decisão de pessoas no escuro.

## Problem

`[DITO]` Quem cuida da estrutura de pessoas de uma empresa não tem uma visão única, viva e
acionável de como essa estrutura está desenhada e do que precisa ser feito nela. Hoje isso
mora na cabeça de poucas pessoas e em documentos soltos (organograma estático, planilha de
headcount, 9-box manual, assessment avulso, consultoria pontual que não fica viva). O
problema é contínuo — nunca zera — e custa tempo, risco (sucessão, dimensionamento,
turnover de liderança) e dinheiro. Detalhe completo em `jtbd.md`.

## Solution

A Lumea é o motor de inteligência organizacional da EK: desenha a estrutura, roda o
diagnóstico de liderança e equipes usando a metodologia proprietária da fundadora, e
recomenda ações concretas de uma biblioteca (assessment, mentoria, redesenho de time,
dimensionamento). Diferente dos concorrentes de organograma (ChartHop, Agentnoon, OrgVue) e
de assessment isolado (Sólides, Hogan, DISC), nenhum dos quais junta as três camadas
(`market-scan.md`), a Lumea integra estrutura, diagnóstico e ação num único motor.

## Target Users

Cinco perfis mapeados em `personas.md`: RH interno/HRBP (Marina), consultorias de RH
(Rafael), líderes/gestores de área (Carla), a própria EK como operadora, e empresas sem RH
estratégico capacitado internamente (Persona 5 — perfil de contato variável: RH generalista,
ADM ou sócio, confirmado pela fundadora, resposta 12). O MVP fecha o job para **RH/empresa
cliente atual da EK** (Marina ou Persona 5, confirmado como ponto de entrada, resposta 4),
**e desde a v1 também para o líder de área (Carla)**, com escopo de dados permissionado por
papel — ver "Conexão com o modelo de tiers" abaixo.

## Conexão com o modelo de tiers (revisão 2026-09-13 — validação da fundadora)

`[DITO]` (dono do produto, confirmado pela fundadora — resposta 7, 2026-09-13) — o `bmc.md`
modela a Lumea em dois tiers: **Self-Service** (RH já capacitado a interpretar diagnóstico e
agir sozinho) e **"Lumea + EK"** (service-as-software: a EK/consultor treinado aplica o
julgamento especialista). A fundadora reconhece esse direcionamento explicitamente como sua
estratégia de negócio ("RH Estratégico as-a-Service"). Precificação confirmada como **uma
assinatura única**, com o acompanhamento da equipe da EK entrando como serviço extra por cima
(resposta 11) — não são planos/preços estruturalmente separados por tier.

**Mudança de plano de teste (resposta 8, 2026-09-13):** a suposição anterior deste documento
era que o tier "Lumea + EK" seria testado primeiro, com o Self-Service adiado para v1.1. A
fundadora corrigiu isso explicitamente: **os dois tiers são testados ao mesmo tempo**, não em
sequência — ela já tem clientes hoje em que consegue aplicar os dois formatos. Isso muda o
Must Have do MVP, não só a leitura de negócio:

- O MVP continua operando o fluxo assistido pela EK (tier "Lumea + EK") como um dos dois
  modos testados — isso não muda.
- **O MVP passa a precisar também de um modo sem revisão humana da EK** (tier Self-Service),
  para pelo menos um cliente-piloto elegível (perfil Marina/Persona 1, RH já capacitado) — o
  item "Self-service para RH/HRBP rodar o fluxo sem a EK operando junto", antes em Should Have
  (v1.1), sobe para Must Have. Ver "Scope" abaixo.
- A profundidade exata do self-service necessária para esse teste (onboarding sem
  intervenção da EK, nível de automação da recomendação) **não foi detalhada pela fundadora**
  e é a maior inferência aberta que resta neste documento (ver "Inferências abertas").
- Testar H1 nos dois formatos ao mesmo tempo, em vez de isolar o modo assistido primeiro, é
  uma mudança de critério: a fundadora prioriza aprender rápido sobre os dois segmentos em
  paralelo em vez de reduzir variável experimental isolando um modo por vez. Isso é decisão
  dela, registrada como tal — não é ajuste editorial do Strategist.

**Risco novo que este recorte não testa:** H5 (`risks-assumptions.md`) — se a EK consegue
entregar o tier managed além do teto confirmado de 4 clientes simultâneos. O MVP não precisa
resolver isso para testar H1, mas o resultado de H1 não implica que H5 seja verdadeira; são
hipóteses independentes, na sequência.

## Hipótese de valor

Se **RH interno/HRBP de um cliente atual da EK** usar **o fluxo estrutura → diagnóstico →
recomendação de ação dentro da Lumea**, então **substitui o diagnóstico manual/avulso
anterior e pede para continuar usando a ferramenta depois do ciclo de consultoria** —
porque isso ataca diretamente o Job 2 do `jtbd.md` (transformar diagnóstico em ação que
fica viva, não só relatório pontual).

**Hipótese mais arriscada testada:** H1 (`risks-assumptions.md`) — RH/HRBP e consultorias
trocam a alternativa atual pela Lumea a ponto de pagar por isso. **Confirmado pela fundadora
(resposta 1, 2026-09-13) como a aposta mais arriscada** — não é mais leitura do Strategist.

**Frequência de retorno confirmada (resposta 5, 2026-09-13):** RH interno de empresa
cliente volta **semanalmente**, para acompanhamento; empresa sem RH estruturado (Persona 5)
volta **diariamente**, pelo responsável/líder da área; líder/gestor de área (Carla, que
agora acessa a ferramenta desde a v1) volta **sob demanda do acompanhamento do time**;
consultoria de RH parceira, **por cliente atendido, conforme demanda**. Isso substitui o
"frequência não medida" que era a maior lacuna deste documento até esta revisão.

_O comportamento observável acima ("pede para continuar usando depois do ciclo") é o que o
`product-owner` transforma em métrica com alvo numérico. Este documento não define o
número — define o que precisa ser observado._

---

## Critério de corte do MVP (obrigatório para as próximas fases)

`[DITO]` — feedback explícito do dono do produto, 2026-09-13.

**O recorte abaixo usa um único critério: qual fatia gera mais valor real para a persona e
testa a hipótese mais arriscada (H1) — nunca quanto esforço de código cada item exige.**
Esforço de implementação não é critério de corte de escopo neste projeto, porque não há
evidência de prazo rígido que o justifique (`risks-assumptions.md`: "ausência de
prazo/orçamento definidos" é risco em aberto, não restrição confirmada; meta é "no ar até
2027" sem evento externo fixo).

Isso muda a leitura do próprio Job 2 (`jtbd.md`): o job não é "receber uma recomendação de
ação" — é, literalmente, "saber **qual das quatro** ações tomar (assessment, mentoria,
redesenho de time, ajuste de tamanho)". Entregar sempre o mesmo tipo de ação, independente
do diagnóstico, não é uma versão mais simples do Job 2 — é um job diferente, que não testa
a promessa central do produto (`vpc.md`: P4/P5, "ninguém consolida" e "líder não sabe o que
fazer"; `market-scan.md`: a diferenciação defensável é justamente integrar as três camadas,
não parar em uma resposta fixa).

**Por que isso muda o resultado do teste de H1, não só o escopo:** se o MVP recomendasse só
um tipo de ação, um resultado ruim na entrevista (cliente não quer continuar pagando)
ficaria ambíguo — não dá para saber se o problema é a tese do produto (H1) ou se é só que a
única ação disponível não cabia no caso daquele cliente. Testar H1 com a biblioteca
completa remove essa confusão: se o cliente rejeitar mesmo recebendo a ação certa para o
caso dele, a rejeição fala sobre H1 de verdade, não sobre uma limitação artificial de
escopo. Esse é o motivo de valor/risco para manter as quatro ações no MVP — não menor custo
de construção (é o oposto: mais trabalho de dev, aceito porque o teste de H1 sai mais
confiável).

**Onde o corte por esforço/velocidade permanece proibido, mesmo que pareça razoável:** se
uma fase futura (`product-owner`, `architect`) precisar reduzir escopo por causa de prazo
ou orçamento, essa decisão deve voltar para este documento e ser justificada por
valor/risco (qual job fica incompleto, qual hipótese deixa de ser testada) — nunca
apresentada como "MVP enxuto" sem essa análise explícita.

---

## Scope

### In Scope (MVP)

| Item | Job que fecha | MoSCoW |
|------|-----------------|--------|
| Montagem/importação da estrutura organizacional (dentro da ferramenta ou via planilha) | Job 1 | Must |
| Diagnóstico de risco de liderança e dimensionamento de equipe, usando a metodologia da EK | Job 1, Job 2 | Must |
| Recomendação de ação cobrindo as **quatro** categorias da biblioteca (assessment, mentoria, redesenho de time, dimensionamento) — a lógica precisa discriminar corretamente qual ação cabe a cada diagnóstico. Priorização de cenário de diagnóstico segue focada em risco de liderança, citado pela fundadora como a demanda mais recorrente (`jtbd.md`, resposta 9), mas a recomendação em si não fica restrita a um único tipo de resposta. Profundidade confirmada (`[DITO]`, resposta 2): recomendação + orientação de próximo passo é suficiente — não exige acompanhamento de execução completa no MVP | Job 2 | Must |
| Visão do líder/gestor de área (Carla) com **permissionamento por papel** — RH vê a estrutura organizacional completa; o líder vê apenas o que está abaixo dele na própria hierarquia. Confirmado pela fundadora (resposta 3, 2026-09-13) como parte da v1, não de v1.1. É uma segunda experiência de uso com escopo de dados diferente, não uma tela a mais — exige modelo de permissão por papel e posição hierárquica desde o desenho inicial | Job 4 | Must |
| Operação assistida pela EK (tier "Lumea + EK") — a fundadora/consultora aplica julgamento especialista sobre o diagnóstico antes de chegar ao cliente | Job 5 | Must |
| Modo self-service mínimo (tier "Self-Service") — RH já capacitado (perfil Marina) opera o fluxo estrutura → diagnóstico → recomendação sem revisão humana da EK, para pelo menos um cliente-piloto elegível. Confirmado pela fundadora (resposta 8, 2026-09-13): os dois tiers são testados ao mesmo tempo, não em sequência — este item sobe de Should Have (v1.1) para Must Have nesta revisão. Profundidade exata (onboarding, nível de automação) não detalhada — ver Inferências abertas | Job 1, Job 2 | Must |
| Plataforma de assessment como componente do motor de diagnóstico (mínimo: captura de dados de assessment como insumo para o diagnóstico, além de poder ser recomendada como uma das quatro ações). Confirmado pela fundadora (resposta 6, 2026-09-13): entra no escopo técnico deste projeto agora, não como integração futura separada, porque alimenta a ferramenta com informações que compõem o diagnóstico. A arquitetura do fluxo de dados nos dois sentidos (assessment como insumo e como ação recomendada) é decisão do `architect` — ver `risks-assumptions.md` | Job 1, Job 2 | Must |
| Controle de acesso por perfil e tratamento de dados aderente à LGPD (dados de colaboradores de terceiros, dados de assessment sensíveis) | Risco de negócio/legal | Must — bloqueador de lançamento, não feature opcional |

### Should Have (v1.1)

- Acompanhamento de execução da ação recomendada (marcar se foi feita, revisitar se o risco
  caiu) — job relacionado de "depois" (`jtbd.md`), distinto do próprio Job 2. Confirmado pela
  fundadora (resposta 2, 2026-09-13) que recomendação + próximo passo já basta no MVP; o
  rastreamento de execução ponta a ponta fica para v1.1.
- Painel multiempresa para consultorias de RH externas à EK (Job 3, persona Rafael) — exige
  validar H3 (disposição de pagar pelo white-label) antes de investir em multiempresa.
- Self-service comercializável em escala para o tier "Self-Service" (onboarding próprio sem
  intervenção da EK, billing self-serve, growth) — distinto do "modo self-service mínimo"
  que já está em Must Have para o teste com o cliente-piloto. Esta linha é sobre
  produtizar o tier além do piloto, depois que H1 e H2 forem validadas para este segmento
  especificamente.

### Could Have (backlog)

- Integrações com HRIS (Gupy, Sólides, TOTVS/Protheus, Senior), Google Workspace/Microsoft 365.
- Notificação/lembrete automático de reavaliação periódica da estrutura.

### Won't Have (fora de escopo)

- `[DITO]` Virar HRIS/folha de pagamento ou sistema de admissão.
- `[DITO]` Recrutamento e seleção / banco de vagas (ATS).
- `[DITO]` Integrações complexas com múltiplos sistemas logo de saída.

---

## MVP Test

```
1. Qual job completo a persona consegue terminar?
   RH/HRBP ou empresa sem RH capacitado (Persona 5) de um cliente da EK sai com estrutura
   montada + diagnóstico de risco de liderança + a recomendação de ação correta dentre as
   quatro categorias da biblioteca (assessment, mentoria, redesenho de time, dimensionamento),
   sem sair da ferramenta — fechando o Job 2 como ele é definido em `jtbd.md`, não uma versão
   reduzida dele. Desde a v1, o líder de área (Carla) também completa o Job 4 — ver o
   diagnóstico e a ação recomendada para o próprio time, dentro do escopo de dados
   permissionado por hierarquia (confirmado pela fundadora, resposta 3, 2026-09-13).

2. Qual ganho ela percebe na primeira sessão, e em quanto tempo?
   Diagnóstico e recomendação prontos numa sessão — meta declarada pela fundadora é chegar
   a ~1h de trabalho dentro da plataforma (hoje leva várias horas manuais; a linha de base
   exata não foi medida, ver jtbd.md G1).

3. Por que ela volta, e com que frequência?
   Confirmado pela fundadora (resposta 5, 2026-09-13), por persona: RH interno de empresa
   cliente volta semanalmente, para acompanhamento; empresa sem RH estruturado (Persona 5)
   volta diariamente, pelo responsável/líder da área; líder/gestor de área (Carla) volta sob
   demanda do acompanhamento do time; consultoria de RH parceira, por cliente atendido,
   conforme demanda. Deixa de ser o ponto mais frágil do recorte — era `não medido`, agora é
   `[DITO]`.

4. Por que isso é melhor que a alternativa atual dela?
   A alternativa atual (organograma estático + assessment avulso + consultoria pontual)
   não fica viva depois que o ciclo termina. Aqui o diagnóstico permanece na ferramenta e
   a recomendação de ação é gerada pela mesma leitura de estrutura, não contratada à parte
   (market-scan.md, vpc.md).

5. Qual hipótese arriscada esse recorte testa?
   H1 — RH/HRBP troca a alternativa atual pela Lumea a ponto de pedir para continuar
   usando (proxy de disposição de pagar). Confirmado pela fundadora (resposta 1, 2026-09-13)
   como a aposta mais arriscada.
```

**Por que "operação assistida pela EK" E "self-service" no MVP, ao mesmo tempo (revisado
2026-09-13):** a versão anterior deste documento testava só o modo assistido primeiro, para
isolar a variável de H1 sem misturar com o risco de usabilidade do self-service (H2). A
fundadora rejeitou essa sequência (resposta 8): ela quer testar os dois formatos ao mesmo
tempo, com clientes reais que já tem hoje para cada um. Isso significa que H1 passa a ser
testada em paralelo em dois contextos — com julgamento humano da EK aplicado (tier managed)
e sem ele (tier self-service, cliente-piloto do perfil Marina) — o que na verdade fortalece
o teste de H1 (mostra se o valor percebido depende ou não da EK estar no meio), mas amplia a
superfície de construção do MVP: a ferramenta precisa suportar os dois modos de operação
desde a v1, não só um.

**Corte de largura, não de profundidade:** o job (estrutura → diagnóstico → ação) é
entregue completo para RH/HRBP (ou Persona 5) **e** para o líder de área (Carla, com escopo
de dados permissionado por hierarquia, confirmado resposta 3), com as **quatro** categorias
da biblioteca de ação — não uma. A largura que se corta é o número de **personas** atendidas
(consultoria de RH/Rafael fica para v1.1) e o número de **jobs** aprofundados neste ciclo
(acompanhamento de execução fica para v1.1) — nunca a discriminação entre os quatro tipos de
ação, porque essa discriminação É o próprio Job 2. A inclusão de Carla e do modo self-service
já nesta v1, por decisão explícita da fundadora, é a única exceção documentada à lógica de
"menos personas por ciclo" que orientava o corte original — registrada aqui como decisão da
dona do produto, não como ajuste de critério do Strategist.

**Revisão desta decisão (2026-09-13):** a versão anterior deste documento cortava a
biblioteca de 4 para 1 ação, e listava isso como inferência aberta a confirmar com a
fundadora. O dono do produto rejeitou esse corte explicitamente por ele ter sido justificado
(mesmo que parcialmente) por esforço de codar — ver "Critério de corte do MVP" acima. A
proposta original da fundadora (resposta 20, `jtbd.md`) já incluía as quatro ações no MVP;
o corte para uma foi uma decisão do Strategist, não da fundadora, e está revertida aqui.

---

## Riscos que condicionam este escopo

Ver `risks-assumptions.md` para o detalhe de H1–H5 e os riscos de negócio/legal
complementares (exposição da metodologia proprietária, LGPD/sigilo profissional, ausência
de prazo/orçamento definidos, canibalização entre tiers). H5 — capacidade de entrega do tier
"Lumea + EK" em escala — não é testado por este MVP, mas condiciona se o modelo de negócio do
`bmc.md` funciona depois que H1 for validada. **Atualizado 2026-09-13 (resposta 9):** a
fundadora confirma um teto de **4 clientes simultâneos** que consegue atender bem sozinha
hoje — não é gargalo para o piloto do MVP, mas é o limite conhecido de escala do tier managed
sem contratar/treinar equipe. Ver também os dois riscos novos registrados em
`risks-assumptions.md`: (1) testar os dois tiers simultaneamente pode ampliar o escopo do MVP
em duas frentes de UX/permissão ao mesmo tempo; (2) o permissionamento por papel (RH vs.
líder) é requisito novo de arquitetura, não confirmação de escopo já desenhado.

---

## Inferências abertas (não viraram requisito)

1. `[INFERÊNCIA]` Linha de base numérica de horas manuais hoje (G1, jtbd.md) — só o alvo
   "~1h" foi citado como exemplo, não a linha de base. Não respondido na rodada de
   2026-09-13.
2. `[INFERÊNCIA]` Se a fundadora confirma explicitamente que o MVP deve ser
   lançado/comunicado já como o tier "Lumea + EK" (com esse nome comercial), ou se prefere
   manter o modo assistido como um detalhe interno de operação por enquanto, sem expor a
   linguagem de tiers ao mercado ainda. Não respondido na rodada de 2026-09-13.
3. `[INFERÊNCIA]` (novo, 2026-09-13) Profundidade exata do modo self-service necessário para
   testar os dois tiers simultaneamente (resposta 8) — a fundadora confirmou testar os dois
   formatos ao mesmo tempo, mas não detalhou quanto de onboarding/automação sem intervenção
   da EK o MVP precisa suportar para o cliente-piloto do tier Self-Service.
4. `[INFERÊNCIA]` (novo, 2026-09-13) Como reconciliar o assessment como insumo do diagnóstico
   (resposta 6) com o assessment como uma das quatro ações recomendadas pelo diagnóstico
   (`jtbd.md`/`vpc.md`) — as duas direções de dado coexistem, mas a arquitetura não foi
   desenhada. Ver `risks-assumptions.md`.
5. `[INFERÊNCIA]` Quem decide a compra dentro do RH interno (a própria Marina, ou uma
   liderança acima dela) — não respondido na rodada de 2026-09-13.

**Resolvido nesta revisão (2026-09-13):** frequência de retorno por persona (era item 1),
ponto de entrada do MVP — cliente atual da EK, não consultoria parceira (era item 2),
profundidade das quatro ações no MVP — recomendação + próximo passo basta (era item 4), e o
perfil da Persona 5 — confirmado que varia com a estrutura da empresa-cliente (RH
generalista, ADM ou sócio), não é um cargo único fixo. Todos confirmados por Jane Doe —
ver `risks-assumptions.md`, seção "Perguntas respondidas pela fundadora (2026-09-13)", e
`personas.md`.
