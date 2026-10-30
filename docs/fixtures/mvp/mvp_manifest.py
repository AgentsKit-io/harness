#!/usr/bin/env python3
"""mvp_manifest.py: the MVP requirements manifest of a product (docs/mvp.yaml in the product repo) and its three levels.

Owner decision 2026-10-29: a product's MVP % is the PRD's requirements, one by one, not tickets. Each requirement has
an id (RF-01), a title, a "pronto quando" (done_when) and a weight (default 1). "Done" has three levels, shown apart:
  merged    (a) code merged with CI green: every linked PR merged, with green checks on its merge (or head) commit;
  accepted  (b) acceptance test green: every acceptance check green on the default branch;
  proven    (c) proven in homolog: every homolog check green (a live URL, a CI smoke job, a recorded run).
The manifest may also carry `launch` (date: AAAA-MM-DD, label: piloto|público, optional; one mapping or a list of them): the
product's launch(es); the factory line orders the products by the EARLIEST date (default order, with a bonus for who is behind the planned %).
The official % is proven ÷ total (by weight), and only when the owner approved the list (approval.by is an approver
and approval.digest matches the list as it is now). Evidence the report cannot check is "sem evidência": not counted.

  mvp_manifest.py validate <file>     parse and check the format; prints the errors (exit 1) or "ok"
  mvp_manifest.py digest <file>       the digest to write in approval.digest (the owner approves this exact list)
  mvp_manifest.py json <file>         the parsed manifest as JSON

The file is a strict subset of YAML (so the report needs no PyYAML): mappings, `- ` lists, plain / "double" / 'single'
quoted scalars, numbers, true/false/null, flow lists `[1, 2]`, and the block scalars `|` and `>` (with - or +).
No anchors, tags, multi-documents or flow mappings. Standard library only.
"""
import datetime, hashlib, json, re, sys

FILES = ('docs/mvp.yaml', '.factory/mvp.yaml')
ID_RE = re.compile(r'^[A-Z][A-Z0-9]*-[0-9]+[a-z]?$')
LEVELS = ('merged', 'accepted', 'proven')
LAUNCH_LABELS = ('piloto', 'público')
DATE_RE = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')


class ManifestError(ValueError):
    pass


# ---------- the YAML subset ----------
def _strip_comment(s):
    out, q, i = [], None, 0
    while i < len(s):
        c = s[i]
        if q:
            out.append(c)
            if q == '"' and c == '\\' and i + 1 < len(s): out.append(s[i + 1]); i += 2; continue
            if c == q: q = None
        elif c in '"\'' and (not out or out[-1] in ' [,:-' or ''.join(out).strip() == ''):
            q = c; out.append(c)
        elif c == '#' and (not out or out[-1] in ' \t'):
            break
        else:
            out.append(c)
        i += 1
    return ''.join(out).rstrip()


def _split_flow(s, lineno):
    items, cur, q, i = [], [], None, 0
    while i < len(s):
        c = s[i]
        if q:
            cur.append(c)
            if q == '"' and c == '\\' and i + 1 < len(s): cur.append(s[i + 1]); i += 2; continue
            if c == q: q = None
        elif c in '"\'':
            q = c; cur.append(c)
        elif c in '[]{}':
            raise ManifestError(f'linha {lineno}: listas aninhadas em [ ] não são aceitas')
        elif c == ',':
            items.append(''.join(cur).strip()); cur = []
        else:
            cur.append(c)
        i += 1
    if q: raise ManifestError(f'linha {lineno}: aspas sem fechar')
    last = ''.join(cur).strip()
    if last or items: items.append(last)
    if any(x == '' for x in items): raise ManifestError(f'linha {lineno}: item vazio em [ ]')
    return items


