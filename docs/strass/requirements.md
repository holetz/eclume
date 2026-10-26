# Requisitos — Lumea (EARS)

**Input:** `vision-doc.md` v1.2, `personas.md`, `jtbd.md`, `risks-assumptions.md`, `bmc.md`, `vpc.md`.
**Convenção de ID:** `FR-NNN` (funcional), `NFR-NNN`/`NFR-<NOME>` (não-funcional).
**Origem possível:** `vision-doc: <trecho>` · `spec-detail de FR-NNN` · `spec-questions/SQ-NNN`.

Requisito sem uma dessas três origens não entra neste documento. Onde a lacuna tem mais de
uma resposta defensável, ou o valor é regra de negócio não confirmada pela fundadora, o item
não vira `FR` — vira `SQ` em `spec-questions.md`.

---

## Glossário de domínio (categoria 9 da varredura de omissão)

| Termo | Definição usada neste documento |
|-------|----------------------------------|
| **Estrutura organizacional** | O conjunto de posições e colaboradores de um cliente, organizados em hierarquia (quem reporta a quem) |
| **Posição** | Um nó da hierarquia (cargo/função). Pode estar ocupada por um colaborador ou vaga (confirmado pela fundadora, `spec-questions/SQ-001`, 2026-09-14) |
| **Colaborador** | Pessoa física ocupando uma posição na estrutura de um cliente |
| **Diagnóstico** | Resultado da aplicação da metodologia da EK sobre uma estrutura — classifica risco de liderança e dimensionamento |
| **Recomendação** | Ação sugerida por um diagnóstico, dentre as quatro categorias da biblioteca (assessment, mentoria, redesenho de time, dimensionamento) |
| **Tier Self-Service** | Modo de operação em que a recomendação chega ao cliente sem revisão humana da EK |
| **Tier "Lumea + EK"** | Modo de operação em que a recomendação passa por revisão humana da EK (ou consultor treinado) antes de chegar ao cliente |
| **RH** | Papel com visão da estrutura organizacional completa do cliente |
| **Líder de área** | Papel com visão restrita à hierarquia abaixo da própria posição |

---

## A. Estrutura organizacional (Job 1 — `jtbd.md`)

### FR-001: Cadastro manual da estrutura organizacional

**Tipo:** Event-Driven · **Origem:** vision-doc: "Montagem/importação da estrutura organizacional (dentro da ferramenta ou via planilha)" · **Escopo:** MVP

Quando o usuário com papel RH cadastra uma posição e um colaborador dentro da ferramenta, o
sistema deve adicioná-los à estrutura organizacional do cliente e refletir a mudança na
hierarquia exibida.

---

### FR-002: Importação de estrutura via planilha

**Tipo:** Event-Driven · **Origem:** vision-doc: "Montagem/importação da estrutura organizacional (dentro da ferramenta ou via planilha)" · **Escopo:** MVP

Quando o usuário com papel RH envia uma planilha no formato aceito pela ferramenta, o sistema
deve processar o arquivo e criar a estrutura organizacional correspondente.

---

### FR-003: Validação de dados na importação

**Tipo:** Unwanted · **Origem:** spec-detail de FR-002 · **Escopo:** MVP

Se a planilha enviada não contiver os campos obrigatórios de identificação de colaborador e
de posição hierárquica (quem reporta a quem), então o sistema deve rejeitar a importação e
indicar ao usuário quais linhas e campos estão inválidos.

---

### FR-004: Falha de formato de arquivo na importação

**Tipo:** Unwanted · **Origem:** spec-detail de FR-002 · **Escopo:** MVP

Se o arquivo enviado não estiver em um formato suportado pela ferramenta, então o sistema
deve rejeitar o upload antes de processar qualquer linha e informar os formatos aceitos.

---

### FR-005: Edição de colaborador ou posição já cadastrados

**Tipo:** Event-Driven · **Origem:** spec-detail de FR-001 · **Escopo:** MVP

