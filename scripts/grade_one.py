# Calibration harness: grade one typed answer with the live grader prompt (src/grade.js) and the real scorePercent.
# Runs the model through the `claude` CLI, so it needs a logged-in CLI or CLAUDE_CODE_OAUTH_TOKEN (source ~/.config/weekly-brief/secrets.env).
# Usage: python3 scripts/grade_one.py "<card prompt prefix>" "<answer>" [model] [course json] [effort]
# Or:    python3 scripts/grade_one.py --calibration [model] [runs]   (runs every case in scripts/calibration.json)
import json, re, subprocess, sys, os, concurrent.futures as cf
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VAULT_COURSES = os.path.expanduser('~/Documents/Obsidian Vault/05_Reference/WonkoLingo/courses')
src = open(os.path.join(ROOT, 'src/grade.js')).read()
SYSTEM = re.search(r"const SYSTEM = `(.*?)`;", src, re.S).group(1)
OPEN = re.search(r"const OPEN_NOTE = `(.*?)`;", src, re.S).group(1)
SHAPE = '\nReply with only JSON: {"asked": int, "points": [{"said": str, "verdict": "right|partly|wrong|unsure", "precision": "precise|minor_issue|imprecise", "note": str}], "missed": [str], "feedback": str}'

def find_card(prefix, course_path):
    c = json.load(open(course_path))
    return next(x for u in c['units'] for l in u['lessons'] for x in l['items'] if x.get('p', '').startswith(prefix))

def grade(prefix, response, model='claude-sonnet-5-5', course_path=None, effort='medium'):
    it = find_card(prefix, course_path or os.path.join(VAULT_COURSES, 'ai-policy-options.json'))
    ans = it.get('answer') or it['o'][it['a']]
    keys = '\n'.join('- ' + k for k in it.get('keys', [])) or '(none)'
    content = f"<question>{it['p']}</question>\n<model_answer>{ans}</model_answer>\n<key_points>\n{keys}\n</key_points>\n<explanation>{it['x']}</explanation>\n<learner_answer>{response}</learner_answer>"
    raw = subprocess.run(['claude', '-p', '--model', model, '--effort', effort, '--system-prompt', SYSTEM + ('\n' + OPEN if it.get('open') else '') + SHAPE, content], capture_output=True, text=True).stdout
    o = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])
    pts = [{'said': p['said'], 'verdict': p['verdict'], 'precision': p.get('precision', 'precise'), 'note': p['note']} for p in o['points']]
    pct = int(subprocess.run(['node', '--input-type=module', '-e', f"import {{ scorePercent }} from '{ROOT}/src/grade.js'; console.log(scorePercent({json.dumps({'asked': o['asked']})}, {json.dumps(pts)}))"], capture_output=True, text=True).stdout.strip())
    return pct, o, pts, ans

if __name__ == '__main__':
    if sys.argv[1] == '--calibration':
        model = sys.argv[2] if len(sys.argv) > 2 else 'claude-sonnet-5-5'
        runs = int(sys.argv[3]) if len(sys.argv) > 3 else 2
        cases = json.load(open(os.path.join(ROOT, 'scripts/calibration.json')))
        jobs = [(c, r) for c in cases for r in range(runs)]
        with cf.ThreadPoolExecutor(6) as ex:
            res = list(ex.map(lambda j: (j[0], grade(j[0]['card'], j[0]['response'], model)[0]), jobs))
        for c in cases:
            got = [p for cc, p in res if cc is c]
            lo, hi = c['target']
            flag = 'ok ' if all(lo <= g <= hi for g in got) else 'OFF'
            print(f"{flag} target {lo}-{hi}  got {got}  | {c['card'][:60]}")
    else:
        pct, o, pts, ans = grade(*sys.argv[1:3], *(sys.argv[3:4] or ['claude-sonnet-5-5']), *(sys.argv[4:5] or [None]), *(sys.argv[5:6] or ['medium']))
        print(f"SCORE {pct}%  (asked={o['asked']})\n{o['feedback']}")
        for p in pts: print(f"- [{p['verdict']}/{p['precision']}] {p['said']}: {p['note']}")
        if o['missed']: print('Also worth knowing:', '; '.join(o['missed']))
        print('MODEL ANSWER:', ans)
