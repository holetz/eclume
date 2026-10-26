# Spec Questions — decisões da fundadora

> Cada pergunta trava um requisito ou uma story. Respondida vira `FR` ou emenda um `FR`
> existente; "Não sei" vira `[INFERÊNCIA]` registrada e viaja no handoff para o `architect`.
> Nenhuma foi respondida por inferência do product-owner — valor de regra de negócio ou
> decisão de produto com mais de uma resposta defensável não é decidido aqui.

**Status (2026-09-14): as 9 perguntas foram respondidas por Jane Doe (EK) via o
formulário "9 Decisões da Lumea".** As respostas foram propagadas para `requirements.md`
(FR-034 a FR-045, NFR-LGPD-RETENCAO) e `user-stories.md` (marcadores `BLOQUEADO por SQ-NNN`
resolvidos). Duas ressalvas não foram fechadas por inferência do `product-owner` — ver notas
em SQ-006 e SQ-008 abaixo. Mais tarde no mesmo dia, Sid Hamada esclareceu as duas em conversa
direta com o main loop (não é resposta nova da fundadora nem do formulário "9 Decisões da
Lumea"): a ressalva de SQ-006 fechou (o mecanismo de contratação confirma o recorte atual do
MVP, sem expansão de escopo); a ressalva de SQ-008 reduziu, mas não fechou (a base legal
agora é dupla — LGPD e legislação trabalhista —, com confirmação jurídica formal ainda
pendente). Ver `handoff.yaml`/`PROJECT.md`.

---

## Categoria: modelagem da estrutura organizacional

### SQ-001 — Posição vaga (headcount planejado) entra no escopo de dados?

**Trava:** FR-001, FR-002 (cadastro/importação da estrutura)

`jtbd.md` cita "planilha de headcount" como uma das ferramentas manuais que a Lumea substitui,
o que sugere que dimensionamento de equipe compara headcount **atual** com headcount
**ideal/planejado** — não só pessoas hoje na empresa. Isso muda o modelo de dados: a estrutura
organizacional modela só colaboradores atualmente contratados, ou também posições vagas ou
planejadas que ainda não têm ninguém?

- **(A)** Só colaboradores atualmente na empresa. Posição vaga não é uma entidade da estrutura.
- **(B)** Estrutura modela posições (podem estar vagas) e colaboradores (ocupam posições).
  Dimensionamento compara ocupação real com posições planejadas.
- **(C)** Não sei — registrar como `[INFERÊNCIA]` e o `architect` desenha o modelo de dados
  mais flexível possível até a decisão vir.

**Resposta:** **(B)** Estrutura modela posições (podem estar vagas) e colaboradores (ocupam
posições); dimensionamento compara ocupação real com posições planejadas. Respondido pela
fundadora via formulário "9 Decisões da Lumea" (2026-09-14). Ver `requirements.md` FR-034,
FR-035.

---

### SQ-002 — Identificação de duplicidade de colaborador

**Trava:** spec-detail de FR-001 (ainda não escrito como FR — depende desta resposta)

Se dois cadastros (manual ou por importação) parecem representar a mesma pessoa, qual campo
o sistema usa para considerá-los duplicados?

- **(A)** E-mail corporativo do colaborador.
- **(B)** Documento de identificação (CPF).
- **(C)** Nome completo + posição — mais frágil, mas não exige capturar dado sensível
  adicional.
- **(D)** Não é um problema a resolver no MVP — duplicidade fica visível para o RH corrigir
  manualmente, sem bloqueio automático.
- **(E)** Não sei — registrar como `[INFERÊNCIA]`.

**Resposta:** **(C)** Duplicidade por nome completo + cargo — mais simples, mas menos
preciso. A fundadora aceitou conscientemente o trade-off de precisão. Respondido via
formulário "9 Decisões da Lumea" (2026-09-14). Ver `requirements.md` FR-036.

---

## Categoria: ciclo de vida e efeito de remoção

### SQ-003 — Efeito da remoção de colaborador sobre diagnóstico/recomendação em aberto

**Trava:** FR-006 (nota), FR-033 (nota)

Quando um colaborador é removido da estrutura (desligamento, correção de cadastro, ou
solicitação de exclusão de dados) e há um diagnóstico ou recomendação **ainda não liberado**
(na fila de revisão humana) que depende dele, o que o sistema faz?

- **(A)** Cancela o diagnóstico/recomendação em aberto para esse colaborador.
- **(B)** Mantém o diagnóstico/recomendação em aberto, sinalizando que o colaborador foi
  removido depois da geração, e deixa o revisor decidir.
