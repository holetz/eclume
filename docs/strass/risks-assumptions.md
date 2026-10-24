# Riscos e Hipóteses — Lumea

**Input:** `jtbd.md`, `market-scan.md`, `vpc.md`, `bmc.md`, `personas.md`.

---

## Hipóteses

| # | Hipótese | Risco | Se for falsa | Evidência hoje | Como testar | Custo do teste |
|---|----------|-------|--------------|-----------------|--------------|----------------|
| H1 | RH interno/HRBP e consultorias de RH trocam organograma estático + diagnóstico avulso pela leitura viva da Lumea, a ponto de pagar por isso | Valor + Negócio | Produto inteiro morre — sem troca de comportamento nem disposição de pagar, não há SaaS | `[DITO]` experiência de 10+ anos da fundadora + demanda recorrente por diagnóstico e por acompanhamento contínuo (resposta 9, 19). **Fonte única** — nenhuma entrevista de terceiros feita ainda dentro deste discovery. **Confirmado como RAT pela fundadora (2026-09-13, resposta 1):** o maior medo dela é ninguém querer pagar pela Lumea, não alguém copiar a metodologia — H1 segue como hipótese mais arriscada por decisão explícita da dona do produto, não só por dedução do Strategist | 5 entrevistas com RH/HRBP e 2 com consultorias de RH da rede da EK (acesso já confirmado, resposta 11) + protótipo clicável do fluxo estrutura→diagnóstico→ação | Baixo — a fundadora já tem a ponte de contato pronta |
| H2 | Líder/gestor de área usa o produto com autonomia e volta sozinho, sem depender de RH/consultoria empurrar o uso | Valor + Usabilidade | O segmento "líder final" não sustenta uso recorrente — a Lumea vira ferramenta só de RH/consultoria, reduzindo o alcance da visão de longo prazo da fundadora (resposta 24) | `[DITO]` visão declarada da fundadora; familiaridade digital deste segmento é a mais baixa e variável dos quatro (jtbd.md, resposta 12). **Frequência de retorno confirmada (2026-09-13, resposta 5):** "sob demanda do acompanhamento do time" — deixa de ser `não medido`. **Mudança de sequência (resposta 3):** a fundadora decidiu incluir Carla no MVP desde a v1, com permissionamento por papel (RH vê a estrutura completa; líder vê só o que está abaixo dele na hierarquia) — H2 passa a ser testada dentro do próprio MVP, não mais como gate de protótipo isolado antes de comprometer escopo | Medir dentro do próprio MVP (não mais só protótipo prévio) se Carla completa uma ação sem ajuda e volta sozinha sob demanda do acompanhamento do time, com o escopo de dados limitado à sua hierarquia | Médio — permissionamento por papel é requisito novo de escopo, não só uma tela a mais (ver vision-doc.md) |
| H3 | Consultorias de RH pagam por um modelo multiempresa/white-label o suficiente para ser o canal de maior escala | Negócio | O canal apontado pela fundadora como "maior potencial de escala" (resposta 24) não se sustenta financeiramente — força a depender só de venda direta a RH interno, mais lenta | `[DITO]` intenção e hipótese de modelo da fundadora (resposta 18); nenhum preço testado, contribuição de receita `não medido` (bmc.md). **Frequência confirmada (2026-09-13, resposta 5):** "por cliente atendido, conforme demanda" | Conversa de preço (não só de produto) com 2-3 consultorias da rede da EK, testando disposição de pagar por assento/cliente atendido | Baixo |
| H4 | A diferenciação "estrutura + diagnóstico + ação num só motor" é percebida como superior a costurar ChartHop/Agentnoon + Sólides/Hogan + consultoria pontual — mesmo custando mais que os concorrentes de organograma puro | Valor | Cliente prefere continuar costurando ferramentas baratas (Agentnoon ~US$4/func./mês) em vez de pagar por integração — a Lumea perde em preço sem vencer em percepção de valor | `[PESQUISA]` nenhum concorrente pesquisado integra as três camadas (market-scan.md), mas isso é lacuna de mercado, não prova de que o cliente valoriza a integração o suficiente para pagar mais | Comparar disposição de pagar da Lumea integrada vs. preço somado das ferramentas soltas, nas mesmas 5-7 entrevistas de H1 | Baixo — mesma rodada de entrevistas de H1 |
| H5 | A EK — sozinha ou via consultores que ela recrutar/treinar — consegue entregar o tier "Lumea + EK" (service-as-software) em escala sem virar gargalo, e a camada de IA absorve trabalho humano de julgamento suficiente para o modelo ter margem | Técnica + Negócio | O tier managed vira uma consultoria disfarçada de SaaS, presa à agenda de uma única pessoa — reproduzindo dentro do próprio produto a dor P7 que a Lumea deveria resolver para a EK (`jtbd.md`). Sem escala, o modelo em tiers (`bmc.md`) não sustenta o "Estratégico as-a-Service" como negócio, só como serviço de consultoria com um app de apoio | `[DITO]` (2026-09-13, respostas 9 e 10) — deixa de ser `[INFERÊNCIA]` pura. A fundadora confirma que **hoje consegue acompanhar bem 4 clientes simultâneos sozinha** no modo managed; considera suficiente para a demanda inicial, mas sabe que crescer além disso exige contratar/treinar equipe — teto conhecido e baixo (4), não é gargalo agora mas é teto real. Sobre a divisão de trabalho: confirmado **meio a meio** — a IA responde bem parte do julgamento, mas uma pessoa (ela ou quem ela treinar) sempre revisa e decide antes de finalizar; não é "IA sozinha" nem "pessoa faz quase tudo" | Rodar clientes piloto no tier managed dentro do teto de 4 já confirmado pela EK, medindo se a divisão meio a meio IA/humano se sustenta e se o teto de 4 aparece antes do esperado, antes de contratar/treinar qualquer consultor adicional | Médio — exige piloto real com clientes atendidos de ponta a ponta, não só entrevista |

