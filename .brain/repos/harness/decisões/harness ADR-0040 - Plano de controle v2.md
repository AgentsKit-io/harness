---
tipo: adr
repo: harness
camada: ferramenta
visibilidade: publico
status: aceito
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; ADR lido e conferido contra o código citado; nada foi executado"
fontes:
  - harness/docs/ADR-0040-control-plane-v2.md
  - harness/src/ui/api/attention.ts
  - harness/src/ui/api/reconcile.ts
  - harness/src/ui/api/server.ts
  - harness/src/ui/api/routes-actions.ts
  - harness/src/ui/api/actions.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0040 - Plano de controle v2

> [!tldr] Em linguagem comum
> A tela inicial vira uma fila de atenção, o painel concilia com o tracker e o Orca antes de agir, e toda ação chama a mesma função do CLI; ainda é só uma projeção, não uma fonte de verdade.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-25).

## A decisão em linguagem comum

1. **Home = fila de atenção**, ordenada: decisões humanas → travado/falho → fora de sincronia → sistema, depois o mais antigo; função pura (`attention.ts`).
2. **Conciliar antes de agir:** cada snapshot compara projeção, tracker e Orca; estado desconhecido nunca vira "fechado"; destrutivos recusam com 409 enquanto a issue está travada.
3. **Toda ação é uma função do kernel** (`approveHeldDelivery`, `approvePlan`, `approveRelease`, promoção de aprendizados, `pauseStage`/`resumeStage`, `runTick`/`runDeliver`/`runLoopDoctor` como jobs, `installLoopAutomations`); não existe endpoint de deploy; gates humanos registram a pessoa configurada como ator.
4. **A UI não instala automações ao iniciar**; reporta ausentes ou à deriva e reinstala sob pedido, fixando o binário em execução.
5. **Configuração com procedência**, escrita só na camada pessoal; valores de time voltam como diff para commitar; afrouxar um gate só na camada pessoal com confirmação, e a run enfileirada registra `weakenedGates`.
6. **Insights são modelos de leitura com janela:** no máximo 30 dias de eventos, cache por tamanho e mtime.
7. **Sem dependências novas:** gráficos são SVG pequenos; busca é uma varredura limitada.

## Contexto

O painel anterior mostrava estado que já não era verdadeiro e oferecia ações destrutivas sobre ele (issue "rodando" depois de fechada, "5/4 workers"), e metade das ações do operador só existia no CLI.

## Consequências

- Atenção: `harness/src/ui/api/attention.ts:127` (`buildAttention`); conciliação e travas em `harness/src/ui/api/reconcile.ts:76` e `:124`; travas aplicadas no servidor em `harness/src/ui/api/server.ts:324` e `:393-395`; ações em `harness/src/ui/api/routes-actions.ts` (ator em `:40`); `weakenedGates` em `harness/src/ui/api/actions.ts:176`.
- A página só pode estar errada enquanto suas fontes estiverem velhas, e diz isso: tracker velho trava destrutivos com trabalho em voo; loop velho não trava nada.
- Abrir a UI não mantém mais o agendamento instalado sozinho.

## Pacotes afetados

[[harness-ui]], [[harness-loop]]

## Substitui / substituído por

Nenhum formal; substitui o painel descrito por trás de #111.

## Fonte

`harness/docs/ADR-0040-control-plane-v2.md`.