def _scalar(s, lineno):
    s = s.strip()
    if s == '' or s in ('~', 'null', 'Null', 'NULL'): return None
    if s.startswith('"'):
        if not s.endswith('"') or len(s) < 2: raise ManifestError(f'linha {lineno}: aspas sem fechar')
        try: return json.loads(s)
        except ValueError as e: raise ManifestError(f'linha {lineno}: texto entre aspas inválido ({e})')
    if s.startswith("'"):
        if not s.endswith("'") or len(s) < 2: raise ManifestError(f"linha {lineno}: aspas sem fechar")
        return s[1:-1].replace("''", "'")
    if s.startswith('['):
        if not s.endswith(']'): raise ManifestError(f'linha {lineno}: [ sem fechar')
        return [_scalar(x, lineno) for x in _split_flow(s[1:-1], lineno)]
    if s == '{}': return {}
    if s.startswith('{'): raise ManifestError(f'linha {lineno}: mapas em {{ }} não são aceitos; use um bloco indentado')
    if s[0] in '&*!|>%@`': raise ManifestError(f'linha {lineno}: "{s[0]}" não é aceito aqui (use aspas)')
    if s in ('true', 'True', 'TRUE'): return True
    if s in ('false', 'False', 'FALSE'): return False
    if re.fullmatch(r'[-+]?[0-9]+', s): return int(s)
    if re.fullmatch(r'[-+]?([0-9]+\.[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?', s): return float(s)
    if ': ' in s or s.endswith(':'): raise ManifestError(f'linha {lineno}: ":" num texto sem aspas; ponha o texto entre aspas')
    return s


KEY_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_-]*|"[^"]*"|\'[^\']*\')\s*:(\s+(.*))?$')


def parse_yaml(text):
    lines = list(enumerate(text.replace('\r\n', '\n').split('\n'), 1))  # (lineno, raw line)
    for n, l in lines:
        if '\t' in l[:len(l) - len(l.lstrip(' \t'))]: raise ManifestError(f'linha {n}: tabulação na indentação: use espaços')
    pos = [0]

    def peek():
        while pos[0] < len(lines):
            n, l = lines[pos[0]]
            c = _strip_comment(l)
            if c.strip() == '' or c.strip() == '---' and n == 1:
                pos[0] += 1; continue
            return n, len(c) - len(c.lstrip(' ')), c.strip()
        return None

    def block_scalar(style, parent_indent):
        fold, chomp = style[0] == '>', style[1:2]
        body, ind = [], None
        while pos[0] < len(lines):
            n, l = lines[pos[0]]
            if l.strip() == '':
                body.append(''); pos[0] += 1; continue
            i = len(l) - len(l.lstrip(' '))
            if ind is None:
                if i <= parent_indent: break
                ind = i
            if i < ind: break
            body.append(l[ind:]); pos[0] += 1
        while body and body[-1] == '' and chomp != '+': body.pop()
        if not fold: s = '\n'.join(body)
        else:
            paras, cur = [], []
            for b in body:
                if b == '': paras.append(' '.join(cur)); cur = []
                else: cur.append(b.strip())
            paras.append(' '.join(cur))
            s = '\n'.join(paras)
        return s + ('\n' if chomp != '-' and s else '')

    def value_after(rest, n, indent):
        """The value of `key: rest` / `- rest`: a scalar, a block scalar or a nested block (rest empty)."""
        if rest in ('|', '|-', '|+', '>', '>-', '>+'):
            pos[0] += 1; return block_scalar(rest, indent)
        if rest == '':
            pos[0] += 1
            nxt = peek()
            if nxt is None or nxt[1] < indent or (nxt[1] == indent and not nxt[2].startswith('- ') and nxt[2] != '-'):
                return None
            if nxt[1] == indent:  # a list at the same indent as its key (allowed by YAML)
                return parse_block(indent, list_only=True)
            return parse_block(nxt[1])
        pos[0] += 1
        return _scalar(rest, n)

    def parse_block(indent, list_only=False):
        first = peek()
        if first is None: return None
        if first[2] == '-' or first[2].startswith('- '):
            out = []
            while True:
                cur = peek()
                if cur is None or cur[1] < indent: break
                n, i, c = cur
                if i > indent: raise ManifestError(f'linha {n}: indentação inesperada')
                if not (c == '-' or c.startswith('- ')):
                    if list_only: break
                    raise ManifestError(f'linha {n}: esperava um item "- " da lista')
                rest = c[1:].strip()
                if KEY_RE.match(rest):
                    # "- key: value" opens a mapping whose other keys sit at indent + 2
                    sub = i + 2
                    lines[pos[0]] = (n, ' ' * sub + rest)
                    out.append(parse_map(sub))
                else:
                    out.append(value_after(rest, n, i))
            return out
        if list_only: return None
        return parse_map(indent)

    def parse_map(indent):
        out = {}
        while True:
            cur = peek()
            if cur is None or cur[1] < indent: break
            n, i, c = cur
            if i > indent: raise ManifestError(f'linha {n}: indentação inesperada')
            if c == '-' or c.startswith('- '): break
            m = KEY_RE.match(c)
            if not m: raise ManifestError(f'linha {n}: esperava "chave: valor"')
            k = m.group(1)
            if k[0] in '"\'': k = k[1:-1]
            if k in out: raise ManifestError(f'linha {n}: chave repetida "{k}"')
            out[k] = value_after((m.group(3) or '').strip(), n, i)
        return out

    first = peek()
    if first is None: return {}
    if first[1] != 0: raise ManifestError(f'linha {first[0]}: o arquivo começa indentado')
    doc = parse_block(0)
    rest = peek()
    if rest is not None: raise ManifestError(f'linha {rest[0]}: conteúdo fora da estrutura (indentação?)')
    return doc


