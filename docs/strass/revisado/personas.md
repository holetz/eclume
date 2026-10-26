# Personas — Lumea

**Input:** `jtbd.md`, `vpc.md`, `bmc.md`.

Todas as personas abaixo são derivadas do questionário da fundadora (`[DITO]`), sem
entrevista direta com usuário real ainda. Nomes e detalhes biográficos são construções
narrativas para facilitar comunicação — os traços de comportamento vêm do documento fonte;
onde não há base, está marcado `[INFERÊNCIA]`.

**Revisão v1.1 (2026-09-13):** `[DITO]` (dono do produto) — o modelo em tiers de `bmc.md`
implica que nem todo cliente RH/HRBP se parece com a Persona 1 (Marina), que já tem
capacidade de interpretar diagnóstico e decidir ação sozinha. A motivação do próprio
direcionamento — "empresas cada vez mais sem profissionais de RH capacitados" — descreve um
segmento diferente, sem alguém no papel de Marina. Adicionada Persona 5 para cobrir esse
caso. Marina permanece válida como arquétipo do tier Self-Service.

---

## Persona 1 — Marina, RH interno / HRBP

**Segmento (bmc.md):** RH interno / HRBP — **tier Self-Service** (revisão 2026-09-13: Marina
já tem a capacidade estratégica de interpretar o diagnóstico e decidir a ação sozinha; é o
arquétipo do cliente que NÃO precisa do julgamento aplicado pela EK. Ver Persona 5 para o
caso oposto.)
**Job principal (jtbd.md):** Job 1 — ter uma leitura viva da estrutura organizacional, e
Job 2 — transformar diagnóstico em ação.

- **Perfil:** `[DITO]` atua dentro de uma empresa, sustenta a estrutura organizacional de
  uma ou mais áreas, familiaridade digital média a alta (já usa sistemas de gestão de
  pessoas, planilhas, ferramentas de avaliação).
- **Objetivo:** sair de "organograma que desatualiza" e "9-box montado à mão" para uma
  leitura sempre atual da estrutura, com recomendação de ação pronta para levar à
  diretoria.
- **Frustrações:** monta diagnóstico do zero a cada ciclo (avaliação, reestruturação);
  assessments avulsos não conversam com o desenho da estrutura; decisão de pessoas às
  vezes sai no improviso porque ninguém consolida a informação.
- **Gatilho de retorno:** `[DITO]` picos recorrentes — ciclos de avaliação de desempenho,
  reestruturação, crescimento, M&A, troca de liderança. **Frequência confirmada pela
  fundadora (resposta 5, 2026-09-13): semanalmente, para acompanhamento** — deixa de ser
  `não medido`. O uso semanal cobre o intervalo entre picos, reduzindo o risco de a
  ferramenta virar "de vez em quando" (ver `risks-assumptions.md`).
- **Como decide comprar/usar:** `[INFERÊNCIA]` provavelmente influencia a decisão de compra
  de RH interno, mas quem decide orçamento pode ser a liderança de RH/diretoria — não
  confirmado.

## Persona 2 — Consultoria de RH (Rafael, sócio de consultoria de RH)

**Segmento:** Consultorias de RH
**Job principal:** Job 3 — acompanhar vários clientes num painel único.

- **Perfil:** `[DITO]` presta serviço de RH para múltiplos clientes, familiaridade digital
  média a alta.
- **Objetivo:** ter um painel único para os diagnósticos e planos de ação de cada cliente,
  em vez de arquivos e metodologias soltas por cliente — escalar a própria operação de
  consultoria.
- **Frustrações:** cada cliente exige montagem manual de diagnóstico; não há como mostrar
  ao mercado uma metodologia consistente entre clientes; a operação não escala além da
  própria agenda.
- **Gatilho de retorno:** enquanto o contrato com o cliente final estiver ativo, cadência
  de acompanhamento contínuo. **Frequência confirmada pela fundadora (resposta 5,
  2026-09-13): por cliente atendido, conforme demanda** — não é uma cadência fixa por mês,
  varia com o volume de clientes e o ritmo de cada contrato.
- **Modelo de negócio relacionado (bmc.md):** é o segmento por trás do canal
  multiempresa/white-label, apontado pela fundadora como o de maior potencial de escala.
  `[DITO]`

