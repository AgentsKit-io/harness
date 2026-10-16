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
  - harness/docs/ADR-0022-signed-evidence-bundle.md
  - harness/src/execution/bundle.ts
  - harness/src/cli.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0022 - Pacote de evidência assinado

> [!tldr] Em linguagem comum
> Uma execução concluída pode ser empacotada com hashes de todos os arquivos e uma assinatura Ed25519, e verificada fora da máquina de origem.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

`exportEvidenceBundle` empacota uma execução `COMPLETE` reconciliada, sua projeção, o log de eventos e as saídas de checagem referenciadas. Cada arquivo recebe SHA-256 e o payload canônico é assinado com uma chave privada Ed25519; ID da chave e assinatura viajam no pacote. `verifyEvidenceBundle` confere todos os hashes, o hash do payload e a assinatura; opcionalmente exige uma chave ativa de uma trust store em vez de confiar na chave embutida.

## Contexto

O encadeamento por hash protege o log local de edições casuais, mas um revisor ou CI precisa de um artefato portátil cuja procedência seja verificável fora do workspace.

## Consequências

- Exportação em `harness/src/execution/bundle.ts:75` (assinatura em `:95`); verificação em `harness/src/execution/bundle.ts:107` (assinatura conferida em `:130`); trust store em `harness/src/execution/bundle.ts:135`. Limites de tamanho: 25 MiB por arquivo e 200 MiB no total (`harness/src/execution/bundle.ts:104-105`).
- CLI: `events export` e `events verify-bundle` em `harness/src/cli.ts:582-583`.
- O pacote contém saídas de checagem como capturadas: tratar como artefato potencialmente sensível. Custódia de chave é do operador; não substitui KMS ou notarização.

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0022-signed-evidence-bundle.md`.
