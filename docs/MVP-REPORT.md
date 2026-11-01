# `ak-harness mvp report --json`

Machine-readable product progress for a `docs/mvp.yaml` manifest. The output is versioned by `schemaVersion` and described by [`schemas/mvp-report.schema.json`](schemas/mvp-report.schema.json); a test (`test/mvp-report-schema.test.ts`) validates real output against it in CI.

```bash
ak-harness mvp report [file] --json [--evidence evidence.json] [--approver <name...>]
```

## Fields (schemaVersion 1)

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Integer, `1`. Bumped only on a breaking change (field removed, renamed or retyped). New optional fields do not bump it. |
| `approved`, `approval` | Whether `approval.by` + `approval.digest` match the current list, and why (or why not). |
| `digest` | Approval digest of the list (`ak-harness mvp digest`). |
| `launch`, `launches` | Earliest launch (`{date, label}` or `null`) and all launches, earliest first. `label` is `piloto`, `público` or `null`. |
| `levels.{merged,accepted,proven}` | `count` of requirements green at the evidence level and `pct` (0–100, by weight). `merged` = PRs merged with green CI, `accepted` = acceptance tests green, `proven` = homolog checks green. |
| `states` | Requirement counts: `pronto` (proven), `qa` (merged, not yet proven), `bloqueado` (a level failed), `sem-comecar`. |
| `total`, `weight`, `noEvidence` | Requirements, summed weight, requirements with no evidence at any level. |
| `pct` | Official % proven; `null` until the approval matches the list. |
| `requirements[]` | Per requirement: `id`, `title`, `doneWhen`, `weight`, `state` and `levels.{merged,accepted,proven}` = `{ok, detail}`. `ok` is `true`, `false`, or `null` (sem evidência — missing evidence is never success). |

## Exit codes

| Code | When |
| --- | --- |
| `0` | Report printed. The report is a measurement: red or missing evidence does not change the exit code; read `states`/`pct`. |
| `1` | `INVALID_CONFIG`: the manifest does not parse or validate. Message on stderr as `INVALID_CONFIG: ...`; nothing on stdout. |
| `2` | `INVALID_INPUT`: no manifest found, unreadable manifest, or unreadable/invalid `--evidence` JSON. |

`ak-harness mvp check` uses the same codes (`1` for manifest errors).