Quando o usuário com papel RH edita os dados de um colaborador ou de uma posição já
cadastrados, o sistema deve atualizar a estrutura organizacional e preservar o histórico de
diagnósticos gerados antes da edição.

---

### FR-006: Remoção de colaborador ou posição da estrutura

**Tipo:** Event-Driven · **Origem:** spec-detail de FR-001 · **Escopo:** MVP

Quando o usuário com papel RH remove um colaborador ou uma posição da estrutura, o sistema
deve atualizar a hierarquia vigente e manter os diagnósticos e recomendações já gerados como
registro histórico, sem excluí-los.

> Nota: o efeito da remoção sobre o **diagnóstico em aberto** (ainda não revisado/liberado)
> de um colaborador durante o fluxo assistido está resolvido — ver FR-037
> (`spec-questions/SQ-003`).

---

### FR-007: Estado vazio da estrutura organizacional

**Tipo:** State-Driven · **Origem:** spec-detail de FR-001 · **Escopo:** MVP

Enquanto o cliente não tiver nenhum colaborador ou posição cadastrados, o sistema deve exibir
uma tela de estado vazio que direciona explicitamente para cadastro manual ou importação por
planilha, sem apresentar diagnóstico, recomendação ou dado de outro cliente.

---

## B. Diagnóstico de risco de liderança e dimensionamento (Job 1, Job 2)

### FR-008: Execução do diagnóstico

**Tipo:** Event-Driven · **Origem:** vision-doc: "Diagnóstico de risco de liderança e dimensionamento de equipe, usando a metodologia da EK" · **Escopo:** MVP

Quando o usuário aciona a execução do diagnóstico sobre uma estrutura organizacional
cadastrada, o sistema deve aplicar a metodologia da EK e gerar uma classificação de risco de
liderança e de dimensionamento de equipe para essa estrutura.

---

### FR-009: Bloqueio de diagnóstico sem estrutura mínima

**Tipo:** Unwanted · **Origem:** spec-detail de FR-008 · **Escopo:** MVP

Se o usuário tentar executar um diagnóstico sobre uma estrutura organizacional vazia ou sem
hierarquia definida, então o sistema deve impedir a execução e indicar o que falta cadastrar.

---

### FR-010: Estado de processamento do diagnóstico

**Tipo:** State-Driven · **Origem:** spec-detail de FR-008 · **Escopo:** MVP

Enquanto o diagnóstico estiver em processamento, o sistema deve exibir um estado de
"processando" distinto do estado de resultado pronto e do estado de falha, e notificar o
usuário quando o processamento terminar.

---

### FR-011: Falha na geração do diagnóstico

**Tipo:** Unwanted · **Origem:** spec-detail de FR-008 · **Escopo:** MVP

Se o processamento do diagnóstico falhar, então o sistema deve manter a estrutura
organizacional intacta, informar que o diagnóstico não pôde ser gerado e permitir nova
tentativa, sem exibir resultado parcial como se fosse completo.

---

### FR-012: Histórico de diagnósticos por estrutura

**Tipo:** Ubiquitous · **Origem:** spec-detail de FR-008 · **Escopo:** MVP

O sistema deve manter o histórico de diagnósticos já gerados para cada estrutura
organizacional, permitindo consultar diagnósticos anteriores sem sobrescrevê-los ao gerar um
novo.

---

## C. Biblioteca de ações — recomendação (Job 2)

### FR-013: Recomendação cobrindo as quatro categorias

**Tipo:** Event-Driven · **Origem:** vision-doc: "Recomendação de ação cobrindo as quatro categorias da biblioteca (assessment, mentoria, redesenho de time, dimensionamento)" · **Escopo:** MVP

Quando um diagnóstico é gerado, o sistema deve indicar qual, dentre as quatro categorias da
biblioteca de ações (assessment, mentoria, redesenho de time, dimensionamento), corresponde
ao caso diagnosticado, discriminando entre elas conforme o resultado do diagnóstico.

