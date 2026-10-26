# User Stories — Lumea

**Input:** `personas.md`, `requirements.md`, `spec-questions.md`.

**Nota de gate (atualizada 2026-09-14):** as 9 perguntas de `spec-questions.md` foram
respondidas pela fundadora (Jane Doe, formulário "9 Decisões da Lumea"). Todos os
critérios de aceite que estavam `BLOQUEADO por SQ-NNN` foram reescritos abaixo para refletir
a decisão real, com referência ao FR que a formaliza em `requirements.md`. Duas ressalvas não
foram fechadas por inferência e ficaram sinalizadas em US-1.6 (nota de escopo, ligada a
SQ-006) e US-1.9/AC6 (ligada a SQ-008). Mais tarde no mesmo dia, Sid Hamada esclareceu as
duas em conversa direta com o main loop (não é resposta nova da fundadora nem do formulário):
a de US-1.6 fechou — o mecanismo de contratação confirma o recorte atual do MVP; a de
US-1.9/AC6 reduziu, mas não fechou — a base legal do prazo de retenção agora é dupla (LGPD +
trabalhista), com confirmação jurídica formal ainda pendente. Ver `handoff.yaml` e
`PROJECT.md`.

---

## Verificação de recorte do MVP

As stories US-1.1 a US-1.9 juntas fecham o Job 2 completo do `jtbd.md` — estrutura →
diagnóstico → recomendação dentre as quatro categorias, sem sair da ferramenta — para
RH/HRBP (Marina) e empresa sem RH capacitado (Persona 5), e o Job 4 para o líder de área
(Carla), com o permissionamento por papel confirmado pela fundadora. Nenhuma etapa do job
ficou de fora do MVP: quem lê a estrutura (US-1.1/1.2), quem diagnostica (US-1.3), quem
recomenda (US-1.4), quem revisa no tier managed (US-1.5) ou libera direto no self-service
(US-1.6), e quem consome como líder (US-1.7).

---

### US-1.1: Montar a estrutura organizacional do cliente

**As a** RH/HRBP (Marina) ou responsável pela área numa empresa sem RH capacitado (Persona 5)
**I want to** cadastrar manualmente colaboradores e posições da minha empresa na Lumea
**So that** eu tenho uma leitura viva da estrutura em vez de organograma estático desatualizado

**Acceptance Criteria:**
- [ ] **AC1:** Given que estou logado com papel RH e a estrutura do meu cliente está vazia,
      when eu cadastro uma posição e um colaborador, then eles aparecem na hierarquia exibida.
- [ ] **AC2:** Given que a estrutura do meu cliente ainda não tem nenhum colaborador
      cadastrado, when eu acesso a tela de estrutura, then vejo um estado vazio que me
      direciona para cadastro manual ou importação por planilha, sem exibir dado de outro
      cliente.
- [ ] **AC3:** Given que estou cadastrando um colaborador, when o nome completo e a posição
      coincidem com os de um colaborador já cadastrado no meu cliente, then o sistema sinaliza
      a possível duplicidade antes de confirmar o cadastro, e eu posso revisar ou prosseguir
      mesmo assim (identificação por nome+posição, decisão da fundadora — SQ-002 — é mais
      simples, mas menos precisa, por isso não bloqueia automaticamente).
- [ ] **AC4:** Given que estou logado com papel RH, when eu cadastro uma posição sem vincular
      nenhum colaborador a ela, then a posição aparece na estrutura como vaga, disponível para
      a comparação de dimensionamento entre ocupação real e posições planejadas.

**Size:** M · **Escopo:** MVP
**Requisitos:** FR-001, FR-007, FR-034, FR-036
**Job atendido:** Job 1 (`jtbd.md`) — etapa "antes" do job completo

---

### US-1.2: Importar a estrutura organizacional por planilha

**As a** RH/HRBP (Marina) ou responsável pela área numa empresa sem RH capacitado (Persona 5)
**I want to** importar minha estrutura organizacional já existente via planilha
**So that** eu não preciso recadastrar manualmente uma estrutura que já tenho documentada

**Acceptance Criteria:**
- [ ] **AC1:** Given que tenho uma planilha no formato aceito com colaboradores e hierarquia
      completos, when eu envio o arquivo, then a estrutura organizacional é criada
      correspondendo aos dados da planilha.
