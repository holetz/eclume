# VPC — Lumea

**Input:** `jtbd.md`, `market-scan.md`, `bmc.md` (revisão v1.1 — modelo em tiers).

**Revisão v1.1 (2026-09-13):** `[DITO]` (dono do produto) — a Lumea passa a ser modelada em
dois tiers de entrega: **Self-Service** (cliente com RH capacitado a interpretar o
diagnóstico sozinho) e **"Lumea + EK"** (service-as-software: a EK ou quem ela treinar
aplica o julgamento especialista sobre o diagnóstico). O Customer Profile abaixo (jobs,
pains, gains) não muda — vem de `jtbd.md` e é o mesmo para os dois tiers. O que muda é o
**Value Map**: como cada pain é aliviada difere conforme o tier. Ver seção "Value Map por
tier" após os Pain Relievers.

**Revisão v1.2 (2026-09-13) — confirmado pela fundadora:** o modelo em tiers deixa de ser
hipótese de modelagem do Strategist — Jane Doe reconhece explicitamente essa estratégia
(resposta 7). Precificação confirmada como assinatura única + serviço extra por cima
(resposta 11), não dois modelos de preço separados (ver `bmc.md`). A divisão de trabalho
entre IA e julgamento humano no tier Lumea+EK também está confirmada: meio a meio, com humano
sempre revisando antes de finalizar (resposta 10) — ver "Value Map por tier" abaixo. Os dois
tiers serão testados ao mesmo tempo com clientes reais (resposta 8), não em sequência.

---

## Customer Profile

### Jobs

#### Funcionais
1. RH/HRBP: ter leitura viva da estrutura organizacional (Job 1, jtbd.md) — Importância: Alta
2. RH/HRBP: transformar diagnóstico em ação (Job 2) — Alta
3. Consultoria de RH: acompanhar vários clientes num painel único (Job 3) — Alta
4. Líder/gestor de área: saber o que fazer com o time (Job 4) — Alta
5. EK: escalar a metodologia sem escalar horas de consultor (Job 5) — Alta

#### Sociais
1. RH/HRBP: ser visto como estratégico, não administrativo (`[INFERÊNCIA]`, jtbd.md)

#### Emocionais
1. Líder de área: segurança na decisão de pessoas (`[INFERÊNCIA]`, jtbd.md)
2. EK: proteger e escalar a metodologia proprietária (`[DITO]`, jtbd.md)

### Pains (de jtbd.md)

1. Organograma desatualiza rápido, não mostra saúde da estrutura — ⭐⭐⭐⭐ (P1)
2. Diagnóstico depende do consultor, não fica vivo no dia a dia — ⭐⭐⭐⭐⭐ (P2)
3. Assessment avulso não conversa com o desenho da estrutura — ⭐⭐⭐ (P3)
4. Ninguém consolida, decisão no improviso — ⭐⭐⭐⭐ (P4)
5. Líder não sabe o que fazer com o time — ⭐⭐⭐⭐⭐ (P5)
6. Consultoria sem painel único multi-cliente — ⭐⭐⭐⭐ (P6)
7. Modelo da EK travado em hora por dinheiro — ⭐⭐⭐⭐⭐ (P7)
8. Risco de virar commodity para player de tecnologia — ⭐⭐⭐⭐ (P8)

### Gains (de jtbd.md)

1. Diagnóstico em ~1h em vez de várias horas manuais — ⭐⭐⭐⭐⭐ (G1)
2. Recomendação de ação clara, não só relatório — ⭐⭐⭐⭐⭐ (G2)
3. Painel único multi-cliente/área — ⭐⭐⭐⭐ (G3)
4. Autonomia do líder para agir sem esperar consultoria — ⭐⭐⭐⭐ (G4)
5. Estrutura viva, sempre atualizada — ⭐⭐⭐⭐⭐ (G5)
6. Novo motor de receita recorrente para a EK — ⭐⭐⭐⭐⭐ (G6)
7. Redução de risco de liderança/sucessão/dimensionamento — ⭐⭐⭐⭐⭐ (G7)