---

### FR-014: Profundidade da recomendação — próximo passo, não execução

**Tipo:** Ubiquitous · **Origem:** spec-detail de FR-013 (confirmado pela fundadora, resposta 2, 2026-09-13) · **Escopo:** MVP

O sistema deve entregar, para cada recomendação, a ação indicada e a orientação do próximo
passo. O sistema não deve exigir que o acompanhamento de execução completa da ação aconteça
dentro da ferramenta no MVP.

---

### FR-015: Histórico de recomendações por ciclo de diagnóstico

**Tipo:** Ubiquitous · **Origem:** spec-detail de FR-013 · **Escopo:** MVP

O sistema deve associar cada recomendação gerada ao diagnóstico e ao ciclo que a originou,
permitindo consultar qual recomendação foi dada em cada ciclo anterior.

---

## D. Tiers — operação assistida ("Lumea + EK") e Self-Service (Job 5, `vision-doc.md`)

### FR-016: Fluxo assistido — fila de revisão humana

**Tipo:** Event-Driven · **Origem:** vision-doc: "Operação assistida pela EK (tier 'Lumea + EK') — a fundadora/consultora aplica julgamento especialista sobre o diagnóstico antes de chegar ao cliente" · **Escopo:** MVP

Quando uma recomendação é gerada para um cliente do tier "Lumea + EK", o sistema deve
colocá-la em fila de revisão humana antes de liberá-la ao cliente.

---

### FR-017: Estado "aguardando revisão" visível ao cliente

**Tipo:** State-Driven · **Origem:** spec-detail de FR-016 · **Escopo:** MVP

Enquanto uma recomendação estiver na fila de revisão humana, o sistema deve exibir ao cliente
um estado de "aguardando revisão", distinto do estado "recomendação liberada" e do estado de
falha de processamento.

---

### FR-018: Aprovação, edição ou substituição da recomendação pela EK

**Tipo:** Event-Driven · **Origem:** spec-detail de FR-016 · **Escopo:** MVP

Quando um usuário com papel de revisor (EK ou consultor treinado) analisa uma recomendação em
fila, o sistema deve permitir aprová-la sem alteração, editá-la, ou substituí-la por outra das
quatro categorias antes de liberá-la ao cliente.

---

### FR-019: Registro de auditoria da revisão humana

**Tipo:** Ubiquitous · **Origem:** spec-detail de FR-018 (insumo direto do `architect`, `risks-assumptions.md` H5: "fila de revisão humana, trilha de auditoria do julgamento aplicado") · **Escopo:** MVP

O sistema deve registrar, para cada recomendação revisada, quem revisou, quando, e se a
recomendação gerada automaticamente foi aprovada, editada ou substituída.

---

### FR-020: Fluxo self-service — liberação direta

**Tipo:** Event-Driven · **Origem:** vision-doc: "Modo self-service mínimo (tier 'Self-Service') — RH já capacitado opera o fluxo estrutura → diagnóstico → recomendação sem revisão humana da EK" · **Escopo:** MVP

Quando uma recomendação é gerada para um cliente do tier Self-Service, o sistema deve
liberá-la diretamente ao cliente, sem passar pela fila de revisão humana.

---

### FR-021: Transparência da origem da recomendação

**Tipo:** Ubiquitous · **Origem:** spec-detail de FR-016/FR-020 (`bmc.md`, Value Map: "a origem da recomendação (self-service ou EK) é transparente para quem consome") · **Escopo:** MVP

O sistema deve indicar ao usuário que consome a recomendação se ela passou por revisão humana
da EK ou foi liberada diretamente pelo tier Self-Service.

---

## E. Permissionamento por papel — RH e líder de área (Job 4)

### FR-022: RH visualiza a estrutura organizacional completa