## Hipótese mais arriscada (RAT)

**H1 — RH interno/HRBP e consultorias de RH trocam a alternativa atual pela Lumea, a ponto
de pagar por isso.**

Critério de seleção: maior dano se falsa × menor evidência hoje. H1 é pré-requisito de
H2, H3 e H4 — se ninguém troca a alternativa atual nem paga, não importa se o líder final
usa com autonomia (H2) ou se o canal multiempresa escala (H3). A evidência atual vem de
uma única fonte (a fundadora, sem entrevista de terceiros) e o sinal de disposição de pagar
é indireto (resposta 19: clientes recontratam diagnóstico, não confirmaram pagar por SaaS).

**O MVP existe para testar H1.** Todo item que não contribui diretamente para provar ou
refutar H1 é candidato a v1.1 ou backlog.

**Revisão do recorte (2026-09-13, `[DITO]` feedback do dono do produto):** o corte inicial
do MVP (`vision-doc.md` v1.0) limitava a biblioteca de ações a 1 tipo em vez de 4, decisão
influenciada por esforço de código. Isso foi corrigido porque enfraquecia o próprio teste
de H1: com só uma ação disponível, uma rejeição do cliente na entrevista não permite
distinguir "H1 é falsa" de "a única ação oferecida não cabia no caso dele". Testar H1 com a
biblioteca completa (`vision-doc.md`, seção "Critério de corte do MVP") isola a variável
corretamente — custa mais para construir, não menos, e é aceito porque não há prazo rígido
que force o corte por esforço (ver linha "Ausência de prazo/orçamento definidos" abaixo).

**Revisão do modelo de negócio (2026-09-13, `[DITO]` dono do produto — modelo em tiers,
`bmc.md`):** H1 continua sendo a RAT. O modo "operação assistida pela EK" que o MVP já usa
para testar H1 corresponde, na prática, ao tier "Lumea + EK" recém-formalizado — ou seja,
testar H1 hoje já testa, de forma implícita, se o tier managed gera valor percebido. Isso não
substitui H5 (capacidade de entrega do tier managed em escala): H1 mede se o cliente quer
continuar usando o que a EK entrega manualmente para um caso; H5 mede se esse "manual" ainda
funciona quando não é mais só a fundadora, sozinha, atendendo um punhado de clientes-piloto.
H5 só passa a importar depois que H1 for validada — por isso continua como hipótese
secundária, não substitui a RAT.

