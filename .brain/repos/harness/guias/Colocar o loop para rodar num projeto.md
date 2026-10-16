---
tipo: guia
repo: harness
camada: ferramenta
visibilidade: publico
verificado-em: 2026-10-16
commits:
  harness: 40d033b
metodo: "análise estática; comandos de README.md, docs/GETTING-STARTED.md e docs/LOOP.md conferidos contra src/cli.ts; nada foi executado"
fontes:
  - harness/README.md
  - harness/docs/GETTING-STARTED.md
  - harness/docs/LOOP.md
  - harness/src/cli.ts
  - harness/src/loop/install.ts
  - harness/src/loop/init.ts
  - harness/loop.config.example.yaml
tags: [guia, repo/harness, camada/ferramenta]
---

# Colocar o loop para rodar num projeto

> [!tldr] Em linguagem comum
> Quatro comandos, em ordem, seguros de repetir: escrever a configuração, ver se a máquina está pronta, ensaiar um tick e só então agendar. Nada antes do último toca seu repositório, seu tracker ou sua agenda.

← [[00 Hub - harness]]

## Quando usar

Primeira instalação do loop num repositório, ou numa máquina nova para um projeto que já tem `loop.config.yaml`.

## Pré-requisitos

- Node ≥ 22 e `pnpm add -D @agentskit/harness` (ou `npx`); o comando agendado precisa existir **no ambiente do Orca**: `npm i -g @agentskit/harness` ou `schedule.harnessCommand` absoluto (`harness/src/loop/install.ts:53`).
- Orca em versão ≥ 1.4.200 acessível (`orca.minVersion`, `harness/src/loop/config.ts:146`), `gh` autenticado com escrita no repositório, `git`, CLIs de agente (`claude`, `codex`, …) e `agentskit-review` (`npm i -g @agentskit/code-review`, `harness/src/loop/guided-install.ts:65`).
- Tracker: Linear (via Orca) ou GitHub Issues (`connectors.tracker: github`, `harness/README.md:119-142`).

## Passos

1. **Configuração** (`harness/docs/GETTING-STARTED.md:25-40`):
   ```bash
   npx ak-harness loop init                       # pergunta só o que um preset não sabe
   npx ak-harness loop init --preset monorepo --repo acme/demo --team ENG --global --dry-run
   ```
   Presets: `web-app`, `library`, `monorepo`, `data-pipeline`, `mobile` (`harness/src/loop/presets.ts:11`). `--global` escreve também `~/.agentskit/harness.yaml` (modelos/provedores desta máquina) quando não existe. Nunca sobrescreve sem `--force`.
2. **Checar:**
   ```bash
   npx ak-harness loop validate -f loop.config.yaml     # configuração efetiva + hash + chaves desconhecidas
   npx ak-harness loop doctor                           # exit 1 se um check bloqueante falhar; nada é despachado
   npx ak-harness loop tick --dry-run --max 1           # imprime issue, contrato, worktree e modelo; não escreve nada
   ```
   O `doctor` é "a resposta a 'por que não funciona' nove vezes em dez" (`harness/docs/GETTING-STARTED.md:48-53`). Checks: Orca, provedores, roteamento por papel, vagas, fila, `brief.skills`, `plugins.modules`, `mcp.allowlist` (`harness/docs/LOOP.md:741-750`).
3. **Agendar** (guiado: doctor, ensaio, sobreposição local, confirmação):
   ```bash
   npx ak-harness loop install              # idempotente por nome; --dry-run mostra o argv do orca; --yes aceita tudo
   ```
   Cria `<prefix>-tick` e `<prefix>-deliver` (e `-retro`/`-observe` se declarados em `schedule`) no Orca; o precheck **é** o estágio (`loop stage tick|deliver`) e sai com 1, para o Orca não abrir sessão de agente (`harness/docs/LOOP.md:94-116`).
4. **Primeiro tick real** (uma vez, à mão, para ver acontecer):
   ```bash
   npx ak-harness loop tick --max 1
   npx ak-harness loop watch --once
   npx ak-harness loop deliver
   ```
   Depois de instalado, **não** repita tick/deliver à mão: use as leituras ([[Operar e diagnosticar o loop do Harness]]).

## Como validar

`loop status` lista as automações do Orca e a última execução de cada; `loop doctor` acusa `automations.drift` quando uma automação diverge do `schedule:` (`harness/docs/LOOP.md:101-106`).

## Erros comuns

- `no builder provider available`, `machine.slots: 0 free` e `queue has no dispatchable candidate`: veja a tabela em `harness/apps/docs/content/docs/guides/troubleshooting.mdx:13-19`.
- Configurar `connectors.runner: local` esperando rodar sem Orca: é recusado na validação (`harness/src/loop/config.ts:1093`).
- Um segredo (URL de webhook) no `loop.config.yaml`: a URL fica numa variável de ambiente indicada por `notifications.webhook.urlEnv`; só o arquivo global do usuário aceita URL literal (`harness/docs/LOOP.md:253-254`).
- Editar uma automação à mão no Orca: ela deriva do `loop.config.yaml`; rode `loop install` de novo (`harness/docs/LOOP.md:101-110`).

## Notas relacionadas

[[harness-loop]] · [[Harness - Da issue ao merge]] · [[harness ADR-0033 - Quatro camadas de configuração e presets]] · [[00 Hub - agentskit]] (Orca e o ecossistema)