**Tipo:** Ubiquitous · **Origem:** vision-doc: "RH vê a estrutura organizacional completa" (confirmado, resposta 3, 2026-09-13) · **Escopo:** MVP

O sistema deve permitir que todo usuário com papel RH visualize a estrutura organizacional
completa do cliente, incluindo diagnósticos e recomendações de qualquer posição da hierarquia.

> Nota: o resultado **individual e detalhado de um assessment** é exceção a esta visão
> completa — exige sub-papel adicional dentro do RH. Ver FR-042, FR-043
> (`spec-questions/SQ-007`).

---

### FR-023: Líder de área visualiza apenas a própria hierarquia

**Tipo:** Ubiquitous · **Origem:** vision-doc: "líder vê só a hierarquia abaixo dele" (confirmado, resposta 3, 2026-09-13) · **Escopo:** MVP

O sistema deve restringir a visualização de um usuário com papel líder de área à posição que
ele ocupa e às posições abaixo dela na hierarquia, incluindo os diagnósticos e recomendações
associados apenas a essas posições.

---

### FR-024: Atribuição de papel e vínculo hierárquico

**Tipo:** Event-Driven · **Origem:** spec-detail de FR-022/FR-023 · **Escopo:** MVP

Quando um usuário com papel RH atribui o papel de líder de área a um usuário, o sistema deve
vinculá-lo a uma posição específica da hierarquia e aplicar o escopo de visão dessa posição a
partir desse momento.

---

### FR-025: Bloqueio de acesso fora do escopo permissionado

**Tipo:** Unwanted · **Origem:** spec-detail de FR-023 · **Escopo:** MVP

Se um usuário com papel líder de área tentar acessar dado de estrutura, diagnóstico ou
recomendação fora da hierarquia abaixo de sua posição, então o sistema deve negar o acesso.

---

### FR-026: Líder de área sem subordinados cadastrados

**Tipo:** State-Driven · **Origem:** spec-detail de FR-023 · **Escopo:** MVP

Enquanto a posição de um líder de área não tiver nenhuma posição subordinada cadastrada, o
sistema deve exibir um estado vazio explicando que ainda não há time sob a hierarquia dele,
sem exibir erro nem dado de outra hierarquia.

---

### FR-027: Atualização de escopo por mudança de posição

**Tipo:** Event-Driven · **Origem:** spec-detail de FR-023 · **Escopo:** MVP

Quando a posição hierárquica de um colaborador com papel líder de área é alterada (promoção,
transferência), o sistema deve atualizar automaticamente o escopo de visão desse líder para
refletir a nova posição, sem exigir nova atribuição manual de papel.

---

## F. Plataforma de assessment (Job 1, Job 2 — fluxo de dados em dois sentidos)

### FR-028: Registro de resultado de assessment como insumo do diagnóstico

**Tipo:** Event-Driven · **Origem:** vision-doc: "captura de dados de assessment como insumo para o diagnóstico" (confirmado, resposta 6, 2026-09-13) · **Escopo:** MVP

Quando um resultado de assessment de um colaborador é registrado na ferramenta, o sistema
deve considerar esse resultado como insumo na próxima execução do diagnóstico daquele
colaborador.

---

### FR-029: Assessment como ação recomendada

**Tipo:** Event-Driven · **Origem:** vision-doc: "poder ser recomendada como uma das quatro ações" · **Escopo:** MVP

Quando o diagnóstico indica assessment como a ação recomendada para um colaborador, o sistema
deve apresentar essa recomendação junto com a orientação do próximo passo, seguindo o mesmo
tratamento das demais categorias da biblioteca (FR-013, FR-014).

---

### FR-030: Assessment aplicado passa a compor o histórico do colaborador

**Tipo:** Ubiquitous · **Origem:** spec-detail de FR-028/FR-029 · **Escopo:** MVP

O sistema deve manter o resultado de cada assessment associado ao colaborador que o realizou,
disponível como insumo para diagnósticos futuros do mesmo colaborador.

---

