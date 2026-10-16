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
  - harness/docs/ADR-0011-runtime-attestation.md
  - harness/src/execution/runtime.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0011 - Atestação de runtime na evidência

> [!tldr] Em linguagem comum
> O resultado de uma ferramenta passa a dizer em qual imagem e com quais limites ela rodou, para revisores correlacionarem evento e ambiente.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Provedores de runtime podem anexar evidência tipada aos resultados concluídos ou falhos. O provedor Docker resolve o ID da imagem local antes de executar, calcula o hash do perfil efetivo mais esse ID e leva a atestação ao evento terminal. Imagem ausente ou daemon indisponível falham antes da execução.

## Contexto

O hash do resultado prova o que a ferramenta devolveu, não qual imagem ou limites a produziram.

## Consequências

- Tipo `DockerRuntimeEvidence` em `harness/src/execution/runtime.ts:54`; resolução do ID da imagem em `harness/src/execution/runtime.ts:318`.
- A evidência é descritiva, ligada a run, revisão de fonte e hash de configuração do evento; não afirma que daemon ou kernel do host sejam confiáveis.
- Runtimes sem evidência continuam compatíveis (campo opcional).

## Pacotes afetados

[[harness-kernel]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0011-runtime-attestation.md`.
