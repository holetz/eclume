# Sizing — Lumea

## Baseline (Discovery — product-owner)

Escala de esforço humano (canônica, usada também pelo `architect` na Fase 03):
XS < 2h · S 2-4h · M 4-8h (1 dia) · L 2-3 dias · XL 1 semana (deveria ser dividida).

Esta é uma estimativa **a partir das user stories**, antes de stack, schema, contrato de API
ou decisão de build-vs-buy — o `architect` refina este arquivo na Fase 03, anexando uma
seção de revisão ao lado desta, não substituindo.

| Story | Size | Esforço | Incógnitas / notas |
|-------|------|---------|---------------------|
| US-1.1 — Montar estrutura organizacional (manual) | M | 4-8h | SQ-002 resolvida (2026-09-14): duplicidade por nome+posição, sinalização sem bloqueio automático — não cresce para L, é comparação de string, não verificação de CPF/e-mail. SQ-001 resolvida: posição vaga é entidade própria (FR-034), sem custo adicional relevante sobre o cadastro já previsto |
| US-1.2 — Importar estrutura via planilha | L | 2-3d | SQ-004 resolvida (2026-09-14): reimportação substitui a estrutura inteira (FR-038) + exige confirmação explícita com contagem de remoções (FR-039) — mantém L, a confirmação é UI simples sobre o parsing já estimado |
| US-1.3 — Rodar diagnóstico de risco de liderança e dimensionamento | L | 2-3d | **Maior incógnita do backlog.** Esta estimativa cobre a orquestração (execução, estados, histórico) — não cobre formalizar a metodologia proprietária da EK em regras implementáveis, que é trabalho separado e ainda não dimensionado (nem pelo Strategist, nem aqui). Sem essa formalização, a estimativa é da "casca", não do "motor" |
| US-1.4 — Recomendação dentre as quatro categorias | L | 2-3d | Mesma dependência de US-1.3: a lógica de discriminação entre as quatro categorias é parte da metodologia proprietária, não codificada ainda em regra explícita em nenhum artefato de discovery |
| US-1.5 — Revisão humana no fluxo assistido (fila) | L | 2-3d | Fila + estados + trilha de auditoria (FR-019) — funcionalidade nova, sem equivalente reaproveitável |
| US-1.6 — Liberação direta no tier Self-Service | M | 4-8h | SQ-006 resolvida (2026-09-14): tier é atributo da assinatura, escolhido pelo cliente na contratação (FR-041) — mecanismo de registro é simples (M mantido). **Ressalva de mecanismo fechada (2026-09-14, esclarecida por Sid Hamada em conversa direta, não é resposta nova da fundadora):** a contratação acontece via rede de relacionamento da fundadora, mediada pela EK — não exige fluxo de autoatendimento (self-serve signup) no MVP. M confirmado, sem risco de crescer para L por este motivo (ver `spec-questions.md` SQ-006, `handoff.yaml`) |
| US-1.7 — Visão do líder de área com permissionamento por hierarquia | L | 2-3d | Modelo de permissão por posição hierárquica, não só por papel fixo — é modelo de dados novo, cruza toda a estrutura |
| US-1.8 — Assessment como insumo do diagnóstico | M-L | 4h-3d | SQ-009 resolvida (2026-09-14): MVP só recebe resultado de assessment externo (upload/integração, FR-045) — a opção que exigiria motor de aplicação próprio (XL) foi descartada para o MVP. A variação M-L remanescente depende de quantas ferramentas externas (Sólides, Hogan, DISC) o upload/integração precisa suportar de saída |
| US-1.9 — Controle de acesso e conformidade LGPD | L | 2-3d | SQ-007 e SQ-008 resolvidas (2026-09-14): sub-papel de acesso a assessment (FR-042/FR-043) e retenção de 5 anos com exclusão automática (FR-044) — ambas cabem no L já estimado. Autenticação por perfil, base legal, criptografia e mecanismo de exclusão seguem bloqueador de lançamento, não pode ser cortado por prazo |

**Total baseline:** ~19-20 dias de esforço humano equivalente, **sem contar a variação
larga de US-1.3/US-1.4 (formalização da metodologia, ainda não fechada)**. A variação de
US-1.8 (antes M a XL) foi resolvida para M-L por SQ-009 — reduz a leitura conservadora
anterior. A ressalva de US-1.6 (mecanismo de contratação) fechou em 2026-09-14 sem exigir
autoatendimento pleno no MVP, então não soma mais aos 1-2 dias condicionais que constavam
aqui antes. Com a metodologia de US-1.3/US-1.4 ainda não formalizada, o total pode passar de
23-25 dias na leitura mais conservadora dessa única incógnita remanescente.

_Refinado pelo `architect` na Fase 03._

## O que este sizing não resolve

1. **A metodologia de diagnóstico em si não está formalizada em regras.** Toda estimativa de
   US-1.3 e US-1.4 assume que alguém (a fundadora, ou um data scientist/consultor trabalhando
   com ela) já produziu a lógica de classificação de risco e de discriminação entre as quatro
   categorias antes do dev começar a codar. Se essa formalização ainda não existe, ela é
   trabalho de descoberta adicional, não de desenvolvimento — e não está neste sizing.
2. **Nenhum corte de escopo foi feito aqui por causa do total ser alto.** Se o total
   estourar prazo ou orçamento, a decisão de cortar profundidade (não meio job) volta para a
   fundadora e o `product-strategist` — não é resolvida silenciosamente neste documento
   (`vision-doc.md`, "Critério de corte do MVP").