---

## Value Map

### Produtos & Serviços

- **Motor de inteligência organizacional** — núcleo do produto: desenho da estrutura +
  diagnóstico de liderança/equipes + recomendação de ação, alimentado pela metodologia
  proprietária da EK. `[DITO]`
- **Biblioteca de ações** — assessment (desenvolvimento/sucessão), mentoria, redesenho de
  time, dimensionamento ideal. `[DITO]`
- **Plataforma de assessment** — componente do motor de diagnóstico: alimenta a ferramenta
  com informações que compõem o diagnóstico, e também pode ser recomendada como uma das
  quatro ações da biblioteca. Confirmado pela fundadora (resposta 6, 2026-09-13) que entra no
  escopo técnico deste projeto agora, não como integração futura separada — deixa de ser só
  "nasce do diagnóstico" (direção única) para incluir também "alimenta o diagnóstico"
  (direção de insumo). `[DITO]`
- **Painel multiempresa/multiárea** — para consultorias e RH que acompanham vários
  clientes/áreas ao mesmo tempo. `[DITO]`
- **Importação/montagem de estrutura** — via planilha ou direto na ferramenta (sem
  integração obrigatória no MVP). `[DITO]`
- **Sustentação/alimentação da estrutura** — via imports de transcriçõe de agendas (com conexao nativa
  a ferramentas próprias ou terceiras como github.com/holetz/eclume para obtenção de insumo), relatórios e afins,
  ou manualmente. O processo de sustentação é a etapa recorrente do usuário, e a facilidade dessa operação
  é o que destrava a usabilidade da plataforma como um todo
- **Revenda de Ferramentas de Análise** — os resultados de ferramentas de análise são boa parte do insummo
  necessário para o desenvolvimento de ações (assessment por exemplo), e a revenda dessas ferramentas de
  forma integrada a plataforma deve ser observado como um potencial relevante de negócio
- **Painel de visualização facilitado** — para líderes ou consultores, a plataforma deve entregar as
  condições de fácil visualização/iteração do cenário da empresa/times/pessoas sobre diversas ópticas diferentes
- **"RH Estratégico as-a-Service" (tier Lumea+EK)** — a mesma plataforma acrescida da
  aplicação de julgamento especialista pela EK ou por consultor treinado; não é uma feature
  de produto, é um modelo de entrega vendido junto com a assinatura. `[DITO]` (dono do
  produto, 2026-09-13) — ver `bmc.md`

### Pain Relievers

| Pain (jtbd.md) | Como o produto alivia | Por que é melhor que a alternativa atual (market-scan.md) |
|-----------------|-------------------------|--------------------------------------------------------|
| P1 — organograma desatualiza | Estrutura desenhada dentro da ferramenta, viva, versionada, com histórico | PowerPoint/Visio não notificam mudança nem guardam histórico; concorrentes de org design (ChartHop, Agentnoon) resolvem isso, mas param aqui |
| P2 — diagnóstico depende do consultor | Diagnóstico roda dentro da plataforma e permanece acessível ao cliente após o fim da consultoria pontual | Consultoria tradicional entrega PDF e vai embora; nenhum concorrente de org design ou HRIS oferece metodologia de recomendação embutida |
| P3 — assessment avulso não conversa com a estrutura | Assessment integrado ao motor de diagnóstico nos dois sentidos: alimenta o diagnóstico com dados de avaliação (confirmado, resposta 6) e também pode ser recomendado como uma das quatro ações, não é contratado à parte | Sólides/DISC/Hogan avaliam a pessoa isolada; aqui a leitura de estrutura e o assessment se retroalimentam |
| P4 — ninguém consolida | Um único lugar junta estrutura + diagnóstico + ação | Nenhum concorrente pesquisado integra as três camadas |
| P5 — líder não sabe o que fazer | Biblioteca de ações traduz diagnóstico em passo a passo acionável, exposto na visão do próprio líder | Ferramentas de 9-box (PerformYard, ClayHR) mostram o grid, mas não recomendam ação nem dão autonomia ao líder final |
| P6 — consultoria sem painel único | Painel multiempresa nativo, pensado para quem atende vários clientes | Nenhum concorrente identificado oferece isso como proposta central (é adjacente em HRIS de grande porte, não desenhado para consultoria externa) |
| P7 — modelo hora por dinheiro | SaaS recorrente + modelo multiempresa/white-label desacopla receita de horas de consultor | Consultoria tradicional não tem como escalar horizontalmente; aqui sim |
| P8 — risco de commodity | Metodologia proprietária embutida no produto é o diferencial defensável, não replicável por ferramenta genérica de organograma | Concorrentes de organograma (Agentnoon a US$4/func./mês) competem em preço, não em metodologia — a aposta é competir em outra dimensão |