## G. Controle de acesso e LGPD (bloqueador de lançamento — `risks-assumptions.md`, resposta 21)

### FR-031: Controle de acesso por perfil como pré-condição de uso

**Tipo:** Ubiquitous · **Origem:** vision-doc: "Controle de acesso por perfil e tratamento de dados aderente à LGPD" · **Escopo:** MVP

O sistema deve exigir autenticação e vincular todo acesso a um perfil (RH ou líder de área)
antes de exibir qualquer estrutura organizacional, diagnóstico, recomendação ou resultado de
assessment.

---

### FR-032: Base legal para tratamento de dados de colaboradores de terceiros

**Tipo:** Ubiquitous · **Origem:** vision-doc: "dados pessoais de terceiros (colaboradores dos clientes dos clientes)... exige base legal" · **Escopo:** MVP

O sistema deve registrar a base legal sob a qual os dados pessoais de cada colaborador
cadastrado são tratados, associada ao cliente responsável pelo cadastro.

---

### FR-033: Mecanismo de exclusão de dados de colaborador

**Tipo:** Event-Driven · **Origem:** spec-detail de FR-032 (direito de exclusão, LGPD) · **Escopo:** MVP

Quando um cliente solicita a exclusão dos dados pessoais de um colaborador, o sistema deve
prover um mecanismo para atender a essa solicitação sem exigir a exclusão de todo o histórico
de diagnósticos agregados do cliente.

> Nota: o efeito exato dessa exclusão sobre diagnósticos que usaram o dado desse colaborador
> como insumo segue a mesma decisão de FR-037 (`spec-questions/SQ-003`, histórico vs.
> recálculo).

---

## H. Decisões da fundadora — `spec-questions.md` (2026-09-14)

Todos os FRs desta seção têm origem nas 9 respostas de Jane Doe (EK) ao formulário
"9 Decisões da Lumea", que resolveram os marcadores `BLOQUEADO por SQ-NNN` em
`user-stories.md`.

### FR-034: Modelagem de posição vaga na estrutura organizacional

**Tipo:** Ubiquitous · **Origem:** spec-questions/SQ-001 · **Escopo:** MVP

O sistema deve modelar posição como entidade independente do colaborador que a ocupa,
permitindo que uma posição exista na estrutura organizacional sem estar ocupada por nenhum
colaborador (posição vaga).

---

### FR-035: Comparação entre ocupação real e posições planejadas

**Tipo:** Event-Driven · **Origem:** spec-questions/SQ-001 · **Escopo:** MVP

Quando o diagnóstico de dimensionamento é executado, o sistema deve comparar o número de
posições ocupadas com o número total de posições planejadas (incluindo vagas) na estrutura,
e refletir essa diferença no resultado do diagnóstico.

---

### FR-036: Detecção de duplicidade por nome completo e posição

**Tipo:** Unwanted · **Origem:** spec-questions/SQ-002 · **Escopo:** MVP

Se um colaborador cadastrado (manualmente ou por importação) tiver nome completo e posição
idênticos a um colaborador já existente na estrutura do mesmo cliente, então o sistema deve
sinalizar a duplicidade ao usuário antes de confirmar o cadastro, permitindo revisar ou
prosseguir mesmo assim.

> Nota: a fundadora escolheu esta identificação conscientemente como "mais simples, mas
> menos precisa" (`spec-questions.md`, SQ-002) — por isso o comportamento é sinalizar e
> deixar o usuário decidir, não bloquear automaticamente. Nome e posição iguais podem ser
> coincidência entre pessoas diferentes; bloquear sem confirmação geraria falso positivo.

---

### FR-037: Aviso de colaborador removido em diagnóstico/recomendação pendente

**Tipo:** Event-Driven · **Origem:** spec-questions/SQ-003 · **Escopo:** MVP

