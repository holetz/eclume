# Business Model Canvas — Lumea

**Data:** 2026-09-13 (revisão v1.2 — modelo em tiers, confirmado pela fundadora)
**Baseado em:** `jtbd.md`, `vpc.md`
**Origem das afirmações:** `[DITO]` = questionário da fundadora, 03/08/2026 (salvo indicação
contrária). `[DITO] (dono do produto, 2026-09-13)` = direcionamento estratégico dado na
sessão de 13/09; **confirmado pela fundadora Jane Doe na rodada de respostas seguinte,
mesma data** (resposta 7 — reconhece o modelo em tiers como sua estratégia; resposta 11 —
define a precificação em assinatura única + serviço extra). `[INFERÊNCIA]` = dedução do
Strategist, ainda não confirmada.

---

## Revisão v1.1 — Modelo em tiers (2026-09-13)

`[DITO]` (dono do produto, sessão 2026-09-13) — novo direcionamento de modelo de negócio:
pensar a Lumea como **"Service-as-a-Software"**. A plataforma não é o fim em si — é o motor
por trás de um resultado entregue. Motivação declarada: empresas estão cada vez mais sem
profissionais de RH capacitados para agir sobre um diagnóstico organizacional; entregar só o
software (self-service) pode não bastar, porque falta quem aplique o julgamento especialista
sobre o que a ferramenta aponta. Proposta: vender **"RH Estratégico as-a-Service"**, com a
Lumea como motor por trás.

**Conexão com o discovery já feito:** isto não é uma ideia nova isolada — amarra direto em
dois pontos já registrados:
1. `jtbd.md` P8 / `bmc.md` (v1.0) — o diferencial da EK é a metodologia, não o organograma;
   sem alguém aplicando julgamento sobre o diagnóstico, o valor entregue fica incompleto.
2. `risks-assumptions.md` — risco já registrado de a EK virar "mais uma consultoria" se um
   player de tecnologia ocupar o espaço primeiro. O modelo service-as-software vai na direção
   oposta: a IA amplia a atuação da consultora em vez de substituí-la, e um serviço "vivo"
   (não um relatório estático) é o que um ChartHop ou Agentnoon (`market-scan.md`) não
   conseguem copiar só com tecnologia.

**Decisão de modelagem (dono do produto, 2026-09-13):** dois tiers convivendo no mesmo BMC
— **não** substituição do modelo SaaS self-service já mapeado na v1.0 deste documento:

| Tier | Para quem | O que entrega |
|------|-----------|----------------|
| **Tier Self-Service** | Cliente com RH internamente capacitado a interpretar o diagnóstico e decidir a ação sozinho | Acesso à plataforma; o cliente opera o motor de inteligência organizacional sem a EK no meio |
| **Tier "Lumea + EK"** (Service-as-a-Software / "RH Estratégico as-a-Service") | Cliente sem esse profissional capacitado internamente | A mesma plataforma + a EK (ou quem ela treinar) aplicando o julgamento especialista sobre o diagnóstico gerado |

✅ **Confirmado pela fundadora (2026-09-13, resposta 7):** o modelo em dois tiers é
reconhecido explicitamente por Jane Doe como sua estratégia de negócio — deixa de ser
hipótese de modelagem do Strategist. **O que continua não testado com cliente real** é o
preço em si e o critério de elegibilidade ("RH capacitado" vs. "sem capacitação") — a dor de
origem (P2, P7, P8 em `jtbd.md`) está validada, a estrutura de tiers está confirmada, mas
quanto cobrar e como qualificar um cliente para cada tier segue como risco de negócio aberto
(`risks-assumptions.md`, H1/H5).

**Por que isso não contradiz o MVP já definido:** `vision-doc.md` já assume "operação
assistida pela EK" como modo de operação do MVP — na prática, isso já É o tier "Lumea + EK"
em miniatura. O modelo em tiers formaliza essa escolha como proposta de negócio permanente,
em vez de tratá-la só como estágio transitório até um self-service "de verdade". Ver
`vision-doc.md`, seção "Conexão com o modelo de tiers".

---

## Customer Segments

