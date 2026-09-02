#!/usr/bin/env python3
"""
build.py — resolves dashboard.html's @@ASSET_NNN@@ placeholders from assets.json
and writes index.html. This is the ENTIRE build: no other transform runs.

Deploy ritual (r494-era, per Mike): edit/upload dashboard.html at repo root.
GitHub Actions (build.yml) runs this on every push that touches dashboard.html,
assets.json, or build.py, and commits the result as index.html. index.html is
never hand-edited again.

Exits non-zero on ANY of:
  - a placeholder present in dashboard.html with no matching key in assets.json
    (an unresolved @@ASSET_NNN@@ would ship broken images to the live wall)
  - a key in assets.json that no placeholder in dashboard.html references
    (silent drift — a stale or renamed asset nobody would ever notice)
A failed build.py FAILS the Action, which means index.html is NOT committed —
the site keeps serving whatever built successfully last. This is deliberate:
a broken build must never reach the wall silently.
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / 'dashboard.html'
ASSETS = ROOT / 'assets.json'
OUT = ROOT / 'index.html'
PLACEHOLDER_RE = re.compile(r'@@ASSET_(\d+)@@')

def fail(msg):
    print(f'BUILD FAILED: {msg}', file=sys.stderr)
    sys.exit(1)

def main():
    if not SRC.exists():
        fail(f'{SRC.name} not found at repo root')
    if not ASSETS.exists():
        fail(f'{ASSETS.name} not found at repo root')

    src = SRC.read_text(encoding='utf-8')
    try:
        assets = json.loads(ASSETS.read_text(encoding='utf-8'))
    except json.JSONDecodeError as e:
        fail(f'{ASSETS.name} is not valid JSON: {e}')

    if not isinstance(assets, dict):
        fail(f'{ASSETS.name} must be a JSON object of ASSET_NNN -> data URI')

    used = set(m.group(1) for m in PLACEHOLDER_RE.finditer(src))
    have = set(k.replace('ASSET_', '') for k in assets.keys())

    unresolved = used - have
    if unresolved:
        fail('unresolved placeholders (no matching key in assets.json): '
             + ', '.join(f'@@ASSET_{n}@@' for n in sorted(unresolved)))

    unused = have - used
    if unused:
        fail('assets.json has entries no placeholder references (stale/renamed asset): '
             + ', '.join(f'ASSET_{n}' for n in sorted(unused)))

    def resolve(m):
        return assets[f'ASSET_{m.group(1)}']

    out = PLACEHOLDER_RE.sub(resolve, src)

    # sanity: the resolved output must contain zero placeholder syntax left over
    # (a malformed key like "ASSET_07" vs "ASSET_007" would otherwise ship silently)
    leftover = PLACEHOLDER_RE.findall(out)
    if leftover:
        fail('placeholder syntax survived substitution (numbering mismatch?): '
             + ', '.join(sorted(set(leftover))))

    OUT.write_text(out, encoding='utf-8')
    marker = re.search(r"const BUILD_MARKER = '([^']+)'", out)
    print(f'OK: wrote {OUT.name} ({len(out):,} bytes), '
          f'{len(used)} placeholders resolved, marker={marker.group(1) if marker else "NOT FOUND"}')

if __name__ == '__main__':
    main()
