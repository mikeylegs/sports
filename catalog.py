#!/usr/bin/env python3
"""
catalog.py — rebuilds team-catalog.json's `aka` field (squad names, for the selector's
player search) for all 286 clubs, then commits the result if anything changed.

Runs server-side (GitHub Actions), which is why this is simpler than the browser-console
harvests it replaces: ESPN's CORS block only applies to browser fetches, so this script
hits the same endpoints directly with `requests`, no proxy, no browser needed.

Three sources, same strategy proven manually across catalog r497-r499 this session:
  1. Pro leagues (mlb/nba/nfl/nhl): /teams/{abbr}/roster — ACTIVE roster by abbreviation.
  2. Soccer: roster wants the numeric team id, not abbr (site abbr -> 400; site id -> 200).
     Resolved via the CORE api's team list (per-league, current season falling back one year).
  3. Injuries, pro leagues only: /injuries — the missing half of the active roster (this is
     what makes Aaron Judge findable while he's on the IL). APPENDED + de-duped, never a
     blind replace, because an injuries payload can list players who are also active
     (NFL questionable/probable) — counted twice would be a real regression, not cosmetic.

MERGE-ON-WRITE, deliberately conservative: a club's `aka` is only ever REPLACED with a
non-empty result. A single bad response (network blip, ESPN 500, a route that 400s for one
club) leaves that club's EXISTING aka untouched rather than wiping it to empty — the r497/98
finding was that a hole here is a silent, hard-to-notice regression (a star player stops
being findable with no error anywhere), so the failure mode is "stale" not "gone".

Exits 0 always (a partial harvest is not a build failure — this is data refresh, not a
resolver); prints a per-league summary either way so a bad run is visible in the Action log.
"""
import json, re, sys, time, pathlib, urllib.request, urllib.error

ROOT = pathlib.Path(__file__).resolve().parent
CATALOG = ROOT / 'team-catalog.json'
D = ' · '   # ' · ' — the delimiter selector-r166's _akaHits splits on
TIMEOUT = 12
RETRIES = 2
SLEEP = 0.05

PRO_LEAGUES = {'baseball/mlb', 'basketball/nba', 'football/nfl', 'hockey/nhl'}
SOCCER_LEAGUES = {'soccer/eng.1','soccer/esp.1','soccer/ita.1','soccer/ger.1',
                   'soccer/fra.1','soccer/uefa.champions','soccer/usa.1'}
SITE = 'https://site.api.espn.com/apis/site/v2/sports'
CORE = 'https://sports.core.api.espn.com/v2/sports'
UA = {'User-Agent': 'sports-console-catalog-bot/1'}