Quando um colaborador associado a um diagnóstico ou recomendação ainda não liberado (em fila
de revisão humana) é removido da estrutura, o sistema deve manter esse diagnóstico ou
recomendação em aberto e sinalizar ao revisor que o colaborador foi removido, deixando a
decisão de prosseguir, editar ou descartar a cargo de quem revisar.

---

### FR-038: Reimportação de planilha substitui a estrutura vigente

**Tipo:** Event-Driven · **Origem:** spec-questions/SQ-004 · **Escopo:** MVP

Quando o usuário com papel RH reimporta uma planilha para um cliente que já tem estrutura
organizacional cadastrada, o sistema deve substituir a estrutura vigente pelos dados da nova
planilha, removendo colaboradores e posições que não aparecem na nova planilha.

---

### FR-039: Confirmação explícita antes de reimportação substitutiva

**Tipo:** Unwanted · **Origem:** spec-detail de FR-038 · **Escopo:** MVP

Se a reimportação de planilha for acionada sobre um cliente que já possui estrutura
cadastrada, então o sistema deve exigir confirmação explícita do usuário antes de aplicar a
substituição, informando quantos colaboradores e posições serão removidos por não constarem
na nova planilha.

> Nota: os colaboradores/posições removidos por reimportação seguem a mesma regra de
> histórico de FR-006 (diagnósticos e recomendações já gerados não são excluídos) e, se
> algum tiver diagnóstico/recomendação em aberto, a mesma regra de FR-037 se aplica.

---

### FR-040: Transparência qualitativa do resultado do diagnóstico

**Tipo:** Ubiquitous · **Origem:** spec-questions/SQ-005 · **Escopo:** MVP

O sistema deve exibir, para cada diagnóstico gerado, a classificação de risco resultante e
uma explicação qualitativa dos fatores considerados, sem expor os pesos numéricos ou a
fórmula de cálculo utilizados pela metodologia.

> Nota: isto resolve também a comunicação do caso em que o diagnóstico é ambíguo entre duas
> categorias da biblioteca de ações, ou nenhuma se aplica claramente (`user-stories.md`,
> US-1.4/AC4) — a explicação qualitativa cobre esse caso do mesmo jeito, sem expor pesos.

---

### FR-041: Tier do cliente definido na contratação

**Tipo:** Event-Driven · **Origem:** spec-questions/SQ-006 · **Escopo:** MVP

Quando um cliente contrata a Lumea, o sistema deve registrar o tier escolhido pelo cliente
(Self-Service ou "Lumea + EK") como atributo da assinatura, e usar esse atributo para
determinar se as recomendações desse cliente passam pela fila de revisão humana (FR-016) ou
são liberadas diretamente (FR-020).

> ⚠️ Nota — ressalva original: a fundadora confirmou **quem** escolhe o tier (o cliente, no
> ato da contratação), mas o "9 Decisões da Lumea" não confirmou **o mecanismo operacional**
> dessa contratação no MVP. `vision-doc.md` descreve o self-service do MVP como restrito a
> "pelo menos um cliente-piloto elegível" e reserva "onboarding próprio sem intervenção da
> EK" para v1.1 (Should Have).
>
> **Esclarecimento (2026-09-14, Sid Hamada em conversa direta — não é resposta da fundadora
> nem do formulário):** os primeiros clientes compram pela rede de relacionamento da
> fundadora, e a escolha do tier acontece dentro dessa negociação — ainda mediada pela EK,
> não autoatendimento público. Isso confirma que o recorte atual se mantém: este FR cobre o
> armazenamento e o roteamento do tier escolhido dentro de uma contratação mediada pela EK,
> sem exigir fluxo de contratação self-service no MVP. **Ressalva fechada, sem expansão de
> escopo.** Ver `spec-questions.md` SQ-006.

---

### FR-042: Sub-papel de acesso a resultado individual de assessment

**Tipo:** Unwanted · **Origem:** spec-questions/SQ-007 · **Escopo:** MVP

