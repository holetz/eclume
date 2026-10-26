# Success Metrics — Lumea

**Baseline (Discovery — product-owner).** O `product-analyst` valida, instrumenta e refina
este documento na Fase 18. Métricas ligadas a H1 (`riskiest_assumption`) e H5 (hipótese
secundária), ambas de `risks-assumptions.md`.

---

## North Star Metric (candidato)

**Métrica:** Taxa de continuidade pós-ciclo — clientes que seguem usando a Lumea depois que o
contrato de consultoria ativo termina, sem a EK precisar empurrar o uso.

**Fórmula:** clientes que continuam usando a Lumea N semanas após o fim do ciclo de
consultoria ativo / total de clientes que completaram pelo menos um ciclo (estrutura →
diagnóstico → recomendação liberada)

**Baseline:** não medido — produto ainda não lançado.

**Alvo:** não medido — a fundadora não declarou um percentual-alvo; só o comportamento
observável ("pede para continuar usando depois do ciclo de consultoria", `vision-doc.md`,
Hipótese de valor). Alvo numérico é decisão pendente, não fabricada aqui.

**Por que captura valor:** é a tradução direta em métrica de H1 — a hipótese mais arriscada
confirmada pela fundadora (resposta 1, `risks-assumptions.md`) é que RH/HRBP e consultorias
trocam a alternativa atual pela Lumea a ponto de pagar por isso. "Continuar usando sem
contrato ativo" é o proxy comportamental mais próximo de disposição de pagar que o MVP
consegue observar sem depender de uma cobrança já configurada.

**Gap de instrumentação conhecido:** esta métrica depende de saber quando um "ciclo de
consultoria ativo" termina — esse é um dado comercial/CRM da EK, não um evento que nenhuma
story do MVP produz hoje. Ver "Contrato de medição" abaixo.

---

## Métricas de entrada (leading — mexem primeiro)

| Métrica | Fórmula | Alvo | Baseline | Liga a qual regra do MVP |
|---------|---------|------|----------|---------------------------|
| Time-to-first-value | tempo entre início da sessão e recomendação liberada | ≤ 1h por sessão (`[DITO]`, meta declarada pela fundadora) | não medido — só se sabe que o processo manual hoje leva "várias horas" | Regra 2 do MVP Test — ganho percebido na primeira sessão |
| Job concluído / job iniciado | estruturas que chegam a uma recomendação liberada / estruturas cadastradas | não medido | não medido | Regra 1 do MVP Test — job completo, sem sair da ferramenta |
| Cadência de retorno por persona | sessões por período, segmentado por papel | RH interno: ≥ 1×/semana · Persona 5: ≥ 1×/dia · Líder de área: sob demanda (sem cadência fixa) · Consultoria: por cliente atendido | não medido | Regra 3 do MVP Test — frequência de retorno confirmada por persona (resposta 5) |

> **Nota sobre o alvo de cadência do líder de área:** "sob demanda" não é uma frequência
> mensurável por contagem de sessões/semana — é um padrão de uso acionado por evento (quando
> o líder precisa acompanhar o time), não por calendário. O `product-analyst` deve tratar esse
> caso como métrica de **recorrência sem cadência fixa** (ex.: % de líderes que retornam pelo
> menos uma vez após a primeira sessão), não forçar um número semanal que a fundadora não
> declarou.

---

## Métricas de resultado (lagging)

| Métrica | Fórmula | Alvo | Baseline |
|---------|---------|------|----------|
| Taxa de continuidade pós-ciclo (NSM) | ver acima | não medido | não medido |
| % de clientes que aceitam a ação recomendada (qualquer categoria) | ações aceitas / recomendações liberadas | não medido | não medido |

---

## Guardrails (o que não pode piorar) — ligados a H5

| Guardrail | Por quê | Limite conhecido |
|-----------|---------|-------------------|
| Clientes simultâneos atendidos no tier "Lumea + EK" | H5 confirma teto de capacidade humana da fundadora hoje | ≤ 4 clientes simultâneos sem degradar tempo de revisão (`[DITO]`, resposta 9, 2026-09-13) — teto de negócio, não teto técnico aceitável (ver `NFR-CAPACIDADE`, `requirements.md`) |
| Divisão de julgamento IA/humano no fluxo assistido | H5 confirma expectativa de divisão "meio a meio" entre IA e revisão humana | Referência qualitativa da fundadora (resposta 10), não um alvo numérico formal — o `product-analyst` deve medir % de recomendações aprovadas sem edição como proxy, mas não tratar 50% como meta rígida sem nova confirmação |
| Tempo de revisão humana por recomendação na fila | Se crescer sem controle conforme mais clientes entram, o teto de 4 aparece antes do esperado (`risks-assumptions.md`, H5) | não medido — sem baseline ainda, primeira medição vem do piloto |

---

## Contrato de medição → product-analyst (Fase 18)

| Métrica | Evento/fonte necessária | Story que produz o dado |
|---------|--------------------------|--------------------------|
| Time-to-first-value | `estrutura_criada` + `recomendacao_liberada`, com timestamp e `user_id` | US-1.1/US-1.2, US-1.4 |
| Job concluído / job iniciado | `estrutura_criada`, `diagnostico_concluido`, `recomendacao_liberada` | US-1.1, US-1.3, US-1.4 |
| Cadência de retorno por persona | `session_started` com `user_id` e `role` (RH ou líder de área) | US-1.9 (autenticação por perfil) |
| % recomendações aprovadas sem edição | `recomendacao_revisada` com campo de decisão (aprovada / editada / substituída) | US-1.5 (FR-019, registro de auditoria) |
| % de clientes que aceitam a ação recomendada | evento de aceite/rejeição da recomendação pelo cliente — **não existe ainda nenhuma story do MVP que capture isso explicitamente** | gap — avaliar se entra como AC adicional de US-1.4/US-1.6 antes da Fase 18 |
| Taxa de continuidade pós-ciclo (NSM) | evento de fim de contrato de consultoria (CRM/comercial da EK) cruzado com `session_started` subsequente | gap — dado comercial, não evento de produto; instrumentação a desenhar junto com o funil comercial da EK |

**Duas lacunas explícitas de instrumentação** ficam registradas aqui em vez de fabricadas: a
NSM depende de um dado que hoje vive no processo comercial da EK, não em nenhum evento do
produto; e a taxa de aceite da recomendação não tem evento dedicado em nenhuma story do MVP.
Ambas precisam de decisão antes da Fase 18, não de suposição agora.