# ---------- emitting (the draft script writes with this; parse_yaml(dump(x)) == x) ----------
PLAIN_RE = re.compile(r'^[A-Za-zÀ-ÿ0-9_./()@+][^#:\n"]*$')


def _plain_ok(s):
    return bool(PLAIN_RE.match(s)) and s == s.strip() and _scalar(s, 0) == s


def _emit_str(s, indent, width=110):
    """Short plain text as is; long one-line text as a folded block (`>-`, wrapped); the rest in double quotes."""
    if len(s) + indent < width:
        return s if _plain_ok(s) else json.dumps(s, ensure_ascii=False)
    if '\n' in s or '  ' in s or s != s.strip():
        return json.dumps(s, ensure_ascii=False)
    rows, cur = [], ''
    for w in s.split(' '):
        if cur and len(cur) + 1 + len(w) + indent + 2 > width: rows.append(cur); cur = w
        else: cur = f'{cur} {w}' if cur else w
    rows.append(cur)
    pad = ' ' * (indent + 2)
    return '>-\n' + '\n'.join(pad + r for r in rows)


def _emit(x, indent):
    pad = ' ' * indent
    if isinstance(x, dict):
        if not x: return ' {}'
        out = []
        for k, v in x.items():
            if isinstance(v, dict) and v or isinstance(v, list) and any(isinstance(i, (dict, list)) for i in v):
                out.append(f'{pad}{k}:' + ('\n' + _emit(v, indent + 2) if isinstance(v, dict) else '\n' + _emit(v, indent)))
            else:
                out.append(f'{pad}{k}: {_emit_scalar(v, indent)}')
        return '\n'.join(out)
    if isinstance(x, list):
        out = []
        for v in x:
            if isinstance(v, dict) and v:
                body = _emit(v, indent + 2)
                out.append(f'{pad}- ' + body[indent + 2:])
            elif isinstance(v, list) and v:
                raise ManifestError('listas de listas não são aceitas')
            else:
                out.append(f'{pad}- {_emit_scalar(v, indent + 2)}')
        return '\n'.join(out)
    return _emit_scalar(x, indent)


def _emit_scalar(v, indent):
    if v is None: return 'null'
    if v is True: return 'true'
    if v is False: return 'false'
    if isinstance(v, (int, float)): return str(v)
    if isinstance(v, list): return '[' + ', '.join(_emit_scalar(i, indent) for i in v) + ']' if v else '[]'
    if isinstance(v, dict): return '{}'
    return _emit_str(str(v), indent)


def dump(doc):
    return _emit(doc, 0) + '\n'


# ---------- the manifest ----------
def norm_list(v):
    if v is None: return []
    return v if isinstance(v, list) else [v]


def _launch_item_errors(item, where):
    if not isinstance(item, dict): return [where + ': deve ser um mapa (date: AAAA-MM-DD, label: piloto|público)']
    errs = []
    d = item.get('date')
    ok = isinstance(d, str) and DATE_RE.match(d)
    if ok:
        try: datetime.date.fromisoformat(d)
        except ValueError: ok = False
    if not ok: errs.append(where + '.date: data no formato AAAA-MM-DD')
    lb = item.get('label')
    if lb is not None and lb not in LAUNCH_LABELS: errs.append(where + '.label: ' + ' ou '.join(LAUNCH_LABELS) + ' (ou sem rótulo)')
    unknown = set(item) - {'date', 'label'}
    if unknown: errs.append(f'{where}: chaves desconhecidas {sorted(unknown)}')
    return errs