- **(C)** Bloqueia a remoção do colaborador enquanto houver diagnóstico/recomendação em
  aberto associado a ele.
- **(D)** Não sei — registrar como `[INFERÊNCIA]`.

**Resposta:** **(B)** Mantém o diagnóstico/recomendação em aberto, sinalizando que o
colaborador foi removido depois da geração, e deixa o revisor decidir. Respondido via
formulário "9 Decisões da Lumea" (2026-09-14). Ver `requirements.md` FR-037. Esta resposta
também corrige a referência a "SQ-002" nas notas de FR-006 e FR-033 — o número correto
sempre foi SQ-003.

---

### SQ-004 — Reimportação de planilha sobre estrutura já existente

**Trava:** FR-002 (ainda sem FR de reimportação — depende desta resposta)

Quando o RH importa uma nova planilha para um cliente que já tem estrutura cadastrada
(manualmente ou por importação anterior), o que acontece com os dados já existentes que não
aparecem na nova planilha?

- **(A)** Substitui a estrutura inteira pela nova planilha (quem não está na nova planilha é
  removido).
- **(B)** Mescla: atualiza quem já existe, adiciona quem é novo, e mantém quem não aparece na
  nova planilha até remoção explícita.
- **(C)** Rejeita a reimportação e exige que toda alteração posterior à primeira importação
  seja manual.
- **(D)** Não sei — registrar como `[INFERÊNCIA]`.

**Resposta:** **(A)** Substitui a estrutura inteira pela nova planilha (quem não está na
nova planilha é removido) — "a planilha nova vale como a verdade completa". Respondido via
formulário "9 Decisões da Lumea" (2026-09-14). Ver `requirements.md` FR-038 (substituição) e
FR-039 (confirmação explícita antes de aplicar, spec-detail desta resposta).

---

## Categoria: exposição da metodologia proprietária (ligada a risco já registrado)

### SQ-005 — O diagnóstico exibe os critérios/pesos, ou só o resultado final?

**Trava:** FR-008 (spec-detail de transparência do resultado, ainda não escrito)

`risks-assumptions.md` registra como risco de negócio a exposição da metodologia proprietária
da EK ("se o produto expõe essa lógica de forma replicável... o diferencial esvai"). Isso tem
efeito direto na tela de resultado do diagnóstico: o cliente (RH ou líder) vê os critérios e
pesos que levaram à classificação de risco, ou vê apenas a classificação final e a
recomendação, sem o "porquê" detalhado?

- **(A)** Mostra só a classificação final (ex.: "risco alto") e a recomendação — sem detalhar
  os critérios internos.
- **(B)** Mostra a classificação e uma explicação qualitativa dos fatores considerados, sem
  expor pesos ou fórmula.
- **(C)** Mostra o detalhamento completo dos critérios usados — maior transparência para o
  cliente, mas o risco de exposição citado em `risks-assumptions.md` se aplica.
- **(D)** Não sei — registrar como `[INFERÊNCIA]`.

**Resposta:** **(B)** Mostra a classificação e uma explicação qualitativa dos fatores
considerados, sem expor pesos ou fórmula. Respondido via formulário "9 Decisões da Lumea"
(2026-09-14). Ver `requirements.md` FR-040. Resolve também a comunicação de caso ambíguo em
`user-stories.md` US-1.4/AC4.

---

## Categoria: regra de negócio entre tiers

### SQ-006 — Critério de elegibilidade de um cliente a cada tier

**Trava:** FR-016, FR-020 (qual fluxo se aplica a qual cliente)

