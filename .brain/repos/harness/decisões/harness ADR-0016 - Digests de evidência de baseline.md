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
  - harness/docs/ADR-0016-baseline-evidence-digests.md
  - harness/src/execution/metrics.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0016 - Digests de evidência de baseline

> [!tldr] Em linguagem comum
> O arquivo de evidência usado para registrar um baseline ganha um hash SHA-256, para que uma cópia alterada seja distinguível depois.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Quando `ak-harness benchmark baseline` lê `--evidence-file`, calcula e grava o SHA-256 minúsculo do conteúdo em `evidenceDigest`. A validação do manifesto só aceita 64 caracteres hexadecimais minúsculos. O digest cobre o arquivo de evidência, não o artefato externo que cada critério cita.

## Contexto

Cobertura por critério e métricas direcionais podiam ficar desligadas do JSON exato usado na coleta.

## Consequências

- Cálculo do digest em `harness/src/cli.ts:28` (`sha256(content)` dentro de `readBenchmarkEvidence`, `harness/src/cli.ts:23`); campo e validação em `harness/src/execution/metrics.ts:30` e `harness/src/execution/metrics.ts:289`.
- O registro de baseline fica à prova de adulteração em relação ao arquivo de entrada; sistemas externos continuam fora do que o harness local verifica.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0016-baseline-evidence-digests.md`.
