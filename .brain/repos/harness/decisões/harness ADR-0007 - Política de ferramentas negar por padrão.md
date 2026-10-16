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
  - harness/docs/ADR-0007-policy-gate.md
  - harness/src/kernel/policy.ts
  - harness/src/execution/agent.ts
tags: [adr, repo/harness, camada/ferramenta]
---

# harness ADR-0007 - Política de ferramentas negar por padrão

> [!tldr] Em linguagem comum
> Toda chamada de ferramenta de um agente passa por uma lista ordenada de regras; o que nenhuma regra permite é bloqueado.

← [[00 Decisões - harness]]

## Status e datas

Aceito (sem data no documento; no histórico git desde 2026-09-09).

## A decisão em linguagem comum

Todo `SessionRecorder` recebe um `PolicyGate`. O `createPolicyGate` embutido avalia regras de ferramenta exata em ordem, usa a primeira que casar e bloqueia por padrão quando nenhuma permite. Uma regra pode permitir, bloquear ou exigir aprovação humana; cada decisão é registrada e ações que exigem aprovação não entram no ciclo de execução até um humano aprovar.

## Contexto

Observar chamadas não impede uma ação insegura ou fora de escopo; o núcleo precisa de um ponto de controle portátil antes de qualquer execução específica de provedor.

## Consequências

- Implementação: `harness/src/kernel/policy.ts:32` (`createPolicyGate`); a primeira regra que casa vence e o padrão é `default-deny` (`harness/src/kernel/policy.ts:49-50`).
- O gate só recebe hashes e identificadores; não executa ferramentas nem aprova a tarefa (`harness/src/execution/agent.ts:19` exige `policy` no gravador).
- Integrações existentes precisam de allowlist explícita ou ficam bloqueadas.
- O mesmo gate é reutilizado pela ponte MCP ([[harness ADR-0028 - MCP só como adapter]]) e pelo `loop doctor` (`harness/src/loop/doctor.ts:212`).

## Pacotes afetados

[[harness-kernel]], [[harness-adapters]]

## Substitui / substituído por

Nenhum.

## Fonte

`harness/docs/ADR-0007-policy-gate.md`.
