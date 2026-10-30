# Formato do manifesto de MVP e o digest (referência para o #254)

`exemplo-mvp.yaml` é um manifesto **sintético** (produto fictício) no formato real. Manifestos de produtos e código privado nunca entram neste repositório público.

## Formato

- `version: 1`, `product`, `repo`, `source`
- `approval`: `by`, `at`, `digest`
- `homolog.base_url` (opcional)
- `requirements`: uma lista; cada item tem `id` (ex.: `RF-01`), `title`, `done_when` (texto), `weight` (inteiro, padrão 1) e as listas de evidência `acceptance`, `homolog`, `issues` e `prs`.
- É um subconjunto estrito de YAML: mapeamentos, listas com `- `, escalares simples ou entre aspas, e blocos `>-`. Um `:` dentro de um texto sem aspas é erro.

## Digest (o que o dono aprova)

1. Para cada requisito, na ordem, monte `{"id", "title", "done_when", "weight"}`:
   - `title` sem espaços nas pontas;
   - `done_when` com todo espaço em branco (quebras de linha incluídas) colapsado num espaço só e sem espaços nas pontas;
   - `weight` com padrão 1.
2. Serialize a lista em JSON com chaves ordenadas, sem espaços (`,` e `:` como separadores) e UTF-8 sem escapar (`ensure_ascii=false`).
3. `sha256` desse texto em hexadecimal; o digest são os **16 primeiros caracteres**.

As listas de evidência não entram no digest: links podem mudar sem nova aprovação.

Digest esperado para `exemplo-mvp.yaml`: `a5d6dbc14e5f9a24`. Uma implementação correta tem de reproduzir esse valor.

## Aprovação válida

`approval.by` é um aprovador e `approval.digest` é igual ao digest da lista atual. Se não for igual, a lista mudou depois da aprovação e precisa de nova aprovação.
