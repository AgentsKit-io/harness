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
  - harness/docs/ADR-0018-verification-projection-attestation.md
  - harness/src/execution/verification.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0018 - Atestação da projeção de verificação

> [!tldr] Em linguagem comum
> Depois de verificar, o harness sela o resultado com um hash e grava o mesmo hash no log; aprovar exige que os dois ainda batam.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

A cada passagem de verificação, o harness calcula o hash de checagens, resultados e métricas, grava `verificationDigest` em `run.json` e acrescenta um evento `verification.completed` com o mesmo digest. A aprovação humana recalcula o digest, verifica o log e exige que o último evento de conclusão coincida.

## Contexto

`run.json` é uma projeção conveniente, não um armazém imutável. A aprovação não pode confiar numa projeção alterada depois da verificação enquanto fonte e contrato continuam iguais.

## Consequências

- Digest em `harness/src/execution/verification.ts:23` (`verificationDigest`); gravação e evento em `harness/src/execution/verification.ts:176-179`; conferência em `harness/src/execution/verification.ts:190-195` (`assertVerificationAttestation`).
- Edição manual da projeção é rejeitada antes da aprovação; as checagens de frescor (fonte/contrato) seguem valendo.
- Não é assinatura digital nem notarização.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum. Completado por [[harness ADR-0019 - Decisão humana atestada]] e [[harness ADR-0020 - Reconciliação terminal]].

## Fonte

`harness/docs/ADR-0018-verification-projection-attestation.md`.