- [ ] **AC2:** Given que minha planilha está faltando o campo de hierarquia (quem reporta a
      quem) em uma ou mais linhas, when eu envio o arquivo, then a importação é rejeitada e
      vejo quais linhas e campos estão inválidos.
- [ ] **AC3:** Given que envio um arquivo em formato não suportado (ex.: PDF em vez de
      planilha), when eu tento importar, then o sistema rejeita o upload antes de processar
      qualquer linha e me informa os formatos aceitos.
- [ ] **AC4:** Given que já existe uma estrutura cadastrada para meu cliente, when eu envio
      uma nova planilha, then a estrutura vigente é substituída pelos dados da nova planilha
      — quem não aparece na planilha nova é removido, porque "a planilha nova vale como a
      verdade completa" (decisão da fundadora, SQ-004).
- [ ] **AC5:** Given que estou reimportando planilha sobre uma estrutura já existente, when eu
      confirmo o envio, then o sistema exige minha confirmação explícita antes de aplicar a
      substituição, informando quantos colaboradores e posições serão removidos por não
      constarem na nova planilha.

**Size:** M · **Escopo:** MVP
**Requisitos:** FR-002, FR-003, FR-004, FR-038, FR-039
**Job atendido:** Job 1 (`jtbd.md`) — etapa "antes" do job completo

---

### US-1.3: Rodar o diagnóstico de risco de liderança e dimensionamento

**As a** RH/HRBP (Marina) ou responsável pela área numa empresa sem RH capacitado (Persona 5)
**I want to** rodar o diagnóstico da metodologia da EK sobre a estrutura cadastrada
**So that** eu saiba onde estão os riscos de liderança e de dimensionamento sem montar isso manualmente

**Acceptance Criteria:**
- [ ] **AC1:** Given que minha estrutura organizacional está cadastrada com pelo menos uma
      posição e um colaborador, when eu acionar a execução do diagnóstico, then recebo uma
      classificação de risco de liderança e de dimensionamento para essa estrutura.
- [ ] **AC2:** Given que minha estrutura organizacional está vazia ou sem hierarquia
      definida, when eu tento rodar o diagnóstico, then a execução é bloqueada e vejo o que
      falta cadastrar.
- [ ] **AC3:** Given que acionei o diagnóstico, when o processamento ainda não terminou, then
      vejo um estado de "processando" diferente do estado de resultado pronto, e sou avisado
      quando terminar.
- [ ] **AC4:** Given que acionei o diagnóstico, when o processamento falha, then minha
      estrutura organizacional continua intacta, vejo que o diagnóstico não pôde ser gerado, e
      posso tentar novamente — sem receber um resultado parcial apresentado como completo.
- [ ] **AC5:** Given que já rodei diagnósticos anteriores para esta estrutura, when eu consulto
      o histórico, then vejo os diagnósticos anteriores sem que o novo diagnóstico os
      sobrescreva.

**Size:** L · **Escopo:** MVP
**Requisitos:** FR-008, FR-009, FR-010, FR-011, FR-012
**Job atendido:** Job 1 e Job 2 (`jtbd.md`) — núcleo do job completo

---

### US-1.4: Receber a recomendação de ação correta dentre as quatro categorias

**As a** RH/HRBP (Marina) ou responsável pela área numa empresa sem RH capacitado (Persona 5)
**I want to** saber qual das quatro categorias de ação (assessment, mentoria, redesenho de time, dimensionamento) cabe ao meu caso
**So that** eu não dependa de reconstruir esse julgamento do zero a cada ciclo

**Acceptance Criteria:**
- [ ] **AC1:** Given que um diagnóstico foi gerado para minha estrutura, when eu consulto o
      resultado, then vejo qual das quatro categorias da biblioteca de ações é recomendada,
      discriminada com base no diagnóstico — não sempre a mesma categoria independente do
      caso.
- [ ] **AC2:** Given que recebi uma recomendação, when eu leio o resultado, then vejo a ação
      indicada junto com a orientação do próximo passo, sem exigência de acompanhar a
      execução completa dentro da ferramenta.