`risks-assumptions.md` já registra este ponto como risco em aberto ("critério de
elegibilidade/recomendação de quando oferecer o serviço extra ainda não desenhado"). Sem essa
regra, o sistema não sabe se uma estrutura/cliente específico deve passar pela fila de
revisão humana (FR-016) ou ser liberada direto (FR-020). Como o sistema determina isso?

- **(A)** Configuração manual por cliente, feita pela EK ao cadastrar o cliente (o tier é um
  atributo do cliente, definido na criação da conta).
- **(B)** O próprio cliente escolhe o tier ao contratar, e isso é armazenado como atributo da
  assinatura.
- **(C)** Todo cliente roda em modo assistido por padrão; self-service é uma exceção ativada
  manualmente pela EK para os pilotos.
- **(D)** Não sei — registrar como `[INFERÊNCIA]`. **(Já sinalizado como aberto por
  `handoff-strategy.yaml` — profundidade do self-service não detalhada.)**

**Resposta:** **(B)** O próprio cliente escolhe o tier ao contratar, e isso é armazenado
como atributo da assinatura. Respondido via formulário "9 Decisões da Lumea" (2026-09-14).
Ver `requirements.md` FR-041.

⚠️ **Esta resposta define QUEM escolhe o tier — não define COMO isso acontece
operacionalmente no MVP.** `vision-doc.md` descreve o self-service do MVP como restrito a
"pelo menos um cliente-piloto elegível" e reserva "onboarding próprio sem intervenção da EK"
para v1.1 (Should Have). Se "escolher o tier ao contratar" significar autoatendimento pleno
já na v1, isso amplia o escopo do MVP além do que `vision-doc.md` recorta hoje; se significar
que o cliente expressa a preferência dentro de uma contratação ainda mediada pela EK (que
registra essa escolha na assinatura), o recorte atual se mantém. Não decidido por inferência
aqui — sinalizado à fundadora em `handoff.yaml` e `PROJECT.md` como pendência residual.

**Esclarecimento (2026-09-14, Sid Hamada em conversa direta — não é resposta da fundadora
nem do formulário "9 Decisões da Lumea"):** os primeiros clientes a comprar serão pela rede
de relacionamento da fundadora, então a escolha do tier acontece dentro da negociação — ainda
mediada pela EK, não autoatendimento público sem intervenção dela. Isso confirma a segunda
leitura do parágrafo acima: o recorte atual do MVP em `vision-doc.md` (self-service restrito
a cliente-piloto elegível, com curadoria da EK) se mantém, e "onboarding próprio sem
intervenção da EK" continua reservado para v1.1. **Ressalva fechada — sem expansão de escopo
do MVP.**

---

## Categoria: sigilo profissional e retenção (LGPD)

### SQ-007 — Acesso a resultado de assessment individual dentro do papel RH

**Trava:** FR-022 (spec-detail de restrição adicional, ainda não escrito), NFR-LGPD

`risks-assumptions.md` registra sigilo profissional de psicóloga como risco de negócio/legal
associado aos dados de assessment. FR-022 hoje dá a todo usuário com papel RH visão completa
da estrutura — isso inclui ver o resultado individual e detalhado de um assessment de
qualquer colaborador, ou esse dado exige um sub-papel adicional (ex.: só quem está habilitado
a interpretar assessment, dentro do próprio RH) mesmo para quem já tem papel RH?

- **(A)** Todo usuário com papel RH vê o resultado completo de qualquer assessment — o RH já
  é o papel de maior confiança no cliente.
- **(B)** Resultado individual de assessment exige um sub-papel adicional dentro do RH (ex.:
  "RH com acesso a assessment"), distinto do RH genérico que só vê a recomendação de que
  assessment é necessário.
- **(C)** Não sei — registrar como `[INFERÊNCIA]`.

**Resposta:** **(B)** Resultado individual de assessment exige um sub-papel adicional
dentro do RH (ex.: "RH com acesso a assessment"), distinto do RH genérico que só vê a
recomendação de que assessment é necessário. Respondido via formulário "9 Decisões da
Lumea" (2026-09-14). Ver `requirements.md` FR-042, FR-043.

---

### SQ-008 — Prazo de retenção de dados de assessment e diagnóstico

**Trava:** NFR-LGPD (ainda sem prazo numérico definido)

Qual o prazo de retenção dos dados pessoais e de resultados de assessment após o
encerramento do contrato de um cliente, ou após a remoção de um colaborador da estrutura?
Este é valor de regra de negócio/legal — não é estrutural, não pode ser inferido pelo
product-owner.

- **(A)** Um prazo fixo definido pela fundadora, com base em orientação jurídica sobre LGPD
  e sigilo profissional de psicóloga.
- **(B)** Retenção indefinida até solicitação explícita de exclusão pelo cliente.
- **(C)** Não sei — registrar como `[INFERÊNCIA]` e tratar como bloqueador de lançamento até
  ter orientação jurídica, já que `vision-doc.md` marca LGPD como "bloqueador de lançamento,
  não feature opcional".

**Resposta:** **(A)** Prazo fixo de 5 anos, conforme o prazo dos demais registros legais de
RH. Respondido via formulário "9 Decisões da Lumea" (2026-09-14). Justificativa textual da
própria fundadora: **"acredito que 5 anos"**.

⚠️ **Isto é a crença da fundadora, não uma orientação jurídica formal confirmada.** A opção
(A) do enunciado pedia "com base em orientação jurídica sobre LGPD" — a resposta recebida não
cita essa orientação, cita uma crença pessoal sobre o prazo de outros registros de RH. Tratar
5 anos como valor de trabalho no schema e na política de retenção, mas **manter LGPD como
bloqueador de lançamento** (`vision-doc.md`) até que assessoria jurídica especializada em
LGPD e sigilo profissional de psicóloga confirme (ou corrija) esse número. Ver
`requirements.md` NFR-LGPD-RETENCAO, FR-044.

**Esclarecimento (2026-09-14, Sid Hamada em conversa direta — não é resposta da fundadora
nem do formulário "9 Decisões da Lumea", e ainda não é parecer jurídico formal por escrito):**
confirma o prazo fixo de 5 anos e esclarece que a base legal não é só LGPD — é também
legislação trabalhista (retenção de registros de RH). Isso reduz a incerteza da resposta
anterior, que era só uma crença pessoal sem base citada; a base agora é dupla (LGPD +
trabalhista). **A ressalva não fecha**: confirmação formal com assessoria jurídica
especializada (LGPD + trabalhista) antes do lançamento comercial continua recomendada, e LGPD
segue bloqueador de lançamento (`vision-doc.md`).

---

## Categoria: alcançabilidade / canal de aplicação

### SQ-009 — Onde o assessment é respondido pelo colaborador

**Trava:** FR-028 (spec-detail sobre canal de aplicação, ainda não escrito), US-1.8/AC4

`vision-doc.md` e `risks-assumptions.md` confirmam que o assessment entra no escopo técnico
como insumo do diagnóstico (resposta 6), mas não dizem se a Lumea **aplica** o assessment
(o colaborador responde um questionário dentro da própria ferramenta) ou se a Lumea **recebe**
resultado de assessment já aplicado por ferramenta externa (Sólides, Hogan, DISC — citadas em
`market-scan.md` como concorrentes de assessment isolado). As duas leituras são defensáveis e
têm esforço de construção muito diferente.

- **(A)** A Lumea aplica o assessment: o colaborador responde um questionário dentro da
  própria ferramenta, e o resultado já nasce lá.
- **(B)** A Lumea recebe resultado de assessment aplicado por ferramenta externa (upload
  manual ou integração), sem aplicar o questionário ela mesma.
- **(C)** As duas formas coexistem — importação de resultado externo no MVP, aplicação própria
  fica para depois.
- **(D)** Não sei — registrar como `[INFERÊNCIA]`.

**Resposta:** **(C)** As duas formas coexistem: no início a Lumea só recebe resultado de
assessment externo (upload/integração); aplicação própria dentro da Lumea fica para depois.
Respondido via formulário "9 Decisões da Lumea" (2026-09-14). Ver `requirements.md` FR-045.

**Detalhe da fundadora (direção de longo prazo, não spec fechada):** a intenção de longo
prazo é o cliente poder optar por assessment nativo da Lumea, solicitar inclusão depois, ou
trazer outro assessment externo — a fundadora foi explícita que isso "ainda não está
definido em detalhe, é direção, não spec fechada". Registrado como nota de direção futura em
`requirements.md` (sob FR-045), não como requisito do MVP nem do v1.1 confirmado.

---

## Como usar este documento

- Até 2026-09-14, nenhuma story do MVP em `user-stories.md` tinha critério de aceite que
  **assumisse** uma das respostas acima — onde a story dependia de uma SQ, o critério estava
  marcado `BLOQUEADO por SQ-NNN`. Com as 9 respostas da fundadora, todos os marcadores
  `BLOQUEADO` foram resolvidos e os critérios reescritos para refletir a decisão real.
- Ao responder, edite a linha `**Resposta:**` da pergunta correspondente. Não renumere, não
  reaproveite letra de opção — se uma opção for descartada por medição ou decisão posterior,
  ela fica riscada com o motivo, nunca apagada.
- SQ-001, SQ-002, SQ-003, SQ-004, SQ-005, SQ-007 e SQ-009 eram detalhe estrutural: tinham
  impacto direto no modelo de dados e na arquitetura que o `architect` desenha na Fase 03 —
  todas resolvidas sem ressalva. SQ-006 e SQ-008 são regra de negócio/legal: foram
  respondidas pela fundadora, e cada uma carregava uma ressalva que não virou decisão por
  inferência do `product-owner`. Em 2026-09-14, Sid Hamada esclareceu as duas em conversa
  direta com o main loop (não é resposta nova da fundadora nem do formulário): a ressalva de
  SQ-006 fechou — o mecanismo de contratação é uma negociação ainda mediada pela EK,
  confirmando que o recorte atual do MVP se mantém, sem expansão de escopo; a ressalva de
  SQ-008 reduziu, mas não fechou — a base legal do prazo de 5 anos agora é dupla (LGPD +
  legislação trabalhista), porém ainda não é confirmação jurídica formal por escrito. Ambas
  viajam para o `architect` via `handoff.yaml`, com o status atualizado.
