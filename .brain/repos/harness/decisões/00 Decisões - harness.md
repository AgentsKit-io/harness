---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; os 43 ADRs de harness/docs foram lidos e conferidos contra o código; nada foi executado"
fontes:
  - harness/docs/ADR-0001-extensible-kernel.md
  - harness/docs/ADR-0026-kernel-adapters-boundary.md
  - harness/docs/ADR-0027-keep-pushing-loop.md
  - harness/docs/ADR-0043-delivery-state-module-boundary.md
  - harness/docs/MODULE-BOUNDARIES.md
tags: [guia, repo/harness, camada/ferramenta]
---

# 00 Decisões - harness

> [!tldr] Em linguagem comum
> Índice dos 43 registros de decisão do Harness, agrupados por assunto: o que cada um decidiu, em que estado está e qual pacote afeta.

← [[00 Hub - harness]]

Os ADRs ficam em `harness/docs/ADR-NNNN-*.md`; só os de 0001 a 0003 e 0027 a 0030 trazem data no próprio texto, o ADR-0026 traz a data de aprovação e o ADR-0019 a data de uma emenda (2026-09-19). Os demais não têm data no documento; a coluna de datas do histórico git está em cada nota. Todos estão **aceitos**; o ADR-0038 é aceito de forma parcial (`codex` não coberto). Nenhum foi formalmente substituído, mas alguns trechos ficaram desatualizados pelo código: veja [[Auditoria - harness]].

## Núcleo, evidência e atestação

| ADR | Decisão em uma linha | Pacote |
|---|---|---|
| [[harness ADR-0001 - Núcleo extensível com eventos append-only]] | Garantias no núcleo, extras por plugin, diário append-only | [[harness-kernel]] |
| [[harness ADR-0002 - Perfis e provedores de contexto opcionais]] | Perfis herdáveis e contexto como slot de plugin | [[harness-kernel]] |
| [[harness ADR-0003 - Contexto do Doc Bridge ligado à execução]] | Contexto do Doc Bridge congelado com hash | [[harness-adapters]] |
| [[harness ADR-0017 - Log de eventos encadeado por hash]] | Cada evento carrega o hash do anterior | [[harness-kernel]] |
| [[harness ADR-0018 - Atestação da projeção de verificação]] | Digest da verificação no `run.json` e no log | [[harness-kernel]] |
| [[harness ADR-0019 - Decisão humana atestada]] | Aprovação humana vira evento; emenda do `loop-auto` | [[harness-kernel]] |
| [[harness ADR-0020 - Reconciliação terminal]] | Conferir tudo antes de dizer "completo" | [[harness-kernel]] |
| [[harness ADR-0021 - Recuperação explícita de lock do log]] | Só humano remove lock órfão | [[harness-kernel]] |
| [[harness ADR-0022 - Pacote de evidência assinado]] | Pacote Ed25519 portátil | [[harness-kernel]] |
| [[harness ADR-0042 - Hash canônico compartilhado]] | JSON canônico do `@agentskit/core` | [[harness-kernel]] |

## Sessão de agente, política e runtime

| ADR | Decisão em uma linha | Pacote |
|---|---|---|
| [[harness ADR-0006 - Protocolo de sessão de agente]] | Gravador de sessão só com hashes | [[harness-kernel]] |
| [[harness ADR-0007 - Política de ferramentas negar por padrão]] | Regras ordenadas, bloqueio por padrão | [[harness-kernel]] |
| [[harness ADR-0008 - Executor de ações em runtime limitado]] | Executor com timeout, resultado por hash | [[harness-kernel]] |
| [[harness ADR-0009 - Runtime de processo sem shell]] | Processo filho com argv fixo | [[harness-kernel]] |
| [[harness ADR-0010 - Runtime Docker opcional]] | Contêiner sem rede, só leitura | [[harness-kernel]] |
| [[harness ADR-0011 - Atestação de runtime na evidência]] | Evidência de imagem e limites | [[harness-kernel]] |
| [[harness ADR-0023 - Recuperação segura de ações ambíguas]] | Humano decide retentar ou abandonar | [[harness-kernel]] |

## Benchmarks e métricas