Se um usuário com papel RH não tiver o sub-papel de acesso a assessment, então o sistema
deve negar a visualização do resultado individual e detalhado de um assessment de qualquer
colaborador, permitindo apenas ver que um assessment foi recomendado.

---

### FR-043: Atribuição do sub-papel de acesso a assessment

**Tipo:** Event-Driven · **Origem:** spec-detail de FR-042 · **Escopo:** MVP

Quando um usuário com papel RH recebe o sub-papel de acesso a assessment, o sistema deve
passar a permitir a esse usuário a visualização do resultado individual e detalhado de
qualquer assessment dentro do escopo de visão já permissionado pelo papel RH (FR-022).

---

### FR-044: Exclusão automática ao fim do prazo de retenção

**Tipo:** Event-Driven · **Origem:** spec-questions/SQ-008 · **Escopo:** MVP

Quando o prazo de retenção definido em NFR-LGPD-RETENCAO é atingido para os dados pessoais
de um colaborador ou de um cliente com contrato encerrado, o sistema deve excluir
automaticamente esses dados, sem exigir ação manual do usuário, salvo solicitação de
exclusão antecipada já processada por FR-033.

---

### FR-045: Canal de aplicação do assessment no MVP — importação de resultado externo

**Tipo:** Event-Driven · **Origem:** spec-questions/SQ-009 · **Escopo:** MVP

Quando um resultado de assessment aplicado por ferramenta externa (ex.: Sólides, Hogan,
DISC) é disponibilizado pelo cliente, o sistema deve permitir seu registro na Lumea (upload
manual ou integração), servindo como insumo do diagnóstico (FR-028). O MVP não aplica o
questionário de assessment dentro da própria ferramenta.

> Nota (direção de longo prazo, não requisito fechado): a fundadora sinaliza intenção
> futura de o cliente poder optar por assessment nativo da Lumea, solicitar inclusão
> depois, ou trazer outro assessment externo. Por declaração explícita dela, isso "ainda não
> está definido em detalhe, é direção, não spec fechada" — não é requisito do MVP nem do
> v1.1 confirmado, e não deve ser tratado como tal até nova rodada de discovery.

---

## Requisitos não-funcionais

### NFR-LGPD: Criptografia de dados sensíveis

O sistema deve armazenar dados pessoais de colaboradores e resultados de assessment
criptografados em repouso, e transmiti-los apenas sob TLS 1.2 ou superior.

---

### NFR-LGPD-RETENCAO: Prazo de retenção de dados pessoais e de assessment

**Origem:** spec-questions/SQ-008 · **Escopo:** MVP

O sistema deve reter dados pessoais de colaboradores e resultados de assessment por até 5
anos após o encerramento do contrato do cliente ou a remoção do colaborador da estrutura,
disparando a exclusão automática definida em FR-044 ao final desse prazo, salvo solicitação
de exclusão antecipada pelo cliente (FR-033).

> ⚠️ **O prazo de 5 anos foi originalmente uma crença declarada pela fundadora** ("acredito
> que 5 anos, conforme o prazo dos demais registros legais de RH" — `spec-questions.md`,
> SQ-008), não uma orientação jurídica formal confirmada.
>
> **Esclarecimento (2026-09-14, Sid Hamada em conversa direta — não é resposta da fundadora
> nem parecer jurídico formal por escrito):** confirma o prazo fixo de 5 anos e esclarece que
> a base legal não é só LGPD — é também legislação trabalhista (retenção de registros de RH).
> A base de trabalho agora é dupla (LGPD + trabalhista), reduzindo a incerteza da resposta
> anterior, que não citava nenhuma base. `vision-doc.md` marca LGPD como "bloqueador de
> lançamento, não feature opcional" — este prazo e sua base dupla ainda devem ser validados
> (ou corrigidos) por assessoria jurídica especializada em LGPD, legislação trabalhista e
> sigilo profissional de psicóloga antes do lançamento comercial. Até lá, tratar 5 anos como
> valor de trabalho no schema, não como requisito legal fechado. Ver `spec-questions.md`
> SQ-008.

