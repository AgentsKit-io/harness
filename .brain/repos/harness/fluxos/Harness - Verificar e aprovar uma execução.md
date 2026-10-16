---
tipo: fluxo
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; sequência reconstruída de verification.ts, events.ts, bundle.ts e do workflow de CI; nada foi executado"
fontes:
  - harness/README.md
  - harness/src/execution/verification.ts
  - harness/src/execution/runs.ts
  - harness/src/execution/source.ts
  - harness/src/execution/bundle.ts
  - harness/src/kernel/constants.ts
  - harness/src/kernel/events.ts
  - harness/src/kernel/state-machine.ts
  - harness/.github/workflows/release-harness.yml
  - harness/.ak-harness/verification.json
tags: [fluxo, repo/harness, camada/ferramenta]
---

# Harness - Verificar e aprovar uma execução

> [!tldr] Em linguagem comum
> O protocolo de uma única execução: aprovar o contrato, implementar, rodar as checagens, selar o resultado num diário encadeado e só então considerar concluído — com aprovação humana quando a política exige.

← [[00 Hub - harness]]

## Entrada e resultado

**Entrada:** um contrato `.ak-harness/verification.json` (intenção, escopo, resultados, checagens, autonomia, rastreio). **Resultado:** uma execução `COMPLETE` com evidência ligada ao `HEAD` do git, um log de eventos encadeado e, se pedido, um pacote assinado. É o protocolo "ak-verify" sobre o qual o loop foi construído (`harness/README.md:185-205`).

```bash
ak-harness plan approved --by human     # aprova o contrato
ak-harness start                        # CLARIFYING/PLANNED → IMPLEMENTING
ak-verify run --json                    # roda as checagens, sela o resultado
ak-verify approve approved --by human --json
```

| Etapa | Estado | O que acontece | Evidência |
|---|---|---|---|
| 1. Plano | `PLANNED` | `planRun` exige ator `human`, decisão aprovada, nenhuma ambiguidade aberta, árvore limpa (ou `--allow-dirty` explícito) e nenhuma execução ativa; contexto resolvido é validado e congelado | `harness/src/execution/verification.ts:77-96` |
| 2. Início | `IMPLEMENTING` | `startRun` registra o início (ator `agent`) | `harness/src/execution/verification.ts:98-102` |
| 3. Verificação | `VERIFYING` | Checagens obrigatórias rodam em lotes limitados pela máquina; `build` é barreira; cada uma imprime JSON final com os resultados que prova; saída bruta vai para `checks/` | `harness/src/execution/verification.ts:112-171` |
| 4. Selo | — | Digest de checagens + resultados + métricas vai para `run.json` e para um evento `verification.completed` | `harness/src/execution/verification.ts:176-179` |
| 5. Próximo estado | `COMPLETE` / `AWAITING_HUMAN_APPROVAL` / `BLOCKED` | Tudo passou + autonomia `yolo` + sem rastreio obrigatório + sem ambiguidade → `COMPLETE`; tudo passou senão → espera humano; qualquer falha ou estouro de orçamento → `BLOCKED` | `harness/src/execution/verification.ts:180-183` |
| 6. Aprovação | `COMPLETE` ou `AWAITING_AUTHORIZATION` | `approveRun` confere frescor e atestação, grava `approval.recorded` (e `authorization.recorded` no modo "escopo do objetivo"); rejeição vira `BLOCKED` e também é gravada | `harness/src/execution/verification.ts:232-248` |
| 7. Autorização separada | `COMPLETE` | Só com `tracking.authorization: "separate"` | `harness/src/execution/verification.ts:250-258` |
| 8. Reconciliação | — | `status`/`audit` conferem corrente, vínculo, digest e eventos de decisão antes de afirmar o estado | `harness/src/execution/verification.ts:205-230` |
| 9. Exportação (opcional) | — | `events export` empacota a execução `COMPLETE` com SHA-256 por arquivo e assinatura Ed25519; `events verify-bundle` confere | `harness/src/execution/bundle.ts:75-130` |

Qualquer mudança de código, configuração ou contrato depois da verificação leva a execução a `STALE` (`harness/src/execution/verification.ts:66-75`, `:186-188`); o caminho de volta é `retry` ou um novo `plan` (`harness/src/kernel/constants.ts:18`: `STALE → PLANNED`).

Estados e transições legais: `harness/src/kernel/constants.ts:3-21`. O CI do repositório encena exatamente este protocolo contra o próprio contrato (`harness/.github/workflows/release-harness.yml:41-47`).

## Persistência, erros e recuperação

- **Arquivos:** `runs/<id>/run.json`, `latest.json`, `events.ndjson` (+ `.lock`), `checks/*.stdout|stderr` (ver [[harness-kernel]]).
- **Lock do log ocupado:** falha com "Event log is busy; retry the operation." (`harness/src/kernel/events.ts:243`); lock órfão só sai por `events unlock --by human` depois de provar que o dono morreu (`harness/src/kernel/events.ts:283-296`; [[harness ADR-0021 - Recuperação explícita de lock do log]]).
- **Adulteração:** `Event log hash chain is invalid.` (`harness/src/kernel/events.ts:223`); projeção alterada → "Verification projection attestation does not match run.json." (`harness/src/execution/verification.ts:192`).
- **Checagem presa:** timeout mata a árvore de processos e, se ela não sair em 2 s, falha com mensagem explícita (`harness/src/execution/verification.ts:45-49`, `harness/src/kernel/process-tree.ts:5`).
- **Sempre humano:** `plan`, `approve`, `authorize`, `cancel` e recuperação de lock exigem `--by human` (`harness/src/kernel/state-machine.ts:12`).

| Limite da evidência | Resultado |
|---|---|
| Escopo | Reconstruído do código; nada executado. O que a CI de fato faz em cada PR está em `release-harness.yml`, mas seus resultados não foram consultados |

Receita de validação: [[Validar uma mudança no Harness]]. ADRs: [[harness ADR-0017 - Log de eventos encadeado por hash]], [[harness ADR-0018 - Atestação da projeção de verificação]], [[harness ADR-0019 - Decisão humana atestada]], [[harness ADR-0020 - Reconciliação terminal]], [[harness ADR-0022 - Pacote de evidência assinado]].

> [!info]- Detalhe técnico
> - Contrato de exemplo com 19 resultados e 23 checagens: `harness/.ak-harness/verification.json:14-34`, `:46-68`; autonomia `yolo` na linha 6.
> - Binários `ak-harness` e `ak-verify` apontam para o mesmo `dist/cli.js` (`harness/package.json:6-9`).
> - Saída final de cada checagem: `{"status":"passed","criteria":["…"]}` (`harness/README.md:197-199`).