| ADR | Decisão em uma linha | Pacote |
|---|---|---|
| [[harness ADR-0004 - Métricas a partir de projeções imutáveis]] | Métricas lendo o histórico local | [[harness-kernel]] |
| [[harness ADR-0005 - Manifesto de benchmark e vínculo com a tarefa]] | Tarefas e baselines explícitos | [[harness-kernel]] |
| [[harness ADR-0012 - Baselines controlados pela interface pública]] | Único caminho de escrita de baseline | [[harness-kernel]] |
| [[harness ADR-0013 - Comparabilidade honesta de benchmark]] | Só compara com baseline e execução `COMPLETE` | [[harness-kernel]] |
| [[harness ADR-0014 - Evidência de benchmark por critério]] | Evidência por critério de aceite | [[harness-kernel]] |
| [[harness ADR-0015 - Resultados direcionais de benchmark]] | Melhorou/piorou/igual por recurso | [[harness-kernel]] |
| [[harness ADR-0016 - Digests de evidência de baseline]] | SHA-256 do arquivo de evidência | [[harness-kernel]] |
| [[harness ADR-0024 - Entrega incompleta escapada como métrica]] | `escapedIncomplete` | [[harness-kernel]] |

## Fronteiras e portabilidade

| ADR | Decisão em uma linha | Pacote |
|---|---|---|
| [[harness ADR-0025 - Controles portáteis de orquestração]] | Só mecanismos determinísticos entram no núcleo | [[harness-kernel]] |
| [[harness ADR-0026 - Fronteira entre kernel e adapters]] | Quatro classes de módulo e script de fronteira | [[harness-kernel]] |
| [[harness ADR-0028 - MCP só como adapter]] | Ponte MCP negar por padrão | [[harness-adapters]] |
| [[harness ADR-0034 - Conectores de tracker SCM e runner]] | Três costuras do loop | [[harness-loop]] |
| [[harness ADR-0043 - Fronteira do módulo de estado de entrega]] | `deliver-state.ts` separado | [[harness-loop]] |

## O loop em operação

| ADR | Decisão em uma linha | Pacote |
|---|---|---|
| [[harness ADR-0027 - Loop keep-pushing sobre o Orca]] | Composição sobre o Orca | [[harness-loop]] |
| [[harness ADR-0029 - Resiliência, pinagem de brief e intake do GitHub]] | Auto-pausa, skills pinadas, intake por label | [[harness-loop]] |
| [[harness ADR-0030 - Barramento de eventos e hooks de orquestração]] | Hooks de orquestração, não do worker | [[harness-loop]] |
| [[harness ADR-0031 - Observabilidade somente leitura do loop]] | `loop observe` | [[harness-loop]] |
| [[harness ADR-0032 - Estágios como máquinas de estado]] | A máquina decide a transição | [[harness-loop]] |
| [[harness ADR-0033 - Quatro camadas de configuração e presets]] | Global, projeto, time, máquina | [[harness-loop]] |
| [[harness ADR-0035 - Definição de pronto em duas listas]] | Projeto + issue, sem item manual | [[harness-loop]] |
| [[harness ADR-0036 - Automodificação limitada]] | Três mudanças autônomas, medidas e reversíveis | [[harness-loop]] |
| [[harness ADR-0037 - Custo política tetos e alavancas]] | Política, tetos e alavancas reais | [[harness-loop]] |
| [[harness ADR-0038 - Worker guard em tempo real]] | Hook de edição no worktree | [[harness-loop]] |
| [[harness ADR-0039 - Piso de auto-merge e runner local não ligado]] | Piso de auto-merge, `local` recusado | [[harness-loop]] |
| [[harness ADR-0041 - Runs de agente e specs renderizadas]] | Diretório de run e specs | [[harness-loop]] |

## Painel local

| ADR | Decisão em uma linha | Pacote |
|---|---|---|
| [[harness ADR-0040 - Plano de controle v2]] | Fila de atenção, conciliação, ações do kernel | [[harness-ui]] |

> [!info]- Detalhe técnico
> - `harness/docs/ADR-0001-extensible-kernel.md:1` até `harness/docs/ADR-0043-delivery-state-module-boundary.md:1`: lista completa verificada com `git ls-files docs`.
> - `harness/README.md:213-216` destaca ADR-0027, 0032, 0035 e 0037 como as decisões centrais do loop.
> - Datas de entrada no git: ADRs 0001–0024 em 2026-09-09; 0025 e 0026 em 2026-09-10; 0027 e 0028 em 2026-09-11; 0029 e 0030 em 2026-09-12; 0031 em 2026-09-13; 0032–0037 em 2026-09-21; 0038 e 0039 em 2026-09-22; 0040 em 2026-09-25; 0041 em 2026-09-26; 0042 em 2026-09-29; 0043 em 2026-10-03.