- [ ] **AC3:** Given que já recebi recomendações em ciclos anteriores, when eu consulto o
      histórico, then vejo qual recomendação foi dada em cada ciclo, associada ao diagnóstico
      que a originou.
- [ ] **AC4:** Given que o resultado do diagnóstico é ambíguo entre duas categorias, or
      nenhuma categoria se aplica claramente, when eu consulto o resultado, then vejo a
      classificação e uma explicação qualitativa dos fatores considerados, sem exposição de
      pesos ou fórmula (decisão da fundadora, SQ-005).

**Size:** M · **Escopo:** MVP
**Requisitos:** FR-013, FR-014, FR-015, FR-040
**Job atendido:** Job 2 (`jtbd.md`) — núcleo do job completo

---

### US-1.5: Revisar e liberar a recomendação no fluxo assistido (tier "Lumea + EK")

**As a** EK (fundadora) ou consultor treinado
**I want to** revisar a recomendação gerada automaticamente antes de ela chegar ao cliente do tier managed
**So that** eu aplique meu julgamento especialista e não deixe um caso mal enquadrado chegar sem revisão

**Acceptance Criteria:**
- [ ] **AC1:** Given que uma recomendação foi gerada para um cliente do tier "Lumea + EK",
      when o diagnóstico termina, then a recomendação entra em fila de revisão humana antes
      de ser exibida ao cliente.
- [ ] **AC2:** Given que uma recomendação está na fila de revisão, when o cliente do tier
      managed consulta o resultado, then ele vê um estado de "aguardando revisão", distinto de
      "recomendação liberada" e de falha de processamento.
- [ ] **AC3:** Given que estou revisando uma recomendação na fila, when eu decido que ela está
      correta, then posso aprová-la sem alteração e ela é liberada ao cliente.
- [ ] **AC4:** Given que estou revisando uma recomendação na fila, when eu discordo da
      categoria sugerida, then posso editá-la ou substituí-la por outra das quatro categorias
      antes de liberar.
- [ ] **AC5:** Given que aprovei, editei ou substituí uma recomendação, then o sistema
      registra quem revisou, quando, e qual foi a decisão (aprovada sem alteração, editada,
      ou substituída).
- [ ] **AC6:** Given que uma recomendação foi liberada por mim, when o cliente consulta o
      resultado, then ele vê que a recomendação passou por revisão humana da EK.

**Size:** L · **Escopo:** MVP
**Requisitos:** FR-016, FR-017, FR-018, FR-019, FR-021
**Job atendido:** Job 5 (`jtbd.md`) — EK escala a metodologia sem escalar hora por cliente

---

### US-1.6: Receber a recomendação diretamente, sem revisão humana (tier Self-Service)

**As a** RH/HRBP já capacitado (Marina), cliente-piloto do tier Self-Service
**I want to** receber a recomendação assim que o diagnóstico termina, sem esperar revisão da EK
**So that** eu opere o fluxo completo com autonomia, testando se a ferramenta sozinha já basta para o meu caso

**Acceptance Criteria:**
- [ ] **AC1:** Given que sou cliente do tier Self-Service, when uma recomendação é gerada para
      minha estrutura, then ela é liberada diretamente para mim, sem passar pela fila de
      revisão humana.
- [ ] **AC2:** Given que recebi uma recomendação sem revisão humana, when eu consulto o
      resultado, then vejo explicitamente que ela foi liberada pelo tier Self-Service, sem
      revisão da EK.
- [ ] **AC3:** Given que sou um cliente, when eu contrato a Lumea, then eu escolho o tier
      (Self-Service ou "Lumea + EK") e essa escolha fica registrada como atributo da minha
      assinatura, determinando se minhas recomendações passam pela fila de revisão humana ou
      são liberadas direto (decisão da fundadora, SQ-006, formalizada em FR-041).