### Value Map por tier (novo — 2026-09-13)

`[DITO]` (dono do produto) — para as pains onde a diferença entre "ter alguém que aplica
julgamento" e "não ter" muda o alívio entregue, o Pain Reliever se desdobra em dois:

| Pain (jtbd.md) | Alívio — Tier Self-Service | Alívio — Tier Lumea + EK |
|-----------------|------------------------------|-----------------------------|
| P2 — diagnóstico depende do consultor, não fica vivo | O diagnóstico fica disponível na ferramenta; **o próprio RH interpreta e decide a ação** — exige que ele já tenha essa capacidade | O diagnóstico fica disponível **e a EK/consultor treinado aplica o julgamento especialista** sobre o que fazer — cobre exatamente o cliente que não tem essa capacidade internamente |
| P5 — líder/RH não sabe o que fazer com o time | Biblioteca de ações mostra a recomendação; o cliente aplica sozinho | Biblioteca de ações + revisão humana da EK antes de a recomendação chegar ao cliente — reduz o risco de uma recomendação mal aplicada por falta de contexto |
| P7 — modelo da EK travado em hora por dinheiro | Não se aplica à EK diretamente (self-service não consome hora da EK) | A IA pré-processa o diagnóstico e reduz o tempo de julgamento humano por cliente — o objetivo é que a EK atenda mais clientes por hora trabalhada, não zero horas. **Confirmado (resposta 10, 2026-09-13): a divisão é meio a meio — IA absorve boa parte do julgamento, humano sempre revisa e decide antes de finalizar.** Hoje isso sustenta um teto de 4 clientes simultâneos atendidos bem pela fundadora sozinha (resposta 9) — quanto a divisão meio a meio consegue estender esse teto ainda não foi medido |
| P8 — risco de virar commodity | A metodologia embutida na lógica de recomendação já é o diferencial, mesmo sem humano no loop | O julgamento humano aplicado sobre a recomendação da IA é uma segunda camada de defesa: um concorrente de tecnologia pode copiar a lógica de recomendação, mas não replica um serviço "vivo" com a EK por trás — é a resposta direta ao risco já registrado em `jtbd.md`/`bmc.md` de "virar mais uma consultoria" ou "virar commodity" |

**Por que isso não é feature nova, é modelo de entrega:** a plataforma por trás dos dois
tiers é a mesma (`vpc.md` Produtos & Serviços, abaixo). O que muda é se o julgamento sobre o
diagnóstico é aplicado pelo cliente (self-service) ou pela EK/consultor treinado (managed) —
uma decisão de *quem* fecha o loop entre diagnóstico e ação, não uma feature exclusiva de um
tier.

### Gain Creators

