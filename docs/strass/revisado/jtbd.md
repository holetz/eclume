# JTBD — Lumea (motor de inteligência organizacional, EK)

**Fonte primária:** `docs/Questionario_Discovery_StraaS_Respostas_EK_1.docx`, respondido por Jane Doe (fundadora, EK), 03/08/2026.
**Origem das afirmações:** `[DITO]` = resposta direta da fundadora no questionário. `[INFERÊNCIA]` = dedução do Strategist, não confirmada. `[PESQUISA]` = fonte externa, ver `market-scan.md`.

---

## Contexto do problema (raiz comum a todos os jobs)

`[DITO]` Quem cuida da estrutura de pessoas de uma empresa muitas vezes não tem uma visão única, viva e
acionável de como essa estrutura está desenhada e do que precisa ser feito nela. A leitura
da organização (quem lidera quem, dimensionamento de times, risco de liderança, prontidão
de sucessão, o que desenvolver em cada equipe) mora na cabeça de poucas pessoas muitas vezes em
documentos soltos.

`[DITO]` Frequência: contínuo, com picos em ciclos de avaliação de desempenho,
reestruturações, crescimento acelerado, fusões/aquisições e trocas de liderança — a
estrutura muda o tempo todo, então a necessidade nunca zera.

`[DITO]` Impacto: tempo (horas de consultor e de RH montando diagnóstico manual a cada
ciclo), risco (liderança sem sucessor, time super ou subdimensionado, perda de gente boa
por falta de plano de desenvolvimento) e dinheiro (vagas mal dimensionadas, turnover de
liderança, reestruturações erradas).

`[DITO]` Evidência de que o problema é real: experiência direta da fundadora (15+ anos
resolvendo isso manualmente para empresas em transformação), demanda recorrente por
diagnóstico de risco de liderança, e clientes que pedem para repetir o diagnóstico e
querem algo que "fique de pé" depois que a consultoria termina. **Nota de risco:** essa é
evidência qualitativa vinda de uma única fonte (a fundadora) — ainda não há entrevista
direta com usuário final dentro deste discovery. Ver `risks-assumptions.md`. - **sim é preciso fazer esse levantamento, já tenho 6 empresas que aceitaram conversar sobre.** 

---

## Segmentos de usuário mapeados

`[DITO]` Quatro perfis, todos acessando a mesma estrutura organizacional em profundidades/camadas
diferentes, mais uma segunda camada conectada (assessment) que nasce do diagnóstico:

1. **RH interno e Business Partners (HRBPs)** — desenham a estrutura, rodam o diagnóstico,
   acompanham a evolução de várias áreas/clientes.
2. **Consultorias de RH** — usam como ferramenta de trabalho para acompanhar todos os
   clientes que atendem, painel único (potencial multiempresa/white-label).
3. **Líderes e gestores de área (usuário final)** — visão focada no próprio time: o que
   fazer para melhorar performance, tamanho ideal do time, o que desenvolver **aqui é o core, tudo precisa partir da experienica do usuário final, que é o lider**
4. **A própria EK (operadora)** — usa a metodologia dentro da plataforma, tanto para
   entregar aos clientes quanto para escalar a operação interna da consultoria para os clientes.

`[DITO]` Familiaridade digital: RH interno/BPs/consultores — média a alta (já usam sistemas
de gestão de pessoas, planilhas, ferramentas de avaliação). Líderes/gestores de área —
muito variável; alguns só topam usar se for simples, visual e óbvio. Isso é requisito de
usabilidade, não só de feature.

---

## Job 1 — RH interno / HRBP: ter uma leitura viva da estrutura

**Tipo:** Funcional
**Persona:** RH interno / HRBP

> Quando preciso sustentar decisões de estrutura organizacional (headcount, liderança,
> sucessão) para a diretoria ou para as áreas que apoio, quero ter uma leitura sempre
> atualizada de como a estrutura está desenhada e onde estão os riscos, para poder agir
> antes que o problema vire crise (turnover de liderança, time mal dimensionado).

- **Como resolve hoje:** `[DITO]` organograma estático em PowerPoint/Visio/planilha,
  planilha de headcount, matriz 9-box montada à mão, reunião de calibração.
- **Frequência:** `[DITO]` contínua, com picos em ciclos de avaliação e reestruturação —
  não é evento único, é manutenção recorrente. **Cadência confirmada (2026-09-13,
  questionário de acompanhamento):** semanalmente, para acompanhamento.
- **Dor associada:** organograma desatualiza rápido e não diz nada sobre a saúde da
  estrutura (dor funcional, ver seção Pains).

## Job 2 — RH interno / HRBP: transformar diagnóstico em ação, não só em relatório

**Tipo:** Funcional
**Persona:** RH interno / HRBP

> Quando identifico um problema de liderança ou de time (risco de sucessão, time
> desalinhado, líder sem plano de desenvolvimento), quero saber exatamente qual ação tomar
> (assessment, mentoria, redesenho de time, ajuste de tamanho), para não depender de
> reconstruir esse julgamento do zero a cada vez.