def launch_errors(launch):
    """The `launch` field (optional): one {date, label?} mapping, or a list of them (e.g. piloto and público).
    date is YYYY-MM-DD; label is piloto / público (or none)."""
    if launch is None: return []
    if isinstance(launch, list):
        if not launch: return ['launch: lista vazia']
        errs = []
        for n, item in enumerate(launch, 1): errs += _launch_item_errors(item, f'launch[{n}]')
        dates = [i.get('date') for i in launch if isinstance(i, dict)]
        if len(set(dates)) != len(dates): errs.append('launch: datas repetidas')
        return errs
    return _launch_item_errors(launch, 'launch')


def launches_of(doc):
    """Every valid launch as [{date, label}], earliest first (empty: none or invalid)."""
    l = doc.get('launch')
    if l is None or launch_errors(l): return []
    items = l if isinstance(l, list) else [l]
    return sorted(({'date': i['date'], 'label': i.get('label')} for i in items), key=lambda i: i['date'])


def launch_of(doc):
    """The launch the line orders by: the EARLIEST date (law-os: the piloto, before the público), else None."""
    ls = launches_of(doc)
    return ls[0] if ls else None


def validate(doc):
    """The format's errors (empty: valid)."""
    errs = []
    if not isinstance(doc, dict): return ['o arquivo não é um mapa (chave: valor)']
    if doc.get('version') != 1: errs.append('version: deve ser 1')
    reqs = doc.get('requirements')
    if not isinstance(reqs, list) or not reqs: errs.append('requirements: lista vazia ou ausente'); reqs = []
    ap = doc.get('approval')
    if ap is not None and not isinstance(ap, dict): errs.append('approval: deve ser um mapa (by, at, digest)')
    errs += launch_errors(doc.get('launch'))
    seen = set()
    for n, r in enumerate(reqs, 1):
        where = f'requirements[{n}]'
        if not isinstance(r, dict): errs.append(f'{where}: deve ser um mapa'); continue
        rid = r.get('id')
        if not isinstance(rid, str) or not ID_RE.match(rid): errs.append(f'{where}: id "{rid}" fora do formato (ex.: RF-01)')
        elif rid in seen: errs.append(f'{where}: id repetido {rid}')
        else: seen.add(rid); where = rid
        if not isinstance(r.get('title'), str) or not r['title'].strip(): errs.append(f'{where}: title vazio')
        if not isinstance(r.get('done_when'), str) or not r['done_when'].strip(): errs.append(f'{where}: done_when (pronto quando) vazio')
        w = r.get('weight', 1)
        if isinstance(w, bool) or not isinstance(w, (int, float)) or w <= 0: errs.append(f'{where}: weight deve ser um número > 0')
        for k in ('issues', 'prs'):
            if any(isinstance(x, bool) or not isinstance(x, int) or x <= 0 for x in norm_list(r.get(k))): errs.append(f'{where}: {k} deve ser uma lista de números')
        for k in ('acceptance', 'homolog'):
            for j, c in enumerate(norm_list(r.get(k)), 1):
                e = check_error(c, k)
                if e: errs.append(f'{where}: {k}[{j}]: {e}')
        unknown = set(r) - {'id', 'title', 'done_when', 'weight', 'acceptance', 'homolog', 'issues', 'prs', 'notes', 'source', 'size', 'decision'}
        if unknown: errs.append(f'{where}: chaves desconhecidas {sorted(unknown)}')
    return errs


def check_error(c, kind):
    allowed = ('test', 'ci', 'run') if kind == 'acceptance' else ('url', 'ci', 'run')
    if not isinstance(c, dict): return f'deve ser um mapa ({"/".join(allowed)})'
    bad = [k for k in ('test', 'url') if k in c and k not in allowed]
    if bad: return f'{bad[0]} não vale como evidência de {"aceite" if kind == "acceptance" else "homolog"}'
    if not any(k in c for k in allowed): return f'falta {", ".join(allowed)}'
    if 'ci' in c:
        ci = c['ci']
        if isinstance(ci, str): pass
        elif not isinstance(ci, dict) or not isinstance(ci.get('job'), str): return 'ci: o nome do job (ci: ci) ou {job, step, workflow}'
    if 'url' in c and not (isinstance(c['url'], str) and re.match(r'^(https://|/)', c['url'])): return 'url: https://... ou um caminho /... sobre homolog.base_url'
    if 'test' in c and not isinstance(c['test'], str): return 'test: o caminho do arquivo de teste'
    if 'run' in c and not isinstance(c['run'], str): return 'run: o caminho do registro (JSON) no repo'
    return None


def requirement_key(r):
    return {'id': r.get('id'), 'title': (r.get('title') or '').strip(), 'done_when': ' '.join((r.get('done_when') or '').split()), 'weight': r.get('weight', 1)}