| Segmento | Tier aplicável | Referência JTBD | Descrição |
|----------|-----------------|------------------|-----------|
| RH interno / HRBP — com capacidade estratégica | Self-Service | Jobs 1, 2 | RH que já sabe interpretar o diagnóstico e decidir a ação sozinho; só precisa da ferramenta. `[DITO]` original (segmento já mapeado na v1.0) + `[INFERÊNCIA]` recorte de tier |
| Empresa sem RH estratégico capacitado internamente | Lumea + EK | Jobs 1, 2 | Empresa sem alguém preparado para agir sobre o diagnóstico sozinho — precisa do julgamento da EK ou de quem ela treinar, aplicado sobre a mesma plataforma. **Segmento novo nesta revisão.** `[DITO]` (dono do produto, 2026-09-13); ver `personas.md`, Persona 5 |
| Consultorias de RH | Ambos, por revenda | Job 3 | Consultorias que atendem múltiplos clientes; podem revender o tier self-service (white-label) ou operar o tier Lumea+EK usando a metodologia da EK como camada de julgamento terceirizada. `[DITO]` (canal white-label) + `[INFERÊNCIA]` (se a EK aceitaria delegar julgamento a consultorias externas — não confirmado) |
| Líderes e gestores de área | Usuário final em ambos os tiers | Job 4 | Usuário final — não compra, usa a visão focada no próprio time, independente do tier contratado pelo empregador. `[DITO]` |
| EK (operação interna) | Entrega do tier Lumea+EK | Job 5 | A própria consultoria: primeira usuária, vitrine comercial e — nesta revisão — a capacidade de entrega do tier managed. `[DITO]` |

**Nota:** `[DITO]` empresas "de diversos portes e segmentos" — sem recorte setorial definido
pela fundadora. O critério "RH capacitado vs. sem capacitação" que define o tier é
`[INFERÊNCIA]` do Strategist a partir do direcionamento do dono do produto — não há dado
sobre que fração da base de clientes potenciais da EK cai em cada lado. `não medido`:
tamanho do mercado endereçável, total e por tier.

## Value Propositions

| Segmento / Tier | Proposta de valor | Referência VPC |
|------------------|----------------------|----------------|
| RH/HRBP — Self-Service | Estrutura viva + diagnóstico + ação num só lugar, para quem já sabe agir sozinho sobre o resultado | Pain Relievers P1, P2 (versão self-service), P4 |
| Empresa sem RH capacitado — Lumea + EK | Estrutura viva + diagnóstico + **julgamento especialista aplicado pela EK/consultor treinado** sobre o que fazer — o cliente não fica sozinho com um relatório que não sabe interpretar | Pain Relievers P2 (versão managed), P5, P8 — ver `vpc.md`, seção "Value Map por tier" |
| Consultoria de RH | Painel multiempresa que escala o acompanhamento de clientes sem multiplicar horas, em qualquer tier revendido | Pain Reliever P6, Gain Creator G3 |
| Líder/gestor de área | Clareza acionável sobre o próprio time, com autonomia — a origem da recomendação (self-service ou EK) é transparente para quem consome | Pain Reliever P5, Gain Creator G4 |
| EK | Motor que escala a metodologia proprietária por dois caminhos: licenciamento direto (self-service) e serviço amplificado por IA (tier managed) — dois motores de receita em vez de um | Pain Relievers P7/P8, Gain Creator G6 |

## Channels

| Fase | Canal | Segmento/Tier | Origem |
|------|-------|----------------|--------|
| Awareness | Rede e base de clientes já existente da EK; posicionamento como metodologia (não como "mais um organograma") | Ambos os tiers | `[DITO]` (resposta 11) |
| Evaluation | Uso interno da EK como vitrine/prova de conceito para prospects | Ambos | `[DITO]` (resposta 17) |
| Purchase — Self-Service | `não medido` — hipótese de self-serve signup/trial direto na plataforma | Tier Self-Service | `[INFERÊNCIA]` — precisa validação |
| Purchase — Lumea + EK | Venda consultiva feita pela própria EK, reaproveitando o relacionamento comercial que ela já opera hoje | Tier Lumea + EK | `[DITO]` (dono do produto, 2026-09-13) |
| Delivery — Self-Service | Plataforma SaaS web, sem intervenção humana da EK | Tier Self-Service | `[INFERÊNCIA]` |
| Delivery — Lumea + EK | Plataforma SaaS web + sessão(ões) da EK ou de quem ela treinar aplicando julgamento sobre o diagnóstico | Tier Lumea + EK | `[DITO]` (dono do produto, 2026-09-13) |
| After Sales | `não medido` — suporte, onboarding, sucesso do cliente ainda não desenhados para nenhum tier | Ambos | `[INFERÊNCIA]` |

## Customer Relationships

