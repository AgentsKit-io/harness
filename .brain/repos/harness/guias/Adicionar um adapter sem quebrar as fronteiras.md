---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; regras de AGENTS.md, MODULE-BOUNDARIES.md e do script de fronteira; nada foi executado"
fontes:
  - harness/AGENTS.md
  - harness/docs/MODULE-BOUNDARIES.md
  - harness/docs/ORGANIZATION.md
  - harness/scripts/verify-dependency-directions.mjs
  - harness/src/adapters/command.ts
  - harness/src/adapters/github-cli.ts
tags: [guia, repo/harness, camada/ferramenta]
---

# Adicionar um adapter sem quebrar as fronteiras

> [!tldr] Em linguagem comum
> Qualquer ferramenta de fora entra pela porta dos adapters, falando por argumentos e nunca por shell; o núcleo nunca a conhece.

← [[00 Hub - harness]]

## Quando usar

Ao integrar um novo tracker, SCM, orquestrador, provedor de contexto, memória, modelo ou ponte (MCP, eventos). "Qualquer novo provedor externo precisa entrar por um adapter ou slot de plugin; um import novo de provedor no kernel é violação de fronteira e exige um ADR" (`harness/docs/MODULE-BOUNDARIES.md:133-135`).

## Pré-requisitos

Ler [[harness ADR-0026 - Fronteira entre kernel e adapters]] e [[harness-adapters]]; antes de criar dependência nova, "reuse first": pacotes do ecossistema → bibliotecas estabelecidas → código novo, justificado na seção **Reuse** do PR (`harness/AGENTS.md:28-32`).

## Passos

1. **Contrato:** peça um `CommandRunner` (`harness/src/adapters/command.ts:29`); aceite `bin` e `timeoutMs` por opção, como `GitHubCliOptions`/`OrcaCliOptions`.
2. **Argv:** monte listas de argumentos; texto livre vai como elemento isolado; falha de transporte, timeout ou envelope inválido vira `HarnessError` (padrão em `harness/src/adapters/github-cli.ts:112-118`).
3. **Efeitos idempotentes:** escritas externas levam uma chave (`dedupeKey`, `--write-id`, `idempotencyKey`) — a mesma chave não repete o efeito (`harness/src/adapters/tracking.ts:26-46`).
4. **Telemetria honesta:** o que não pode ser observado é `status: 'unknown'` (`harness/src/kernel/adapter-contract.ts:44`); "unknown" não entra em alegação de melhoria.
5. **Seleção:** se for seleção por configuração, adicione uma fábrica em `resolveConnectors` e um valor em `connectors.*` (`harness/src/loop/connectors.ts:277`) — nunca mude `tick`/`deliver`/`release`.
6. **Exportação:** só símbolos nomeados em `src/index.ts` ([[Mudar a API pública do Harness]]).
7. **Testes:** fake do `CommandRunner` em `test/adapters-<nome>-*.test.ts`; sem rede.

## Como validar

```bash
pnpm test:adapters
pnpm test:boundaries          # kernel↛adapters, adapters↔execution
pnpm check:public-api
```

## Erros comuns

- Importar o adapter de dentro do kernel: `findDependencyViolations` falha (`harness/scripts/verify-dependency-directions.mjs:40-42`).
- Adicionar uma dependência de SDK de fornecedor ao `package.json`: o pacote é "neutro de provedor" (`harness/AGENTS.md:61-62`).
- Converter erro de provedor em sucesso para "não travar": adapters não podem enfraquecer gates (`harness/AGENTS.md:54`).
- Construir uma interface com uma só implementação "porque deve variar": ADR-0034 diz que a costura só é provada por uma segunda implementação.

## Notas relacionadas

[[harness-adapters]] · [[harness-kernel]] · [[harness ADR-0034 - Conectores de tracker SCM e runner]] · [[harness ADR-0028 - MCP só como adapter]]