def digest(doc):
    """What the owner approves: the ids, titles, done_when and weights, in order (evidence links can change freely)."""
    keys = [requirement_key(r) for r in doc.get('requirements') or [] if isinstance(r, dict)]
    return hashlib.sha256(json.dumps(keys, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:16]


def approval_state(doc, approvers):
    """(approved, why) — approved only with an approver's name and the digest of the list as it is now."""
    ap = doc.get('approval') if isinstance(doc.get('approval'), dict) else {}
    by, dg = ap.get('by'), ap.get('digest')
    if not by: return False, 'lista ainda não aprovada'
    if approvers and str(by).lower() not in {a.lower() for a in approvers}: return False, f'aprovada por {by}, que não aprova listas de MVP'
    if not dg: return False, 'aprovação sem digest (approval.digest = mvp_manifest.py digest <arquivo>)'
    if dg != digest(doc): return False, 'a lista mudou depois da aprovação (digest diferente): precisa de nova aprovação'
    return True, f'aprovada por {by}' + (f' em {ap.get("at")}' if ap.get('at') else '')


# ---------- the three levels ----------
class Evidence:
    """What the report can check. The real one (projects_report.RepoEvidence) talks to GitHub and homolog; tests pass a
    fake. Every method returns (ok: bool | None, detail: str): None = cannot be checked (sem evidência)."""
    def pr(self, number): return None, 'sem leitor'
    def ci(self, job, step=None, workflow=None): return None, 'sem leitor'
    def file(self, path): return None, 'sem leitor'
    def url(self, url, expect=200, contains=None): return None, 'sem leitor'
    def run(self, path, max_age_days=30, rid=None): return None, 'sem leitor'


def ci_spec(c):
    ci = c.get('ci')
    if isinstance(ci, str): return {'job': ci, 'step': None, 'workflow': None}
    if isinstance(ci, dict): return {'job': ci.get('job'), 'step': ci.get('step'), 'workflow': ci.get('workflow')}
    return None


def safe(fn, *a):
    """An evidence call; a source that does not answer (HTTP error, bad data) is sem evidência, not a crash."""
    try: return fn(*a)
    except (RuntimeError, ValueError, KeyError, TypeError) as e: return None, f'sem evidência: {e}'


class _Safe:
    def __init__(self, ev): self.ev = ev
    def __getattr__(self, name):
        f = getattr(self.ev, name)
        return lambda *a: safe(f, *a)


def eval_check(c, kind, ev, base_url, rid):
    """One acceptance or homolog check -> {'kind', 'ref', 'ok', 'detail'}; ok None = sem evidência."""
    ci = ci_spec(c)
    if 'test' in c:
        ref = c['test'] + (f" :: {c['name']}" if c.get('name') else '')
        if ci is None: return {'kind': 'test', 'ref': ref, 'ok': None, 'detail': 'sem evidência: o teste não diz o job de CI que o roda (ci:)'}
        okf, df = ev.file(c['test'])
        if okf is not True: return {'kind': 'test', 'ref': ref, 'ok': okf, 'detail': df}
        okc, dc = ev.ci(ci['job'], ci['step'], ci['workflow'])
        return {'kind': 'test', 'ref': ref, 'ok': okc, 'detail': f'{df}; {dc}'}
    if ci is not None:
        ref = ci['job'] + (f" / {ci['step']}" if ci['step'] else '')
        ok, d = ev.ci(ci['job'], ci['step'], ci['workflow'])
        return {'kind': 'ci', 'ref': ref, 'ok': ok, 'detail': d}
    if 'url' in c:
        u = c['url']
        if u.startswith('/'):
            if not base_url: return {'kind': 'url', 'ref': u, 'ok': None, 'detail': 'sem evidência: caminho relativo sem homolog.base_url'}
            u = base_url.rstrip('/') + u
        ok, d = ev.url(u, c.get('expect', 200), c.get('contains'))
        return {'kind': 'url', 'ref': u, 'ok': ok, 'detail': d}
    if 'run' in c:
        ok, d = ev.run(c['run'], c.get('max_age_days', 30), rid)
        return {'kind': 'run', 'ref': c['run'], 'ok': ok, 'detail': d}
    return {'kind': '?', 'ref': '', 'ok': None, 'detail': 'sem evidência: check sem tipo'}


def level_of(checks, empty):
    """A level from its checks: True when all are green; None (sem evidência) when there is none or any is unknown and
    none failed; False when one failed."""
    if not checks: return None, empty
    if any(c['ok'] is False for c in checks): return False, next(c['detail'] for c in checks if c['ok'] is False)
    if any(c['ok'] is None for c in checks): return None, next(c['detail'] for c in checks if c['ok'] is None)
    return True, f'{len(checks)} verificação(ões) verdes'


def evaluate(doc, ev, approvers=()):
    """The manifest against the evidence: per requirement the three levels, and the totals (by weight)."""
    ev = _Safe(ev)
    base_url = ((doc.get('homolog') or {}) if isinstance(doc.get('homolog'), dict) else {}).get('base_url')
    reqs, tot = [], {'total': 0, 'weight': 0.0, **{k: 0 for k in LEVELS}, **{k + 'Weight': 0.0 for k in LEVELS}, 'noEvidence': 0}
    for r in doc.get('requirements') or []:
        w = r.get('weight', 1)
        prs = []
        for n in norm_list(r.get('prs')):
            ok, d = ev.pr(n)
            prs.append({'number': n, 'ok': ok, 'detail': d})
        merged = level_of(prs, 'sem evidência: nenhum PR ligado')
        acc = [eval_check(c, 'acceptance', ev, base_url, r['id']) for c in norm_list(r.get('acceptance'))]
        accepted = level_of(acc, 'sem evidência: nenhum teste de aceite ligado')
        hom = [eval_check(c, 'homolog', ev, base_url, r['id']) for c in norm_list(r.get('homolog'))]
        proven = level_of(hom, 'sem evidência: nenhuma verificação em homolog ligada')
        lv = {'merged': merged, 'accepted': accepted, 'proven': proven}
        tot['total'] += 1; tot['weight'] += w
        for k in LEVELS:
            if lv[k][0] is True: tot[k] += 1; tot[k + 'Weight'] += w
        if all(lv[k][0] is None for k in LEVELS): tot['noEvidence'] += 1
        reqs.append({'id': r['id'], 'title': r['title'], 'doneWhen': ' '.join(r['done_when'].split()), 'weight': w,
                     'issues': norm_list(r.get('issues')), 'prs': prs, 'acceptance': acc, 'homolog': hom,
                     'levels': {k: {'ok': lv[k][0], 'detail': lv[k][1]} for k in LEVELS},
                     'status': 'proven' if lv['proven'][0] else 'accepted' if lv['accepted'][0] else 'merged' if lv['merged'][0] else 'open'})
    pct = lambda k: round(100 * tot[k + 'Weight'] / tot['weight']) if tot['weight'] else 0
    approved, why = approval_state(doc, approvers)
    return {'approved': approved, 'approval': why, 'digest': digest(doc), 'launch': launch_of(doc), 'launches': launches_of(doc),
            'levels': {k: {'count': tot[k], 'pct': pct(k)} for k in LEVELS},
            'total': tot['total'], 'weight': tot['weight'], 'noEvidence': tot['noEvidence'],
            'pct': pct('proven') if approved else None, 'requirements': reqs}


def link_prs(doc, linker):
    """Adds to each requirement's prs the PRs linked by its label mvp:<id> (linker(id) -> [numbers]); the list in the file is
    never rewritten, so the % rises with no maintenance commit."""
    for r in doc.get('requirements') or []:
        extra = [n for n in linker(r['id']) if n not in norm_list(r.get('prs'))]
        if extra: r['prs'] = norm_list(r.get('prs')) + extra
    return doc


def load(text):
    doc = parse_yaml(text)
    errs = validate(doc)
    if errs: raise ManifestError('; '.join(errs[:8]) + (f' … e mais {len(errs) - 8}' if len(errs) > 8 else ''))
    return doc


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) != 2 or a[0] not in ('validate', 'digest', 'json'): print(__doc__); sys.exit(64)
    try:
        doc = parse_yaml(open(a[1], encoding='utf-8').read())
    except (OSError, ManifestError) as e:
        print(f'erro: {e}', file=sys.stderr); sys.exit(1)
    if a[0] == 'json': print(json.dumps(doc, ensure_ascii=False, indent=1)); sys.exit(0)
    errs = validate(doc)
    if errs:
        for e in errs: print(f'erro: {e}', file=sys.stderr)
        sys.exit(1)
    print(digest(doc) if a[0] == 'digest' else f"ok: {len(doc['requirements'])} requisitos, digest {digest(doc)}")