**Size:** M · **Escopo:** MVP — SQ-006 confirma **quem** escolhe o tier (o cliente, na
contratação). O mecanismo operacional dessa contratação foi esclarecido por Sid Hamada em
conversa direta (2026-09-14, não é resposta da fundadora nem do formulário): os primeiros
clientes compram pela rede de relacionamento da fundadora, e a escolha do tier acontece
dentro dessa negociação — ainda mediada pela EK, não autoatendimento público. Isso confirma
que o recorte atual se mantém: `vision-doc.md` continua restringindo o self-service do MVP a
"pelo menos um cliente-piloto elegível", com onboarding próprio sem intervenção da EK
reservado para v1.1 (Should Have). **Ressalva fechada, sem expansão de escopo** (ver
`spec-questions.md` SQ-006, `handoff.yaml`, `PROJECT.md`). Esta story cobre o mínimo
confirmado (liberação sem fila de revisão + registro do tier na assinatura), não a
comercialização em escala do tier (v1.1, conforme `vision-doc.md`)
**Requisitos:** FR-020, FR-021, FR-041
**Job atendido:** Job 1, Job 2 (`jtbd.md`) — mesmo job completo, sem o tier managed no meio

---

### US-1.7: Ver a hierarquia e a recomendação do próprio time (líder de área)

**As a** líder/gestor de área (Carla)
**I want to** ver o diagnóstico e a recomendação de ação apenas do meu time, sem depender de RH ou consultoria
**So that** eu tenha autonomia para agir sobre o meu time sem esperar o próximo ciclo de consultoria

**Acceptance Criteria:**
- [ ] **AC1:** Given que estou logado com papel líder de área e tenho colaboradores
      subordinados cadastrados, when eu acesso minha visão, then vejo a estrutura, o
      diagnóstico e a recomendação apenas da hierarquia abaixo da minha posição.
- [ ] **AC2:** Given que sou líder de área, when eu tento acessar dado de estrutura,
      diagnóstico ou recomendação fora da hierarquia abaixo de mim, then o acesso é negado.
- [ ] **AC3:** Given que minha posição ainda não tem nenhuma posição subordinada cadastrada,
      when eu acesso minha visão, then vejo um estado vazio explicando que ainda não há time
      sob a minha hierarquia, sem erro e sem dado de outra hierarquia.
- [ ] **AC4:** Given que um RH me atribui o papel de líder de área, when a atribuição é
      concluída, then fico vinculado a uma posição específica da hierarquia e meu escopo de
      visão passa a valer a partir desse momento.
- [ ] **AC5:** Given que minha posição hierárquica muda (promoção, transferência), when a
      mudança é registrada pelo RH, then meu escopo de visão é atualizado automaticamente para
      a nova posição, sem exigir nova atribuição manual de papel.

**Size:** L · **Escopo:** MVP
**Requisitos:** FR-022, FR-023, FR-024, FR-025, FR-026, FR-027
**Job atendido:** Job 4 (`jtbd.md`) — completo, com escopo de dados permissionado por hierarquia

---

### US-1.8: Registrar resultado de assessment como insumo do diagnóstico

**As a** RH/HRBP (Marina) ou responsável pela área numa empresa sem RH capacitado (Persona 5)
**I want to** registrar o resultado de um assessment já aplicado a um colaborador
**So that** esse dado alimente o diagnóstico em vez de ficar isolado num relatório à parte

**Acceptance Criteria:**
- [ ] **AC1:** Given que um colaborador realizou um assessment, when eu registro o resultado
      na ferramenta, then esse resultado é considerado como insumo na próxima execução do
      diagnóstico desse colaborador.
- [ ] **AC2:** Given que já registrei um assessment para um colaborador, when eu consulto o
      histórico dele, then o resultado permanece associado a ele e disponível para
      diagnósticos futuros.
- [ ] **AC3:** Given que o diagnóstico recomenda assessment como ação para um colaborador,
      when eu consulto a recomendação, then ela é apresentada com o mesmo tratamento das
      demais categorias da biblioteca (ação + próximo passo).
- [ ] **AC4:** Given que um colaborador realizou um assessment em ferramenta externa (ex.:
      Sólides, Hogan, DISC), when eu registro o resultado na Lumea (upload manual ou
      integração), then o sistema aceita esse registro como insumo do diagnóstico — o MVP não
      aplica o questionário de assessment dentro da própria ferramenta (decisão da fundadora,
      SQ-009, formalizada em FR-045).