## Persona 3 — Líder/gestor de área (Carla, gerente de operações)

**Segmento:** Líderes e gestores de área (usuário final)
**Job principal:** Job 4 — saber o que fazer com o próprio time.
**Status no MVP (confirmado 2026-09-13, resposta 3):** entra desde a v1, não em v1.1. Acessa
com **permissionamento por papel** — vê apenas a estrutura e o diagnóstico da hierarquia
abaixo dela, diferente do RH/HRBP, que vê a estrutura organizacional completa. Ver
`vision-doc.md`, Scope In Scope.

- **Perfil:** `[DITO]` familiaridade digital muito variável — "alguns muito digitais,
  outros que só topam usar se for simples, visual e óbvio" (resposta 12). Não é
  especialista em RH; lidera uma área operacional, comercial, técnica, etc.
- **Objetivo:** entender com clareza o que fazer para melhorar a performance do time, saber
  o tamanho ideal da equipe e os próximos passos de desenvolvimento/sucessão — com
  autonomia, sem depender de esperar o próximo ciclo de RH/consultoria.
- **Frustrações:** hoje não tem clareza nenhuma sobre isso (`[DITO]`, resposta 10); decisões
  de pessoas tomadas "no escuro" (resposta 5); ansiedade associada a decidir sobre gente sem
  base (`[INFERÊNCIA]`).
- **Gatilho de retorno:** **Frequência confirmada pela fundadora (resposta 5, 2026-09-13):
  sob demanda do acompanhamento do time** — deixa de ser `não medido`. Não é uma cadência
  fixa por calendário; é acionada quando há necessidade de acompanhar o próprio time. H2
  (autonomia e retorno espontâneo, `risks-assumptions.md`) segue como hipótese a testar, mas
  a fundadora decidiu incluir Carla no MVP desde já em vez de esperar validação prévia por
  protótipo isolado.
- **Requisito derivado:** interface fortemente visual (tipo organograma), que guie até a
  ação sem exigir treinamento pesado. `[DITO]` (resposta 12). **Requisito novo confirmado
  (resposta 3, 2026-09-13):** o acesso de Carla é permissionado por papel e por posição na
  hierarquia — ela não vê a estrutura organizacional completa, só o que está abaixo dela.
  Isso é requisito de modelo de dados/permissão, não só de UI.

## Persona 4 — EK como operadora (a própria Jane e futura equipe de consultores)

**Segmento:** EK (uso interno)
**Job principal:** Job 5 — escalar a metodologia sem escalar horas de consultor.

- **Perfil:** `[DITO]` fundadora, psicóloga, consultora estratégica com 10+ anos em
  desenvolvimento de lideranças; primeira usuária do produto e ao mesmo tempo dona da
  metodologia que o produto encapsula.
- **Objetivo:** rodar diagnósticos de clientes dentro da própria ferramenta, sair do
  "diagnóstico artesanal" e criar um ativo que fica de pé além da presença física da
  consultora — abrir caminho para escalar a receita além de hora trabalhada.
- **Frustrações:** modelo atual trava receita em troca de hora por dinheiro; risco real de
  um concorrente de tecnologia ocupar esse espaço primeiro e reduzir a metodologia a
  commodity (`[DITO]`, resposta 8).
- **Gatilho de retorno:** a cada novo cliente ou ciclo de consultoria — uso é operacional
  de fato, não só validação de produto. `[DITO]`
- **Papel duplo:** é simultaneamente usuária, dona do ativo intelectual central (a
  metodologia) e decisora de escopo/orçamento do projeto (resposta 2). Qualquer decisão de
  produto que exponha ou replique a metodologia sem proteção adequada é um risco direto
  para esta persona — ver `risks-assumptions.md`.

## Persona 5 — Empresa sem RH estratégico capacitado (cliente do tier Lumea+EK)

**Segmento (bmc.md):** Empresa sem RH estratégico capacitado internamente — **tier Lumea+EK**
**Job principal (jtbd.md):** Job 2 (transformar diagnóstico em ação) — mas sem a capacidade
interna de fechar esse loop sozinha; depende de quem entrega o tier managed (Persona 4 / EK
ou consultor treinado) para completar o job.
**Origem:** persona criada a partir do direcionamento do dono do produto (2026-09-13) e
**confirmada pela fundadora** na rodada de respostas seguinte (resposta 12, 2026-09-13).