---

### NFR-CAPACIDADE: Fila de revisão humana no tier managed

**Origem:** `risks-assumptions.md`, H5 (teto confirmado de 4 clientes simultâneos, resposta 9, 2026-09-13)

A arquitetura da fila de revisão humana deve suportar, sem redesenho, o crescimento do número
de clientes simultâneos atendidos no tier "Lumea + EK" além do teto atual de 4 — o teto é
limite de capacidade humana da EK hoje, não limite técnico aceitável para o produto.

---

### NFR-USABILIDADE-LIDER: Navegação sem treinamento formal

**Origem:** `personas.md`, Persona 3 (Carla) — "alguns muito digitais, outros que só topam usar se for simples, visual e óbvio" (resposta 12)

A visão do líder de área deve apresentar a hierarquia abaixo dele em formato gráfico
(organograma) e a recomendação de ação de forma navegável sem exigir treinamento formal
prévio, dado o perfil de familiaridade digital variável desta persona. Detalhamento de
interação é responsabilidade do `ux-ui-designer` (Fase 02).

---

## Completude de conjunto — checklist

- [x] Toda capacidade do recorte MVP (`vision-doc.md`, In Scope) tem pelo menos um FR: estrutura (FR-001/002), diagnóstico (FR-008), recomendação 4 categorias (FR-013), visão do líder permissionada (FR-023), operação assistida (FR-016), self-service (FR-020), assessment (FR-028/029), controle de acesso/LGPD (FR-031/032)
- [x] Todo FR com entrada de dado (FR-001, FR-002, FR-028) tem FR de validação e de caminho de erro (FR-003, FR-004, FR-009, FR-011)
- [x] Todo FR que cria entidade persistida (FR-001, FR-002, FR-008, FR-013, FR-028) tem FR de ciclo de vida ou justificativa (FR-005, FR-006, FR-012, FR-015, FR-030)
- [x] Nenhum FR com indicador de ambiguidade (palavra fraca, opcionalidade, lista aberta, marcador de incompleto) não resolvido — ver varredura abaixo
- [x] Nenhuma SQ sem resposta ou sem marca `[INFERÊNCIA]` — **as 9 SQs foram respondidas pela
      fundadora em 2026-09-14 (ver `spec-questions.md`), gerando FR-034 a FR-045 e
      NFR-LGPD-RETENCAO. Duas ressalvas ficaram abertas por natureza (não por omissão) e
      foram esclarecidas por Sid Hamada em conversa direta no mesmo dia (não é resposta nova
      da fundadora): o mecanismo de contratação do tier em FR-041 (`SQ-006`) fechou — confirma
      que o recorte atual do MVP se mantém, sem expansão de escopo; a base legal do prazo de
      retenção em NFR-LGPD-RETENCAO (`SQ-008`) passou a ser dupla (LGPD + trabalhista), mas a
      confirmação jurídica formal ainda está pendente. Ambas viajam para o `architect` via
      `handoff.yaml` com o status atualizado.**
- [x] Todo NFR tem critério verificável (TLS 1.2+, sem redesenho para além de 4 clientes, navegação sem treinamento formal como critério de usabilidade a testar na Fase 02, retenção de 5 anos com exclusão automática)
- [x] Nenhum par de requisitos em contradição

**Varredura de ambiguidade rodada contra os 45 FRs:** nenhuma palavra fraca (rápido, robusto,
intuitivo) usada como critério de aceite; nenhuma lista aberta ("etc.") — a biblioteca de
ações é enumerada nas quatro categorias em todo FR que a referencia; nenhum "pode/deveria" em
requisito (só em notas explicativas fora do corpo EARS); nenhum marcador de incompleto (TBD)
— toda lacuna sem resposta única foi extraída para `spec-questions.md` e, desde 2026-09-14,
todas as 9 estão respondidas.