- **Como resolve hoje:** `[DITO]` assessments avulsos contratados pontualmente que não
  conversam com o desenho da organização; consultoria pontual que gera insight mas não
  fica viva no dia a dia.
- **Frequência:** `[DITO]` picos em ciclos de avaliação, reestruturação, M&A, troca de
  liderança. **Cadência de base confirmada (2026-09-13):** RH interno de empresa cliente,
  semanalmente; empresa sem RH estruturado (Persona 5, `personas.md`), que também executa
  este job sem ter quem interprete o diagnóstico internamente, diariamente — a maior
  frequência confirmada entre todas as personas.

## Job 3 — Consultoria de RH: acompanhar vários clientes num painel único

**Tipo:** Funcional
**Persona:** Consultoria de RH (dono/consultor)

> Quando atendo vários clientes ao mesmo tempo, quero ver o diagnóstico organizacional e o
> plano de ação de cada um num painel único, para não depender de arquivos e metodologias
> soltas por cliente e poder escalar minha operação de consultoria.

- **Como resolve hoje:** `[DITO]` cada cliente com seu próprio conjunto de documentos e
  diagnósticos pontuais; nada centraliza o acompanhamento entre clientes.
- **Frequência:** contínua enquanto o contrato de consultoria estiver ativo. **Cadência
  confirmada (2026-09-13):** por cliente atendido, conforme demanda — não é frequência fixa
  por calendário.
- **Observação de modelo:** `[DITO]` este é o job por trás da hipótese de canal
  multiempresa/white-label, apontado pela fundadora como maior potencial de escala.

## Job 4 — Líder/gestor de área: saber o que fazer com o próprio time

**Tipo:** Funcional
**Persona:** Líder/gestor de área (usuário final)

> Quando preciso melhorar a performance do meu time ou decidir sobre desenvolvimento,
> sucessão ou tamanho de equipe, quero uma indicação clara do que fazer, para agir com
> autonomia sem depender de esperar o próximo ciclo de consultoria ou RH.

- **Como resolve hoje:** `[DITO]` hoje, segundo a fundadora, o líder simplesmente "não tem
  clareza do que fazer" — não há alternativa estruturada, na melhor das hipóteses recebe um
  relatório de consultoria pontual.
- **Frequência:** **Confirmada (2026-09-13):** sob demanda do acompanhamento do time — deixa
  de ser `não medido`. Não é cadência fixa por calendário, é acionada quando o líder precisa
  acompanhar o time.
- **Visão de longo prazo:** `[DITO]` a fundadora quer que o líder use a ferramenta com
  autonomia ("aqui está o que seu time precisa"), não só o consultor — isso muda o desenho
  da experiência e é uma aposta central do produto.

## Job 5 — EK (operadora): escalar a metodologia sem escalar horas de consultor
TODO: O job 5 está relacionado a operação de um consultora que usa a plataforma para atender seus clientes (A consultoria não necessariamento é a EK, pode ser um empresa de consultoria que contrata a plataforma como ferramenta para atender seus clientes)
TODO: A Jane Doe (fundadora) pode operar como essa persona, mas possui também papel administrativo (que pode ser delegado), para realizar a gestão financeira da plataforma e outras atividades (adminstracao de contas, etc) 
**Tipo:** Funcional
**Persona:** EK / fundadora, como operadora dentro da própria plataforma

> Quando atendo um cliente de consultoria, quero rodar minha metodologia de diagnóstico e
> recomendação dentro de uma ferramenta, para não depender de refazer o trabalho artesanal
> a cada cliente e poder atender mais clientes sem trocar hora por dinheiro linearmente.

- **Como resolve hoje:** `[DITO]` diagnóstico artesanal, dependente da consultora,
  documentos soltos por cliente.
- **Frequência:** a cada novo cliente/ciclo de consultoria (`não medido` em número).
- **Observação:** `[DITO]` este é o job que justifica o "uso interno" do produto — a EK é
  ao mesmo tempo primeira usuária e vitrine comercial.

## Job Social — RH/HRBP: ser visto como estratégico, não administrativo

**Tipo:** Social
**Persona:** RH interno / HRBP

> Quando apresento uma recomendação de estrutura à diretoria, quero embasar a decisão em
> dado e metodologia, para ser visto como parceiro estratégico do negócio, não como quem só
> organiza processo administrativo. `[INFERÊNCIA]` — não foi dito explicitamente pela
> fundadora, deduzido do contexto de "área que precisa sustentar toda a estrutura".

## Job Emocional — Líder de área: segurança na decisão de pessoas

**Tipo:** Emocional
**Persona:** Líder/gestor de área

> Quando preciso decidir sobre desenvolvimento, sucessão ou redesenho do time, quero sentir
> que a decisão tem base e não é palpite, para reduzir a ansiedade de "decisão de pessoas
> no escuro". `[INFERÊNCIA]` a partir da frase da fundadora "decisões de pessoas tomadas no
> escuro" (resposta 5) — não confirmado como sentimento relatado por um líder real.