**Confirmação explícita da fundadora (2026-09-13, resposta 1):** H1 é, de fato, a aposta mais
arriscada — "o medo maior é ninguém querer pagar pela Lumea, não é alguém copiar a
metodologia". A pergunta 2 da seção "Perguntas em aberto" (abaixo) está respondida: a
fundadora não prioriza validar primeiro o risco de exposição da metodologia antes de testar
disposição de pagar.

**Revisão de escopo do MVP (2026-09-13, respostas 2, 3, 4, 5, 6 e 8 — ver seção "Perguntas
respondidas" abaixo):** seis das perguntas em aberto originais foram respondidas pela
fundadora e alteram o recorte do MVP diretamente:
- A profundidade das quatro ações fica em "recomendação + orientação de próximo passo"
  (resposta 2) — não precisa de fluxo de execução completo no MVP. Confirma a inferência que
  já estava assumida em `vision-doc.md`.
- O líder/gestor de área (Carla) entra no MVP desde a v1, não em v1.1 (resposta 3) — mas com
  permissionamento por papel (RH vê a estrutura completa; líder só vê a hierarquia abaixo
  dele). Isso é uma segunda experiência de uso com escopo de dados diferente, não apenas mais
  uma tela — tratado como requisito novo, não como confirmação de escopo já previsto.
- O ponto de entrada é cliente atual da EK, não consultoria parceira (resposta 4) — confirma
  o que `vision-doc.md` já assumia.
- A plataforma de assessment entra no escopo técnico deste projeto agora, não como
  integração futura separada (resposta 6) — porque alimenta o diagnóstico com informações que
  o compõem. Isso é mudança de escopo, não confirmação: `vision-doc.md`/`vpc.md` tratavam o
  assessment como algo que *nasce do* diagnóstico (uma das quatro ações recomendadas), não
  como *insumo para* o diagnóstico. As duas direções podem coexistir, mas a arquitetura
  precisa tratar explicitamente do fluxo de dados nos dois sentidos — ver `vision-doc.md`.
- Os dois formatos (self-service e "Lumea + EK") serão testados **ao mesmo tempo**, não em
  sequência (resposta 8) — reverte a suposição anterior deste discovery de que "Lumea + EK"
  seria testado primeiro e o self-service ficaria para v1.1. A fundadora já tem clientes hoje
  em que consegue aplicar os dois formatos. Isso amplia a superfície do MVP: a ferramenta
  precisa suportar operação sem revisão humana da EK para pelo menos um cliente-piloto
  elegível ao tier Self-Service, não só o modo assistido — ver `vision-doc.md`, "Conexão com
  o modelo de tiers". A profundidade exata do self-service necessária para esse teste não foi
  detalhada pela fundadora e permanece como inferência aberta.

## Riscos não cobertos pelas hipóteses acima (registro complementar)

| Risco | Categoria | Detalhe | Origem |
|-------|-----------|---------|--------|
| Exposição da metodologia proprietária | Negócio | O maior ativo da EK é a lógica de recomendação — se o produto expõe essa lógica de forma replicável (ex. regras visíveis, exportáveis), o diferencial esvai. `[DITO]` resposta 24 | `[DITO]` |
| LGPD e sigilo profissional | Negócio/Legal | Produto trata dados pessoais de terceiros (colaboradores dos clientes dos clientes) e dados de assessment sensíveis; exige base legal, controle de acesso por perfil, retenção e sigilo profissional de psicóloga. Não é feature opcional — é bloqueador de lançamento comercial. `[DITO]` resposta 21 | `[DITO]` |
| Viabilidade técnica da "biblioteca de ações" como motor extensível | Técnica | A fundadora quer que a biblioteca "cresça com o tempo" (resposta 24) — arquitetura precisa suportar novas ações sem reescrever o motor a cada uma. Com a revisão de 2026-09-13, o MVP já entra com 4 categorias (não 1), então a extensibilidade deixa de ser preocupação só de v1.1 e precisa ser avaliada pelo `architect` desde o desenho inicial. Ainda não avaliado | `[INFERÊNCIA]` |
| Ausência de prazo/orçamento definidos | Negócio | Meta de "no ar até 2027" sem evento externo rígido, orçamento a definir a partir do escopo do MVP (respostas 3 e 4) — risco de escopo inflar sem teto orçamentário claro | `[DITO]` |
| Canibalização entre tiers (novo, 2026-09-13; reformulado 2026-09-13 pós-resposta 11) | Negócio | Com o modelo de precificação confirmado (resposta 11: uma assinatura única, acompanhamento da EK como serviço extra por cima — não são planos separados), o risco muda de forma: não é mais "cliente escolhe o tier mais barato", é "cliente não contrata o serviço extra de acompanhamento, tenta agir sozinho sem ter capacidade para isso, e falha" — gerando a mesma narrativa de churn ("a ferramenta sozinha não resolve"). Critério de elegibilidade/recomendação de quando oferecer o serviço extra ainda não desenhado | `[INFERÊNCIA]` |
| Capacidade de entrega do tier managed (H5) | Técnica + Negócio | Ver H5 acima — registrado aqui como referência cruzada porque também é insumo direto para o `architect` (fila de revisão humana, trilha de auditoria do julgamento aplicado). **Atualizado 2026-09-13:** teto confirmado de 4 clientes simultâneos atendidos bem pela EK sozinha (resposta 9) | `[DITO]` (teto) + `[INFERÊNCIA]` (o que acontece além do teto) |
| Teto de capacidade do tier managed em 4 clientes simultâneos (novo, 2026-09-13) | Técnica + Negócio | A fundadora confirma que hoje atende bem 4 clientes simultâneos sozinha no modo managed (resposta 9). Não é gargalo para o piloto do MVP, mas é um teto baixo e conhecido: qualquer crescimento do tier "Lumea + EK" além disso depende de contratar/treinar consultores — decisão ainda não tomada, nem o arranjo (contratação, franquia de metodologia, etc.) definido (`bmc.md`) | `[DITO]` |
| Testar dois formatos (self-service e "Lumea + EK") simultaneamente pode dobrar o escopo do MVP (novo, 2026-09-13) | Negócio + Produto | A fundadora decidiu validar os dois formatos ao mesmo tempo com clientes reais que já tem (resposta 8), revertendo a sequência antes assumida neste discovery (Lumea+EK primeiro, self-service em v1.1). A ferramenta precisa suportar operação sem revisão humana da EK para pelo menos um cliente-piloto do tier Self-Service, além do modo assistido — profundidade exata do self-service necessária para o teste não foi detalhada. Risco de o MVP crescer em duas frentes de UX/permissão ao mesmo tempo em vez de uma | `[DITO]` (decisão de testar os dois) + `[INFERÊNCIA]` (profundidade do self-service) |
| Permissionamento por papel (RH vs. líder de área) é requisito novo, não confirmação de escopo (novo, 2026-09-13) | Técnica | A fundadora confirmou que Carla (líder de área) entra no MVP desde a v1 (resposta 3), mas com escopo de dados diferente do RH: RH vê a estrutura organizacional completa, líder só vê o que está abaixo dele na hierarquia. Isso exige modelo de permissão por papel e por posição na hierarquia desde o desenho inicial do MVP, não como camada adicionada depois — insumo direto para o `architect` | `[DITO]` |
| Fluxo de dados do assessment: insumo do diagnóstico vs. ação recomendada pelo diagnóstico (novo, 2026-09-13) | Técnica + Produto | `vpc.md`/`jtbd.md` descreviam o assessment como uma das quatro ações que o diagnóstico recomenda (nasce do diagnóstico). A resposta 6 da fundadora descreve o inverso: o assessment alimenta a ferramenta com informações que compõem o diagnóstico (é insumo, não só saída). As duas direções podem coexistir (assessment como insumo em um momento e como ação recomendada em outro), mas isso não foi desenhado — precisa de decisão explícita do `architect` sobre a arquitetura de dados | `[DITO]` (fato) + `[INFERÊNCIA]` (como reconciliar as duas direções) |

---

## Perguntas respondidas pela fundadora (2026-09-13)

Todas as perguntas abaixo, antes em aberto, foram respondidas por Jane Doe (EK) num
questionário de acompanhamento. Todas as respostas são `[DITO]` — nenhuma vira requisito de
`requirements.md`/`user-stories.md` sem passar pelo recorte do `product-owner`, mas deixam de
ser inferência do Strategist.

1. **Frequência de uso esperada por persona** (Marina, Rafael, Carla, e Persona 5) — RH
   interno de empresa cliente: **semanalmente**, para acompanhamento. Consultoria de RH
   parceira: **por cliente atendido, conforme demanda**. Líder/gestor de área: **sob demanda
   do acompanhamento do time**. Empresa sem RH estruturado (Persona 5): **diariamente**, pelo
   responsável/líder da área. Resolve a maior lacuna do corte de MVP — o gatilho de retorno
   agora tem cadência declarada para todas as personas.
2. **H1 é a aposta mais arriscada** — confirmado. O medo maior da fundadora é ninguém querer
   pagar pela Lumea, não alguém copiar a metodologia. Ela não prioriza validar primeiro o
   risco de exposição da metodologia.
3. **Líder de área (Carla) entra no MVP desde a v1** — confirmado, com uma condição nova:
   permissionamento por papel. RH vê a estrutura organizacional completa; o líder só vê o que
   está abaixo dele na hierarquia. É uma segunda experiência de uso com escopo de dados
   diferente, não apenas mais uma tela — tratado como requisito novo de escopo em
   `vision-doc.md`, não como confirmação do que já estava desenhado.
4. **Plataforma de assessment entra no escopo técnico deste projeto agora** — confirmado, não
   fica como integração futura separada. Motivo da fundadora: o assessment alimenta a
   ferramenta com as informações que compõem o diagnóstico — ou seja, é também insumo do
   diagnóstico, não só uma das quatro ações recomendadas por ele (inverte parcialmente a
   leitura anterior de `vpc.md`/`jtbd.md`). Ver `vision-doc.md` e o risco de fluxo de dados
   registrado acima.
5. **Profundidade das quatro categorias da biblioteca de ações** — recomendação + orientação
   do próximo passo é suficiente para o MVP; a ferramenta **não** precisa acompanhar a
   execução completa de cada ação. Confirma o que `vision-doc.md` já assumia como inferência.
6. **Qual tier lançar/validar primeiro** — os **dois ao mesmo tempo** (Self-Service e "Lumea
   + EK"), não em sequência. A fundadora diz ter clientes hoje em que consegue aplicar os
   dois formatos. Isso reverte a suposição anterior deste discovery (Lumea+EK primeiro,
   self-service em v1.1) — ver revisão do escopo do MVP acima e `vision-doc.md`.
7. **Capacidade de entrega do tier managed (H5)** — a EK consegue acompanhar bem **4 clientes
   simultâneos** sozinha hoje; considera suficiente para a demanda inicial, mas sabe que
   crescer além disso vai exigir constituir equipe (contratar/treinar). Não é gargalo agora,
   é um teto conhecido e baixo.
8. **Quanto a IA absorve do julgamento especialista** — meio a meio. A IA ajuda bastante
   (a fundadora acredita que vai responder muita coisa bem treinada), mas uma pessoa (ela ou
   quem ela treinar) sempre revisa e decide antes de finalizar. Não é "IA sozinha" nem
   "pessoa faz quase tudo" — insumo direto para o `architect` desenhar a fila de revisão
   humana e a trilha de auditoria.
9. **Precificação entre tiers** — uma assinatura só, com o acompanhamento da equipe da EK
   entrando como serviço extra por cima, não planos/preços completamente separados por tier.
   A fundadora vê a plataforma como um valor e o "RH as a service" como valor adicional.

**Duas perguntas adicionais, feitas fora desta lista original mas resolvidas pela mesma
rodada de respostas** (registradas em `handoff-strategy.yaml`):
- O modelo em tiers do `bmc.md` é confirmado como a estratégia da fundadora (não precisa de
  validação adicional antes de seguir).
- O perfil da Persona 5 varia com a estrutura da empresa-cliente (RH generalista, ADM ou
  sócio) — não é um cargo único fixo; as ações recomendadas ficam a cargo dessa pessoa.
