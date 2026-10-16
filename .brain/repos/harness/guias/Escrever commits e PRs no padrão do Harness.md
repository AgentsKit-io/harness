---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; regras de AGENTS.md, CONTRIBUTING.md e do modelo de PR"
fontes:
  - harness/AGENTS.md
  - harness/CONTRIBUTING.md
  - harness/.github/pull_request_template.md
  - harness/.github/CODEOWNERS
tags: [guia, repo/harness, camada/ferramenta]
---

# Escrever commits e PRs no padrão do Harness

> [!tldr] Em linguagem comum
> Mensagens curtas e técnicas no formato Conventional Commits; o PR diz o contrato, a evidência, os comandos executados e o que ficou pendente.

← [[00 Hub - harness]]

## Quando usar

Antes de cometer ou abrir um PR neste repositório.

## Pré-requisitos

Mudança validada ([[Validar uma mudança no Harness]]).

## Passos

1. **Commit:** `<tipo>(<escopo>): <descrição no imperativo>`; tipos `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `chore`, `revert`; use rodapé `BREAKING CHANGE:` quando couber (`harness/CONTRIBUTING.md:62-77`). Exemplo da casa: `fix(deliver): block, not silently hold, after two incomplete reviews` (`git log`).
2. **Estilo "caveman":** assunto e corpo terse, técnicos: diga a mudança e o motivo, sem narrativa; "se a explicação é maior que o diff, corte a explicação, não o diff" (`harness/AGENTS.md:34-40`).
3. **Escopo:** commits focados; nunca commitar segredos, `dist/`, estado de verificação ou resíduo de outra tarefa (`harness/CONTRIBUTING.md:79-82`).
4. **PR:** preencha o modelo — O quê / Por quê / Como / Contrato / Validação / Definição de pronto / **Reuse** / Risco e compatibilidade / Foco da revisão (`harness/.github/pull_request_template.md`). Declare contrato alterado, estados afetados, evidência, comandos exatos e bloqueios (`harness/CONTRIBUTING.md:84-88`).
5. **Revisão obrigatória de mantenedor** para API pública, CLI, máquina de estados, segurança ou release; `CODEOWNERS` é indicativo ("a CI continua sendo o portão do merge", `harness/.github/CODEOWNERS:1`).
6. **Convenções da casa** a respeitar no código, cada uma nomeada pelo desperdício que evita (`harness/AGENTS.md:96-113`): `digest:` (conteúdo repetido vai por hash), `windowed:` (nenhuma leitura de histórico sem limite), `scope:` (verificação do critério tocado), `cheapest-sufficient:` (modelo por dificuldade; o papel que escreve código nunca tem padrão mais fraco que o que só lê) e `one-shot-vote:` (uma chamada com N perspectivas em vez de N chamadas).
7. **Atalhos intencionais** ganham um comentário de uma linha `ponytail: <fato>; <consequência>.` (`harness/AGENTS.md:16-26`); procure exemplos em `src/execution/verification.ts`, `src/loop/deliver.ts`, `src/loop/doctor.ts`.

## Como validar

O PR passa na CI (`release-harness.yml`) e o checklist do modelo está marcado; não marque completo com evidência ausente ou velha (`harness/.github/pull_request_template.md:61`).

## Erros comuns

- Mensagem narrativa longa; commit misturando pacotes; testes desabilitados "para passar" (proibido no checklist, `harness/.github/pull_request_template.md:42`).
- Pular a seção **Reuse**: dependência nova precisa de justificativa.
- Pedir aprovação a si mesmo: "nunca aprove a própria saída" (`harness/AGENTS.md:71`).

## Notas relacionadas

[[harness-kernel]] · [[Mudar a API pública do Harness]] · [[Publicar uma versão do Harness no npm]]
