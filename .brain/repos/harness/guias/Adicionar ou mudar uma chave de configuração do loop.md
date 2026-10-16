---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; passos derivados de config.ts, dos geradores de referência e do workflow de CI; nada foi executado"
fontes:
  - harness/src/loop/config.ts
  - harness/src/loop/presets.ts
  - harness/loop.config.example.yaml
  - harness/scripts/gen-docs-reference.mjs
  - harness/apps/docs/content/docs/reference/configuration.mdx
  - harness/.github/workflows/release-harness.yml
  - harness/docs/ADR-0033-four-config-layers-and-presets.md
tags: [guia, repo/harness, camada/ferramenta]
---

# Adicionar ou mudar uma chave de configuração do loop

> [!tldr] Em linguagem comum
> A configuração do loop tem um único esquema; uma chave nova precisa de um padrão que não mude o comportamento de ninguém, e a referência pública é regenerada do esquema.

← [[00 Hub - harness]]

## Quando usar

Para qualquer nova opção em `loop.config.yaml` (ou nas camadas global, de time e de máquina).

## Pré-requisitos

Entender as quatro camadas e a regra "o projeto pesa mais que o global" ([[harness ADR-0033 - Quatro camadas de configuração e presets]]); `pnpm install`.

## Passos

1. **Esquema:** acrescente o campo em `LoopConfigSchema` (`harness/src/loop/config.ts:105`), com comentário que diga *por que* existe. Use um padrão seguro (`.default(...)`, `.prefault({})` em blocos) para que uma configuração antiga mantenha o comportamento anterior — é o que fizeram os blocos `resilience`, `brief`, `project.setup`, `github` etc. (`harness/docs/ADR-0029-loop-resilience-pinning-intake.md`, Consequências).
2. **Regras entre campos:** se dois campos dependem um do outro, valide em `validateLoopConfig` e falhe com `INVALID_CONFIG` (`harness/src/loop/config.ts:1052-1095`).
3. **Listas de gate:** se a lista for uma proteção (como `selfEditPaths`), inclua-a em `GATE_LISTS` para que as camadas acumulem e só encolham com `!entrada` (`harness/src/loop/config.ts:1124`).
4. **Preset:** só mexa em `src/loop/presets.ts` se o valor for padrão de um *tipo de projeto* (`harness/src/loop/presets.ts:11-80`); um preset nunca sobrescreve o que o projeto declarou.
5. **Uso:** leia o campo no módulo do loop; nunca use o valor bruto do YAML.
6. **Exemplo:** documente em `loop.config.example.yaml` quando for opção de usuário; a CI valida esse arquivo (`node dist/cli.js loop validate -f loop.config.example.yaml --json`, `harness/.github/workflows/release-harness.yml:104`).
7. **Referência pública (gerada):**
   ```bash
   pnpm build
   pnpm docs:generate
   ```
   `apps/docs/content/docs/reference/configuration.mdx` não se edita à mão; o job `docs` roda `pnpm docs:generate --check` e quebra se o commitado divergir (`harness/.github/workflows/release-harness.yml:72-75`).
8. **Teste:** acrescente casos em `test/loop.test.ts` ou `test/loop-config-layers.test.ts` (camadas, padrões) e no teste do módulo que usa o campo.

## Como validar

```bash
pnpm test:loop
node dist/cli.js loop validate -f loop.config.example.yaml --json
pnpm docs:generate --check
```

## Erros comuns

- Um erro de digitação na chave do YAML **não falha**: o zod remove a chave e só `loop validate`/`doctor` a reportam (`harness/src/loop/config.ts:1106-1115`).
- Padrão que muda comportamento existente: ADR-0029 exige "zero mudança" para quem não optou.
- Escrever uma preferência pessoal na camada de projeto: ela vai para `~/.agentskit/harness.yaml` ou `loop.config.local.yaml`.
- Esquecer que `connectors.runner: local` é recusado na validação (`harness/src/loop/config.ts:1093`).

## Notas relacionadas

[[harness-loop]] · [[harness-ui]] (a UI mostra a configuração com procedência e só grava a camada pessoal) · [[Validar uma mudança no Harness]] · [[Atualizar e publicar a documentação do Harness]]