| Segmento/Tier | Tipo | Descrição |
|----------------|------|-----------|
| RH/HRBP — Self-Service | Self-service, com onboarding assistido inicial (possível linha de serviço à parte) | `[DITO]` resposta 18 + `[INFERÊNCIA]` recorte de tier |
| Empresa sem RH capacitado — Lumea + EK | Assistência pessoal contínua — a EK (ou quem ela treinar) participa do ciclo diagnóstico → julgamento → ação, não só do onboarding | `[DITO]` (dono do produto, 2026-09-13) |
| Consultorias de RH | Parceria/co-criação — a consultoria usa a plataforma para entregar seu próprio serviço aos clientes finais | `[INFERÊNCIA]` a partir do modelo white-label |
| Líder/gestor de área | Self-service, guiado, sem necessidade de treinamento pesado | `[DITO]` (resposta 12) |
| EK | Uso direto, interno; e camada de entrega do tier managed | `[DITO]` |

## Revenue Streams

**Modelo de precificação confirmado pela fundadora (resposta 11, 2026-09-13):** uma
assinatura única para a plataforma, com o acompanhamento da equipe da EK (tier Lumea+EK)
entrando como **serviço extra por cima** — não são planos/preços estruturalmente separados
por tier. A fundadora vê a plataforma como um valor e o "RH as a service" como valor
adicional. Isso substitui a suposição anterior deste documento (v1.1) de dois modelos de
precificação distintos por tier.

| Stream | Modelo | Segmento/Tier | Contribuição estimada | Origem |
|--------|--------|----------------|--------------------------|--------|
| Assinatura da plataforma | Faixas por porte da empresa/nº de colaboradores mapeados — **uma única estrutura de assinatura, comum aos dois tiers** (confirmado, resposta 11) | Ambos os tiers | `não medido` | `[DITO]` original (resposta 18) + `[DITO]` (resposta 11, 2026-09-13) unifica o modelo |
| Acompanhamento da equipe da EK ("RH Estratégico as-a-Service") | **Serviço extra, cobrado por cima da assinatura da plataforma** — não é uma assinatura separada nem uma faixa de preço distinta; é add-on sobre a mesma base | Tier Lumea + EK | `não medido` — hipótese central do novo direcionamento, zero preço testado | `[DITO]` (dono do produto, 2026-09-13; modelo de cobrança confirmado pela fundadora, resposta 11) |
| Multiempresa / white-label | Consultoria externa paga para atender vários clientes dentro da plataforma | Consultorias de RH | `não medido` — apontado pela fundadora como maior potencial de escala | `[DITO]` |
| Serviços de implementação/onboarding | Cobrança à parte | Ambos os tiers | `não medido` | `[DITO]` |
| Plataforma de assessment | Componente do motor de diagnóstico, dentro do escopo técnico deste projeto — **não é mais linha separada fora de escopo** (confirmado, resposta 6, 2026-09-13); modelo de cobrança (incluído na assinatura vs. vendido à parte) ainda não definido | RH/HRBP, mercado geral | `não medido` | `[DITO]` |

**Sinal de disposição de pagar:** `[DITO]` indireto — clientes que recontratam diagnósticos
e pedem acompanhamento contínuo. Esse sinal aponta mais para o tier Lumea+EK (é o que a EK já
entrega hoje, de forma manual) do que para o self-service. **Atualizado 2026-09-13 (resposta
8):** a fundadora vai testar os dois formatos ao mesmo tempo com clientes reais que já tem
hoje para cada um — o self-service deixa de ser um tier "sem nenhum precedente observado" e
passa a ter teste planejado em paralelo ao managed, não depois dele. **Nenhum preço foi
testado ainda para a assinatura nem para o serviço extra.** Levado como risco de negócio em
H1 e no novo H5 (`risks-assumptions.md`).

**Risco de canibalização entre tiers (`[INFERÊNCIA]`, novo):** um cliente elegível para o
tier managed pode preferir o self-service mais barato, falhar sozinho por falta de julgamento
especialista, e gerar churn com a narrativa de que "a ferramenta sozinha não resolve" — o
oposto do que a EK quer provar. O critério de elegibilidade entre tiers precisa considerar
isso; ainda não desenhado.

## Key Resources

