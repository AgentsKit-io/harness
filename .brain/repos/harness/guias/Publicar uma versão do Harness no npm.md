---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; passos derivados do workflow, dos scripts verify-release-* e de CONTRIBUTING.md; nenhuma publicação foi feita ou consultada"
fontes:
  - harness/.github/workflows/release-harness.yml
  - harness/CONTRIBUTING.md
  - harness/README.md
  - harness/package.json
  - harness/release/manifest.json
  - harness/scripts/verify-release-workflow.mjs
  - harness/scripts/verify-release-manifest.mjs
  - harness/scripts/verify-release-evidence.mjs
  - harness/scripts/verify-repository-docs.mjs
tags: [guia, repo/harness, camada/ferramenta]
---

# Publicar uma versão do Harness no npm

> [!tldr] Em linguagem comum
> A publicação acontece sozinha quando um merge na `main` traz uma versão que o registro ainda não tem — mas só depois de todos os portões do mesmo workflow passarem. O nome do arquivo do workflow é parte da autorização.

← [[00 Hub - harness]]

## Quando usar

Ao lançar uma nova versão de `@agentskit/harness`.

## Pré-requisitos

- Publicador confiável (Trusted Publishing, OIDC) configurado no npm para `AgentsKit-io/harness` e para o workflow `release-harness.yml` (`harness/CONTRIBUTING.md:90-95`). **Não existe `NPM_TOKEN`**; um script falha se algo o referenciar (`harness/scripts/verify-release-workflow.mjs:10-11`).
- Não renomeie `.github/workflows/release-harness.yml`: o npm autoriza por repositório *e nome do arquivo*; a publicação por `ci.yml` foi rejeitada com 404 (`harness/.github/workflows/release-harness.yml:3-8`).

## Passos

1. Suba `version` em `package.json` e documente em `CHANGELOG.md` no formato `## [x.y.z]` (conferido por `verify-repository-docs.mjs:8`).
2. Atualize a evidência que viaja no tarball (`files` inclui `release/`, `harness/package.json:18-33`): `release/manifest.json` (mesma versão e digest recalculado, `harness/scripts/verify-release-manifest.mjs:9-14`), `release/qualification.json` e `release/notes.md` que cite a versão (`harness/scripts/verify-release-evidence.mjs:11-18`).
3. Rode o portão local e abra o PR com revisão de mantenedor:
   ```bash
   pnpm typecheck && pnpm test && pnpm build && pnpm pack --pack-destination /tmp/agentskit-harness-pack
   pnpm test:release-manifest
   ```
4. Merge na `main`. O job `publish` roda **depois** de `verify`, `docs` e `loop-cross-platform` (`needs`), só em `push` na `main` do repositório `AgentsKit-io/harness`, serializado no grupo `release-harness` sem cancelar (`harness/.github/workflows/release-harness.yml:109-120`).
5. O job instala `npm@^11.5.1`, recusa token legado, faz `pnpm build` e consulta o registro: se `@agentskit/harness@<versão>` já existe, não faz nada; senão `npm publish --provenance --access public --ignore-scripts` (`harness/.github/workflows/release-harness.yml:131-163`).

## Como validar

`npm view @agentskit/harness@<versão> version` responde; o tarball tem proveniência. `harness/release/manifest.json:30-33` ainda lista `blockedCriteria` (`ecosystem-compatibility`, `pilot-benchmark`) — critérios não verificados que o script exige que sejam explícitos (`harness/scripts/verify-release-manifest.mjs:13`).

## Erros comuns

- 404 no PUT do publish: workflow/nome de arquivo diferente do registrado no npm.
- Esquecer `release/qualification.json` ou `release/notes.md`: o job `docs` falha com `release-evidence` (`harness/.github/workflows/release-harness.yml:79`).
- Mudar o workflow tirando o `needs` do `publish`: `verify-release-workflow.mjs` falha ("publish does not depend on…", `:22`).
- Esperar que `prepublishOnly` rode: o publish usa `--ignore-scripts`.

## Notas relacionadas

[[harness-kernel]] · [[Validar uma mudança no Harness]] · [[Infra e deploy]]