def fold(s):
    import unicodedata
    s = unicodedata.normalize('NFD', s or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return s.lower().strip()

def getjson(url):
    for attempt in range(RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                if r.status != 200:
                    raise urllib.error.HTTPError(url, r.status, 'non-200', None, None)
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            if attempt == RETRIES:
                return None
            time.sleep(SLEEP * (attempt + 1))
    return None

def names_from_roster(d):
    out = []
    for g in (d or {}).get('athletes') or []:
        items = g.get('items') if isinstance(g, dict) and 'items' in g else [g]
        for a in items or []:
            if not a:
                continue
            n = a.get('fullName') or a.get('displayName')
            if n and n.strip():
                out.append(n.strip())
    seen, uniq = set(), []
    for n in out:
        k = fold(n)
        if k in seen:
            continue
        seen.add(k); uniq.append(n)
    return uniq

def harvest_pro_roster(league, abbr):
    d = getjson(f'{SITE}/{league}/teams/{abbr}/roster')
    return names_from_roster(d)

def harvest_soccer_ids(slug):
    """abbr/name -> numeric team id, via the core API team list. Tries current season,
    falls back one year (matches the r498 harvest — a season not yet populated in August
    falls back cleanly rather than returning nothing)."""
    import datetime
    year = datetime.datetime.utcnow().year
    idx = {}
    for yr in (year, year - 1):
        d = getjson(f'{CORE}/soccer/leagues/{slug}/seasons/{yr}/teams?limit=100')
        items = (d or {}).get('items') or []
        if not items:
            continue
        for it in items:
            ref = it.get('$ref')
            if not ref:
                continue
            t = getjson(ref)
            if not t:
                continue
            for key in (t.get('abbreviation'), t.get('displayName'), t.get('shortDisplayName')):
                if key:
                    idx[fold(key)] = t.get('id')
            time.sleep(SLEEP)
        if idx:
            break
    return idx

def harvest_pro_injuries(league):
    """league -> {team displayName (folded): [names]}"""
    d = getjson(f'{SITE}/{league}/injuries')
    out = {}
    for t in (d or {}).get('injuries') or []:
        names = []
        for inj in t.get('injuries') or []:
            a = inj.get('athlete') or {}
            n = a.get('fullName') or a.get('displayName')
            if n:
                names.append(n.strip())
        if names:
            out[fold(t.get('displayName', ''))] = names
    return out

def merge_aka(existing, fresh):
    """APPEND fresh names not already present (case-insensitive); never shrink; never
    replace with empty. Returns (new_aka_string, added_count)."""
    cur = [x.strip() for x in (existing or '').split(D) if x.strip()]
    seen = {fold(x) for x in cur}
    added = 0
    for n in fresh:
        k = fold(n)
        if k in seen:
            continue
        seen.add(k); cur.append(n); added += 1
    return D.join(cur), added

def replace_aka(existing, fresh):
    """REPLACE with a de-duped fresh list, but only if fresh is non-empty — an empty
    result from a bad response must never wipe a good existing aka."""
    if not fresh:
        return existing, 0
    seen, out = set(), []
    for n in fresh:
        k = fold(n)
        if k in seen:
            continue
        seen.add(k); out.append(n)
    return D.join(out), len(out)

def main():
    if not CATALOG.exists():
        print('BUILD FAILED: team-catalog.json not found', file=sys.stderr)
        sys.exit(1)
    cat = json.loads(CATALOG.read_text(encoding='utf-8'))
    by_league = {}
    for t in cat:
        by_league.setdefault(t['league'], []).append(t)

    stats = {}

    # ── pro leagues: roster (replace) then injuries (append) ───────────────────
    for league in sorted(PRO_LEAGUES & set(by_league)):
        s = stats[league] = {'roster_ok': 0, 'roster_fail': 0, 'injury_teams': 0, 'injury_added': 0}
        for t in by_league[league]:
            names = harvest_pro_roster(league, t['abbr'])
            new_aka, n = replace_aka(t.get('aka'), names)
            if n:
                t['aka'] = new_aka; s['roster_ok'] += 1
            else:
                s['roster_fail'] += 1
            time.sleep(SLEEP)
        inj = harvest_pro_injuries(league)
        s['injury_teams'] = len(inj)
        for t in by_league[league]:
            hit = inj.get(fold(t['name']))
            if hit is None:
                # loose match: injuries payload's displayName vs catalog name can differ slightly
                hit = next((v for k, v in inj.items() if fold(t['name']) in k or k in fold(t['name'])), None)
            if not hit:
                continue
            new_aka, added = merge_aka(t.get('aka'), hit)
            if added:
                t['aka'] = new_aka; s['injury_added'] += added

    # ── soccer: resolve ids per league, then roster by id (replace) ────────────
    for league in sorted(SOCCER_LEAGUES & set(by_league)):
        slug = league.split('/')[1]
        s = stats[league] = {'ids_resolved': 0, 'roster_ok': 0, 'roster_fail': 0}
        idx = harvest_soccer_ids(slug)
        for t in by_league[league]:
            team_id = idx.get(fold(t['abbr'])) or idx.get(fold(t['name']))
            if not team_id:
                s['roster_fail'] += 1
                continue
            s['ids_resolved'] += 1
            d = getjson(f'{SITE}/{league}/teams/{team_id}/roster')
            names = names_from_roster(d)
            new_aka, n = replace_aka(t.get('aka'), names)
            if n:
                t['aka'] = new_aka; s['roster_ok'] += 1
            else:
                s['roster_fail'] += 1
            time.sleep(SLEEP)

    for lg, s in stats.items():
        print(lg, json.dumps(s))
    no_aka = [f"{t['league']}|{t['abbr']}" for t in cat if not t.get('aka')]
    print('clubs with NO aka at all:', no_aka or '(none)')

    CATALOG.write_text(json.dumps(cat, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {CATALOG.name}, {len(cat)} entries')

if __name__ == '__main__':
    main()
