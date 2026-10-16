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
  - harness/docs/ADR-0002-profiles-and-context.md
  - harness/src/profiles/index.ts
  - harness/src/context/index.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0002 - Perfis e provedores de contexto opcionais

> [!tldr] Em linguagem comum
> Um contrato pode ter perfis (pai → filho) que ajustam limites e checagens sem nunca dispensar aprovação humana; o contexto vem de um provedor plugável.

← [[00 Decisões - harness]]

## Status e datas

Aceito. Data no ADR: 2026-08-29 (`harness/docs/ADR-0002-profiles-and-context.md:4`).

## A decisão em linguagem comum

Um perfil nomeado resolve a cadeia de pais de forma determinística, sobrepõe orçamentos, raízes de limpeza e checagens existentes (por ID) antes de validar e calcular o hash do contrato. Perfil ausente, ciclo ou ID de checagem desconhecido falham fechado. Recuperação de contexto é um slot de plugin opcional: o provedor devolve consulta, referências, procedência e um hash do snapshot.

## Contexto

O mesmo contrato precisa ser reutilizado em situações diferentes (orçamentos, escopo de limpeza) sem virar um contrato novo a cada vez, e o contexto (Doc Bridge, Playbook) não pode virar dependência do núcleo.

## Consequências

- A resolução de perfis está em `harness/src/profiles/index.ts:38` (`resolveProfile`); o slot em `harness/src/context/index.ts:92` (`CONTEXT_PROVIDER_SLOT`).
- Perfis não contornam checagens obrigatórias nem a aprovação humana; provedores não aprovam execução nem trocam o contrato congelado em silêncio.
- Descoberta remota de provedores, credenciais e política de cache ficam fora do núcleo.

## Pacotes afetados

[[harness-kernel]], [[harness-adapters]] (provedores concretos de contexto)

## Substitui / substituído por

Nenhum. Complementado por [[harness ADR-0003 - Contexto do Doc Bridge ligado à execução]].

## Fonte

`harness/docs/ADR-0002-profiles-and-context.md`.