| Categoria | Recurso | Propósito |
|-----------|---------|-----------|
| Intelectual | Metodologia proprietária de diagnóstico de liderança e estrutura (10+ anos de prática) | `[DITO]` — ativo central em ambos os tiers |
| Intelectual | Conhecimento de análise comportamental, neurociência e consultoria estratégica da fundadora | `[DITO]` |
| Humano | Fundadora como especialista de domínio; equipe de desenvolvimento (StraaS) | `[DITO]` + `[INFERÊNCIA]` |
| Humano | Capacidade de entrega do tier "Lumea + EK" — a fundadora e/ou consultores que ela recrutar/treinar para aplicar julgamento especialista em escala. **Confirmado (resposta 9, 2026-09-13): a fundadora atende bem 4 clientes simultâneos sozinha hoje** — teto conhecido, suficiente para a demanda inicial, mas exige contratar/treinar equipe para crescer além disso | `[DITO]` (dono do produto, 2026-09-13; teto confirmado pela fundadora) — recurso crítico e teto de escala conhecido, ver `risks-assumptions.md`, H5 |
| Relacional | Base de clientes e rede em RH da EK (acesso a usuários reais para validação) | `[DITO]` (resposta 11) |
| Financeiro | `não medido` — faixa de investimento ainda não definida (resposta 4) | `[DITO]` |

## Key Activities

| Atividade | Categoria | Descrição |
|-----------|-----------|-----------|
| Traduzir metodologia da EK em regras/lógica de recomendação de ação | Produção | Núcleo do "motor de inteligência", serve os dois tiers |
| Desenvolvimento e manutenção da plataforma | Produção | `[INFERÊNCIA]` |
| Operação da metodologia dentro da plataforma pela própria EK | Resolução de problema | Uso interno como validação contínua e, hoje, entrega de fato do tier Lumea+EK |
| Aplicar julgamento especialista sobre o diagnóstico gerado pela plataforma (tier Lumea+EK) | Resolução de problema | `[DITO]` (dono do produto, 2026-09-13) — atividade que diferencia o tier managed; decide o que a IA sugere e o que exige revisão humana |
| Aplicar a divisão confirmada de julgamento IA/humano (meio a meio) no fluxo de diagnóstico | Resolução de problema | `[DITO]` (resposta 10, 2026-09-13) — a IA absorve boa parte do julgamento, mas uma pessoa (a fundadora ou quem ela treinar) sempre revisa e decide antes de finalizar. Deixa de ser proporção `[INFERÊNCIA]`; o que resta em aberto é o desenho da fila de revisão humana e a trilha de auditoria do julgamento aplicado, decisão do `architect`. Ver `risks-assumptions.md`, H5 |
| Recrutar/treinar consultores para escalar a entrega do tier Lumea+EK além da capacidade da fundadora sozinha | Produção / Resolução de problema | `[DITO]` (dono do produto, 2026-09-13) — "quem ela treinar" |
| Expansão da biblioteca de ações ao longo do tempo | Produção | `[DITO]` (resposta 24: "deve ser pensada para crescer com o tempo") |

## Key Partnerships

| Parceiro | Tipo | Motivação | Origem |
|----------|------|-----------|--------|
| Consultorias de RH parceiras (modelo multiempresa/white-label) | Aliança estratégica | Canal de escala apontado pela fundadora como o de maior potencial | `[DITO]` |
| Consultores/profissionais de RH independentes treinados pela EK | Aliança estratégica / capacidade de entrega | Escalar o tier Lumea+EK além da agenda pessoal da fundadora — distinto do parceiro acima: aqui o parceiro entrega julgamento sob a metodologia da EK, não revende a plataforma | `[DITO]` (dono do produto, 2026-09-13); `[INFERÊNCIA]` se será contratação, franquia de metodologia ou outro arranjo — não definido |
| Fornecedores de HRIS (Gupy, Sólides, TOTVS/Protheus, Senior) | Integração futura, não obrigatória no MVP | Reduzir fricção de entrada de dados | `[DITO]` (resposta 22) |
| Google Workspace / Microsoft 365 | Integração futura | Facilitar fluxo de dados e colaboração | `[DITO]` |

## Cost Structure