**Size:** L · **Escopo:** MVP — SQ-009 resolveu o canal de aplicação para o MVP (só recebe
resultado externo); a fundadora sinalizou intenção de longo prazo de assessment nativo da
Lumea como **direção, não spec fechada** — não entra nesta story nem em v1.1 confirmado
**Requisitos:** FR-028, FR-029, FR-030, FR-045
**Job atendido:** Job 1, Job 2 (`jtbd.md`) — assessment como insumo e como ação recomendada

---

### US-1.9: Garantir controle de acesso e conformidade legal sobre dados de colaboradores

**As a** RH/HRBP ou EK, responsável pelo tratamento de dados dos colaboradores cadastrados
**I want to** que o sistema exija autenticação por perfil e registre a base legal de tratamento
**So that** o produto não vire bloqueador de lançamento por exposição indevida de dados de terceiros

**Acceptance Criteria:**
- [ ] **AC1:** Given que qualquer usuário tenta acessar estrutura, diagnóstico, recomendação
      ou resultado de assessment, when ele não está autenticado com um perfil válido (RH ou
      líder de área), then o acesso é negado.
- [ ] **AC2:** Given que um colaborador é cadastrado na estrutura, when o cadastro é
      concluído, then o sistema registra a base legal sob a qual os dados desse colaborador
      são tratados, associada ao cliente responsável.
- [ ] **AC3:** Given que um cliente solicita a exclusão dos dados pessoais de um colaborador,
      when a solicitação é processada, then o sistema remove os dados pessoais desse
      colaborador sem exigir a exclusão de todo o histórico agregado do cliente.
- [ ] **AC4:** Given que dados pessoais e resultados de assessment estão armazenados, then
      eles ficam criptografados em repouso e são transmitidos apenas sob TLS 1.2 ou superior.
- [ ] **AC5:** Given que um usuário RH tenta ver o resultado individual de um assessment de
      um colaborador, when ele não tem o sub-papel de acesso a assessment, then o acesso a
      esse dado específico é negado — ele ainda vê que um assessment foi recomendado, mas não
      o resultado detalhado (decisão da fundadora, SQ-007, formalizada em FR-042/FR-043).
- [ ] **AC6:** Given que os dados de um colaborador ou de um cliente com contrato encerrado
      atingem o prazo de retenção de 5 anos, when esse prazo é atingido, then o sistema exclui
      automaticamente esses dados, sem exigir ação manual (FR-044, NFR-LGPD-RETENCAO). ⚠️ O
      prazo de 5 anos foi originalmente a crença declarada pela fundadora ("acredito que 5
      anos", SQ-008). Esclarecido por Sid Hamada em conversa direta (2026-09-14, não é
      resposta da fundadora nem parecer jurídico formal por escrito): a base legal não é só
      LGPD — é também legislação trabalhista (retenção de registros de RH), reduzindo a
      incerteza da resposta anterior. A ressalva não fecha: permanece bloqueador de
      lançamento até validação por assessoria jurídica especializada em LGPD e legislação
      trabalhista.

**Size:** L · **Escopo:** MVP — bloqueador de lançamento, não feature opcional (`vision-doc.md`)
**Requisitos:** FR-031, FR-032, FR-033, FR-042, FR-043, FR-044, NFR-LGPD, NFR-LGPD-RETENCAO
**Job atendido:** transversal a todos os jobs — pré-condição de lançamento comercial

---

## Stories sem AC — verificação (categoria 5 de `squad-ears`)

Todas as 9 stories do MVP têm bloco `Acceptance Criteria` com pelo menos um critério
numerado. Nenhuma story do MVP ficou sem AC.

## Stories de fase posterior (fora do MVP, registradas para rastreabilidade)

- **US-2.1 (v1.1):** Acompanhamento de execução da ação recomendada — marcar se foi feita,
  revisitar se o risco caiu. `vision-doc.md`, Should Have.
- **US-2.2 (v1.1):** Painel multiempresa para consultorias de RH (persona Rafael, Job 3).
  `vision-doc.md`, Should Have — depende de validar H3 antes.
- **US-2.3 (v1.1):** Self-service comercializável em escala (onboarding próprio, billing
  self-serve) — distinto de US-1.6, que cobre só o piloto. `vision-doc.md`, Should Have.

Não escrevo AC para estas três — são fora do recorte desta fase e ficam para o `product-owner`
da próxima rodada de discovery/priorização, quando v1.1 entrar em planejamento.