- **Perfil:** `[DITO]` (resposta 12) empresa sem um profissional de RH com preparo
  estratégico para interpretar um diagnóstico de liderança/estrutura e decidir ação sozinho.
  O ponto de contato **varia com a estrutura da empresa** — pode ser alguém da área
  administrativa (ADM) ou um sócio; não é um cargo único fixo, confirmado pela fundadora. As
  ações recomendadas ficam a cargo dessa pessoa do lado da empresa-cliente.
- **Objetivo:** resolver o mesmo problema de estrutura/liderança que Marina resolve sozinha,
  mas sem ter internamente quem saiba interpretar o resultado — precisa que alguém (a EK ou
  quem ela treinar) traduza o diagnóstico em decisão concreta.
- **Frustrações:** `[INFERÊNCIA]` recebe (ou recebeu no passado) relatórios de consultoria ou
  assessment que não sabe como aplicar; decisão de pessoas fica no improviso não por falta de
  dado, mas por falta de quem saiba ler o dado (variação do P2/P5 de `jtbd.md` para o caso
  "sem capacidade interna", distinto da leitura original desses pains).
- **Gatilho de retorno:** **Frequência confirmada pela fundadora (resposta 5, 2026-09-13):
  diariamente, pelo responsável/líder da área** — deixa de ser `não medido`. É a maior
  frequência confirmada entre todas as personas, mais alta até que a de Marina (semanal) —
  faz sentido pela dependência maior desse cliente da ferramenta para decisões do dia a dia,
  já que não tem RH estratégico interno para intermediar.
- **Como decide comprar/usar:** `[INFERÊNCIA]` provavelmente é venda consultiva direta com a
  EK (não self-serve), já que o próprio motivo de ser cliente deste tier é não ter alguém
  internamente capaz de avaliar e adotar a ferramenta sozinho.
- **Por que esta persona importa para o corte do MVP:** o MVP já opera em "modo assistido pela
  EK" (`vision-doc.md`) — essa persona é, na prática, quem o MVP atende primeiro, mais do que
  Marina. Ver `vision-doc.md`, seção "Conexão com o modelo de tiers".

---

## Notas de priorização entre personas (para o corte do MVP)

`[DITO]` A fundadora ordenou os objetivos de negócio como: 1º aumentar receita, 2º reduzir
risco, 3º melhorar experiência, 4º reduzir custo (resposta 14, "a validar/ajustar").
Cruzando com as personas: a receita nova (G6) depende de RH/HRBP e Consultorias pagarem
pela assinatura; a redução de risco (G7, o "coração do valor") é sentida por todos, mas
mais fortemente testável com RH/HRBP e Líder de área, que são quem convive com o risco de
estrutura/sucessão no dia a dia. Isso pesa na escolha de qual persona o MVP deve fechar
primeiro (ver `vision-doc.md`).

## Inferências abertas (não confirmadas pela fundadora)

1. `[INFERÊNCIA]` Quem decide a compra dentro do RH interno (a própria Marina, ou uma
   liderança acima dela). Não respondido na rodada de 2026-09-13. quem validda a compra será ou o ceo da empresa, ou diretor ou gerente rh.
2. `[INFERÊNCIA]` Que fração da base de clientes potenciais da EK se encaixa em cada tier
   (Self-Service vs. Lumea+EK) — não medido, afeta diretamente o sizing do `product-owner`.
   Não respondido na rodada de 2026-09-13. podemos fazer a lista, mas com são pmes, a maioria dos clientes tem apenas um rh mais operacional. 

**Resolvido nesta revisão (2026-09-13):** frequência exata de uso por persona (era item 1 —
ver "Gatilho de retorno" em cada persona acima); Carla entra no MVP desde a v1, com
permissionamento por papel (era item 3); perfil concreto da Persona 5 confirmado como
variável — RH generalista, ADM ou sócio, dependendo da estrutura da empresa-cliente (era
item 4). Todos confirmados por Jane Doe — ver `risks-assumptions.md`, seção "Perguntas
respondidas pela fundadora (2026-09-13)".