## Job Emocional — Fundadora/EK: proteger e escalar a metodologia proprietária

**Tipo:** Emocional / estratégico
**Persona:** EK / fundadora

> Quando penso no futuro do negócio, quero transformar a metodologia em produto de
> software antes que uma ferramenta de tecnologia ocupe esse espaço, para não virar
> commodity nem ficar como "mais uma consultoria entre muitas". `[DITO]` resposta 8.

---

## Pains (dores)

| # | Dor | Persona afetada | Severidade | Origem |
|---|-----|------------------|------------|--------|
| P1 | Organograma desatualiza rápido e não diz nada sobre saúde da estrutura | RH/HRBP | ⭐⭐⭐⭐ | `[DITO]` |
| P2 | Diagnóstico depende do consultor e não fica vivo no dia a dia do cliente | RH/HRBP, Consultoria | ⭐⭐⭐⭐⭐ | `[DITO]` |
| P3 | Assessments avulsos não conversam com o desenho da estrutura | RH/HRBP | ⭐⭐⭐ | `[DITO]` |
| P4 | Ninguém consolida — decisão de estrutura no improviso | RH/HRBP, Líder | ⭐⭐⭐⭐ | `[DITO]` |
| P5 | Líder não sabe o que fazer para melhorar performance/tamanho/sucessão do time | Líder/gestor | ⭐⭐⭐⭐⭐ | `[DITO]` |
| P6 | Consultoria não tem painel único para acompanhar vários clientes | Consultoria de RH | ⭐⭐⭐⭐ | `[DITO]` |
| P7 | Modelo de negócio da EK travado em troca de hora por dinheiro, alcance limitado à agenda da consultora | EK | ⭐⭐⭐⭐⭐ | `[DITO]` |
| P8 | Risco de virar commodity se uma empresa de tecnologia ocupar o espaço primeiro | EK | ⭐⭐⭐⭐ | `[DITO]` |

## Gains (ganhos desejados)

| # | Ganho | Persona | Relevância | Origem |
|---|-------|---------|------------|--------|
| G1 | Diagnóstico de estrutura/liderança em ~1 hora em vez de várias horas manuais | RH/HRBP, EK | ⭐⭐⭐⭐⭐ | `[DITO]` (número-alvo "X horas → ~1 hora" citado como exemplo, X não medido) |
| G2 | Recomendação de ação clara a partir do diagnóstico (não só relatório) | RH/HRBP, Líder | ⭐⭐⭐⭐⭐ | `[DITO]` |
| G3 | Painel único para acompanhar múltiplos clientes/áreas | Consultoria, RH/HRBP | ⭐⭐⭐⭐ | `[DITO]` |
| G4 | Autonomia do líder para agir sobre o próprio time sem esperar consultoria | Líder/gestor | ⭐⭐⭐⭐ | `[DITO]` |
| G5 | Estrutura organizacional que fica viva/atualizada, não estática | Todos | ⭐⭐⭐⭐⭐ | `[DITO]` |
| G6 | Novo motor de receita recorrente para a EK | EK | ⭐⭐⭐⭐⭐ | `[DITO]` |
| G7 | Redução de risco de liderança/sucessão/dimensionamento | Todos (valor final ao cliente) | ⭐⭐⭐⭐⭐ | `[DITO]` (ordenação de prioridade, resposta 14) |

---

## Jobs relacionados (antes / durante / depois)

| Quando | Job relacionado |
|--------|------------------|
| Antes | Importar ou montar a estrutura atual (organograma, headcount) dentro da ferramenta |
| Durante | Enriquecer o organograma com informações relevantes para desenvolvimento das soluções (avaliações, performance, tempo de casa, relações, feedbacks, carreira, riscos, potenciais, etc), rodar diagnóstico de liderança/equipe e revisar recomendações da biblioteca de ações |
| Depois | Acompanhar execução das ações (assessment, mentoria, redesenho, sucessão, turnover, desenvolvimento, nivel de prontidao, etc) e ver se o risco caiu |

---

## Inferências abertas (não viraram fato)

1. `[INFERÊNCIA]` Job social do RH ("ser visto como estratégico") — não citado literalmente, deduzido do contexto.
2. `[INFERÊNCIA]` Job emocional do líder ("segurança na decisão") — deduzido da frase "decisões no escuro".
3. `[INFERÊNCIA]` O X horas do Gain G1 (linha de base de tempo manual hoje) não tem valor numérico — só o alvo "~1 hora" foi citado como exemplo pela fundadora.

**Resolvido em 2026-09-13:** frequência de uso esperada por persona — antes item 3 desta
lista, tratada como `não medido` em todos os jobs. Confirmada pela fundadora em questionário
de acompanhamento: RH interno, semanalmente; consultoria de RH, por cliente atendido,
conforme demanda; líder/gestor de área, sob demanda do acompanhamento do time; empresa sem
RH estruturado (Persona 5), diariamente. Ver Job 1, 2, 3 e 4 acima, e `risks-assumptions.md`.