| Custo | Tipo | Estimativa |
|-------|------|------------|
| Desenvolvimento de produto (StraaS) | Fixo/variável conforme contrato | `não medido` — orçamento a definir a partir do escopo do MVP (resposta 4) |
| Hospedagem em nuvem, com dados no Brasil (aderência LGPD) | Variável | `não medido` |
| Tempo da fundadora como especialista de domínio/produto | Fixo (custo de oportunidade) | `não medido` |
| Tempo de julgamento especialista por cliente do tier Lumea+EK (fundadora e/ou consultores treinados) | **Variável por cliente atendido** — perfil de custo diferente do marginal quase zero do tier self-service. **Confirmado (respostas 9 e 10, 2026-09-13):** teto de 4 clientes simultâneos atendidos bem pela fundadora sozinha; divisão de trabalho meio a meio entre IA e humano, com humano sempre revisando antes de finalizar | `não medido` (valor em R$) — `[DITO]` (dono do produto, 2026-09-13; teto e divisão de trabalho confirmados pela fundadora). Estrutura de custo do tier managed se parece com consultoria (escala com headcount humano), não com SaaS puro; pressiona margem e precisa entrar no sizing do `product-owner`. Com a precificação unificada (resposta 11), o sizing modela o add-on de serviço separadamente da assinatura, não um tier de preço à parte |
| Recrutamento/treinamento de consultores parceiros para o tier managed | Fixo/variável, sob demanda de crescimento | `não medido` — depende de quantos clientes o tier managed precisar atender simultaneamente |
| Compliance e segurança de dados (LGPD, sigilo profissional) | Fixo | `não medido` — tratado como requisito não negociável, não apenas custo |

**Modelo:** `[INFERÊNCIA]` misto — o tier self-service tende a value-driven com estrutura de
custo típica de SaaS (marginal baixo); o tier Lumea+EK tem estrutura de custo mais próxima de
consultoria (escala com gente), o que muda o perfil de margem entre os dois tiers e precisa
ser modelado separadamente no sizing (`product-owner`), não como uma média única.

---

## Coerência do canvas (revisão v1.2 — pós-validação da fundadora)

```
[x] Todo Customer Segment tem ao menos uma Value Proposition? Sim, incluindo o novo
    segmento "empresa sem RH estratégico capacitado".
[~] Toda Value Proposition tem Canal para alcançar o segmento? Parcial — canal de Purchase
    do tier Self-Service continua não definido; o canal do tier Lumea+EK reaproveita a venda
    consultiva que a EK já opera hoje (mais maduro que o self-service).
[ ] Revenue Streams cobrem todos os Customer Segments? Líder/gestor de área não paga
    diretamente em nenhum tier — é usuário, não comprador. Correto para modelo B2B2E,
    registrado para não tratar o líder como fonte de receita no MVP.
[~] Key Resources sustentam Key Activities? Parcial — a atividade "aplicar julgamento
    especialista em escala" depende de um recurso humano (consultores treinados) que ainda
    não existe além da própria fundadora. Ver `risks-assumptions.md`, H5.
[~] Key Partnerships preenchem lacunas de Key Resources/Activities? Parcial — a rede de
    consultores treinados cobriria esse gap, mas o arranjo (contratação, franquia, etc.) não
    está definido.
[ ] Cost Structure contempla todos os itens acima? Não é possível avaliar — quase todos os
    custos estão `não medido`, e o tier managed introduz um tipo de custo (tempo humano por
    cliente) que muda o perfil de margem do negócio inteiro.
```

**Red flag 1 (atualizado v1.2):** Revenue Streams com contribuição `não medido` em 100% das
linhas — não há nenhum preço testado com cliente, nem para a assinatura nem para o serviço
extra de acompanhamento. A precificação agora está confirmada como **um único modelo**
(assinatura + add-on, resposta 11), o que simplifica o sizing em relação à v1.1 (que previa
dois modelos de preço estruturalmente diferentes), mas o valor de cada componente segue como
hipótese pura. O `product-owner` modela assinatura e add-on separadamente, não dois tiers de
preço distintos.

**Red flag 2 (atualizado v1.2):** o tier Lumea+EK depende de um recurso humano (julgamento
especialista) que hoje é uma única pessoa — a fundadora. **Confirmado (resposta 9,
2026-09-13): o teto atual é 4 clientes simultâneos** atendidos bem por ela sozinha — não é
mais incógnita total, é um limite conhecido e baixo. Crescer além disso depende de
contratar/treinar equipe, decisão ainda não tomada. Sem isso, o tier managed não escala além
do piloto — o que reproduziria, dentro do próprio produto, a dor P7 que a Lumea deveria
resolver para a EK (modelo preso a hora por dinheiro). A divisão de trabalho IA/humano
(confirmada meio a meio, resposta 10) ajuda a estender esse teto, mas não o elimina — quanto
exatamente não foi medido. Ver `risks-assumptions.md`, H5.
