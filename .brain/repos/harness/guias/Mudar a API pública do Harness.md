---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; comandos de CONTRIBUTING.md e dos scripts check-public-api e generate-capability-manifest; nada foi executado"
fontes:
  - harness/CONTRIBUTING.md
  - harness/src/index.ts
  - harness/scripts/check-public-api.mjs
  - harness/scripts/generate-capability-manifest.mjs
  - harness/docs/stability/public-api-v1.json
  - harness/capabilities/public-surface.json
  - harness/package.json
tags: [guia, repo/harness, camada/ferramenta]
---

# Mudar a API pública do Harness

> [!tldr] Em linguagem comum
> Qualquer nome novo, removido ou que mude de natureza em `src/index.ts` precisa ser deliberado: o snapshot da API falha na CI até alguém revisar e commitar a atualização.

← [[00 Hub - harness]]

## Quando usar

Ao adicionar, remover ou renomear uma exportação de `src/index.ts` — a **única** entrada suportada para consumidores (`harness/AGENTS.md:52`, `harness/docs/ORGANIZATION.md:30-31`).

## Pré-requisitos

`pnpm install`; saber qual capacidade a exportação serve (kernel, execução, adapter ou composição, `harness/scripts/generate-capability-manifest.mjs:14`).

## Passos

1. Edite o módulo e exporte o novo nome em `harness/src/index.ts`. Cuidado com nomes repetidos: `cancelRun`/`retryRun` do protocolo e os da UI coexistem com alias (`harness/src/index.ts:166-171`).
2. Veja o que mudou na superfície:
   ```bash
   pnpm check:public-api
   ```
   Ele compara os nomes exportados e seus tipos (`type`/`value`) com `docs/stability/public-api-v1.json` e imprime `+`/`-`/`~` por símbolo (`harness/scripts/check-public-api.mjs:120-151`).
3. Se a mudança é intencional, atualize o snapshot e **revise o diff** antes de commitar:
   ```bash
   pnpm check:public-api:update
   ```
4. Atualize também o manifesto de capacidades, que é gerado do `src/index.ts` e conferido na CI:
   ```bash
   node scripts/generate-capability-manifest.mjs --write capabilities/public-surface.json
   pnpm test:capabilities
   ```
   (`harness/scripts/generate-capability-manifest.mjs:45-50`; `test:capabilities` está em `harness/package.json:79` e roda no job `docs` da CI, `harness/.github/workflows/release-harness.yml:78`).
5. Atualize README/CHANGELOG/ADR se o protocolo mudou, e adicione teste por critério (`harness/CONTRIBUTING.md:20-25`).
6. Marque "Public API or CLI changed: yes" no PR e peça revisão de mantenedor (`harness/.github/pull_request_template.md:51-56`, `harness/CONTRIBUTING.md:86-88`).

## Como validar

```bash
pnpm typecheck && pnpm check:public-api && pnpm test:capabilities && pnpm test:boundaries
```

## Erros comuns

- Esquecer o `--update`: a CI mostra "exported API drifted" com o diff dos símbolos (`harness/scripts/check-public-api.mjs:164-173`).
- Exportar tipo e valor com o mesmo nome muda `kinds`: o snapshot registra `type|value`.
- Reexportar um módulo inteiro de adapter: o desenho só reexporta símbolos nomeados, "nenhuma implementação de adapter é reexportada em bloco" (`harness/docs/MODULE-BOUNDARIES.md:155-156`).
- Dividir a mudança: "um pacote, ou uma mudança isolada de gate transversal, por PR" (`harness/.github/pull_request_template.md:37`).

## Notas relacionadas

[[harness-kernel]] · [[harness ADR-0026 - Fronteira entre kernel e adapters]] · [[Validar uma mudança no Harness]] · [[Adicionar um adapter sem quebrar as fronteiras]]