| Gain (jtbd.md) | Como o produto entrega |
|-----------------|--------------------------|
| G1 — diagnóstico em ~1h | Estrutura e diagnóstico assistidos por dentro da ferramenta, substituindo montagem manual (meta declarada pela fundadora, `não medido` como linha de base) |
| G2 — recomendação de ação | Biblioteca de ações conectada ao resultado do diagnóstico |
| G3 — painel único multi-cliente | Visão agregada para consultorias/RH com múltiplas áreas |
| G4 — autonomia do líder | Camada de visão dedicada ao líder, com ação recomendada e visual/guiada (requisito de usabilidade, jtbd.md) |
| G5 — estrutura viva | Estrutura como dado vivo dentro do produto, não documento estático, e de fácil sustentação |
| G6 — receita recorrente para EK | Modelo SaaS + white-label para consultorias + revenda de ferramentas de análise (PDA, outras) |
| G7 — redução de risco | Métrica-chave do valor entregue: menos risco de liderança/sucessão/dimensionamento mal calculado |
| G8 — estrutura voltada a resultado | Visões estrategicamente relacionadas a resutados mensuráveis de performance de equipes/pessoas. Sendo facilitada a demonstração de ganhos ou potenciais e suas relações ou oportunidades como diagnóticos ou ações tomadas, propostas ou possíveis |

---

## Fit Assessment

| Necessidade do cliente | Solução | Fit |
|--------------------------|---------|-----|
| Leitura viva da estrutura (Job 1, P1, G5) | Motor de inteligência organizacional | 🟢 |
| Diagnóstico que vira ação (Job 2, P2/P5, G2) | Biblioteca de ações + metodologia proprietária | 🟢 — depende da qualidade da metodologia, ver risco de valor |
| Painel multi-cliente (Job 3, P6, G3) | Painel multiempresa | 🟡 — não detalhado tecnicamente ainda (arquitetura multiempresa/white-label é decisão de `architect`) |
| Autonomia do líder final (Job 4, P5, G4) | Visão dedicada ao líder, com permissionamento por papel | 🟡 — confirmado no MVP desde a v1 (resposta 3, 2026-09-13), mas depende de UX simples/visual para um segmento com familiaridade digital variável (`jtbd.md`) e de um modelo de permissão por hierarquia ainda a desenhar |
| Escalar a EK sem escalar horas (Job 5, P7, G6) | Uso interno como primeira operação | 🟢 |
| Assessment conectado ao diagnóstico (P3, G2) | Plataforma de assessment como componente do motor de diagnóstico | 🟢 — confirmado no escopo técnico deste projeto agora (resposta 6, 2026-09-13), não mais "em desenvolvimento paralelo fora de escopo"; a arquitetura do fluxo de dados nos dois sentidos (insumo e ação recomendada) ainda é decisão do `architect` (ver `risks-assumptions.md`) |
| Empresa sem RH capacitado a agir sobre o diagnóstico (P2/P5/P8, tier Lumea+EK) | Julgamento especialista da EK/consultor treinado aplicado sobre o diagnóstico | 🟡 — a proposta em si é forte e diferenciada (nenhum concorrente pesquisado oferece isso); capacidade de entrega **agora dimensionada em parte** (resposta 9, 2026-09-13: teto de 4 clientes simultâneos atendidos bem pela fundadora sozinha) — não é mais incógnita total, mas segue como teto baixo e conhecido (`bmc.md`, `risks-assumptions.md` H5) |

**Resumo do fit:** a proposta de valor central (integrar estrutura + diagnóstico + ação) não
tem equivalente direto nos concorrentes pesquisados — é o ponto forte da tese, e o modelo em
tiers, confirmado pela fundadora (resposta 7, 2026-09-13), reforça esse diferencial ao amarrar
um serviço humano "vivo" sobre a mesma plataforma, algo que um concorrente de tecnologia pura
não replica. O assessment sai da lista de pontos amarelos nesta revisão — entra confirmado no
escopo técnico do projeto (resposta 6). Restam amarelos em dois pontos: onde depende de UX
para um público de baixa familiaridade digital (líder final, agora confirmado no MVP desde a
v1) e onde a entrega do tier Lumea+EK depende de capacidade humana — esta última passou de
incógnita total para **teto conhecido e baixo (4 clientes simultâneos, resposta 9)**, o que
reduz a incerteza mas não elimina o risco de execução do modelo de negócio além do piloto.
