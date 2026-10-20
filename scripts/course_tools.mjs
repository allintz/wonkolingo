// Lint and merge built-in course drafts.
//   node scripts/course_tools.mjs lint <draft.json>...          report problems in unit/course drafts
//   node scripts/course_tools.mjs merge <key> <out.json> <src.json> <draft.json>...
//      key: course prefix letter (e.g. t or a). Assigns stable ids to "new" cards, strips src into a sources file.
import fs from 'fs';
import { validateCourse } from '../src/course-format.js';

const [, , cmd, ...args] = process.argv;
const load = f => { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d.units ? d.units : [d]; };
const DASH = /[–—]/;
const rand = () => Math.random().toString(36).slice(2, 8);
const STRIP = new Set(['src', 'unitIndex']);

function itemsOf(units) { const out = []; units.forEach((u, ui) => (u.lessons || []).forEach((l, li) => (l.items || []).forEach((it, k) => out.push({ u, ui, l, li, it, k })))); return out; }

function lint(files) {
  let problems = 0;
  for (const f of files) {
    const units = load(f), items = itemsOf(units), say = (w, m) => { problems++; console.log(`${f.split('/').pop()} ${w}: ${m}`); };
    // schema check, unit by unit, as a throwaway course
    units.forEach((u, ui) => {
      const clean = JSON.parse(JSON.stringify(u, (k, v) => STRIP.has(k) ? undefined : v));
      (clean.lessons || []).forEach(l => (l.items || []).forEach(it => { if (it.id === 'new' || (it.id && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(it.id))) delete it.id; }));
      const r = validateCourse({ format: 'wonkolingo-course/1', id: 'lint-check', title: 'Lint', units: [clean] });
      r.errors.forEach(e => say(`unit ${ui}`, e));
    });
    const seenP = new Map(), seenId = new Map(); let mcN = 0, longest = 0; const ranks = [0, 0, 0, 0, 0];
    for (const { ui, li, k, it, l } of items) {
      const w = `u${ui} "${l.title}" #${k}`;
      const text = JSON.stringify(it);
      if (DASH.test(text)) say(w, 'contains an em or en dash');
      if (/one or two/i.test(it.p || '')) say(w, '"one or two" in prompt');
      if (it.t === 'recall' && !it.choice) say(w, 'recall card without a choice block');
      const opts = it.t === 'mc' ? it.o : it.choice && it.choice.o, a = it.t === 'mc' ? it.a : it.choice && it.choice.a;
      if (opts && Number.isInteger(a) && opts[a]) {
        const others = opts.filter((_, i) => i !== a).map(o => o.length), mean = others.reduce((x, y) => x + y, 0) / others.length;
        mcN++; if (opts[a].length >= Math.max(...opts.filter((_, i) => i !== a).map(o => o.length))) longest++;
        ranks[Math.min(4, 1 + opts.filter((o, i) => i !== a && o.length > opts[a].length).length)]++;
        if (opts[a].length > 1.6 * mean && opts[a].length - mean > 40) say(w, `right option much longer than the others (${opts[a].length} vs avg ${Math.round(mean)}): likely giveaway`);
        const ow = it.t === 'mc' ? it.ow : it.choice.ow;
        if (!ow) say(w, 'no ow (why-wrong notes) on the choice version');
      }
      if (!it.id) say(w, 'missing id (use "new" for new cards)');
      else if (it.id !== 'new') { if (seenId.has(it.id)) say(w, `duplicate id ${it.id} (also ${seenId.get(it.id)})`); seenId.set(it.id, w); }
      const key = (it.p || it.q || '').toLowerCase().replace(/\W+/g, ' ').trim();
      if (key && seenP.has(key)) say(w, `same prompt as ${seenP.get(key)}`); seenP.set(key, w);
      if (!it.src || !it.src.length) say(w, 'no src');
    }
    const rate = mcN ? longest / mcN : 0;
    if (mcN >= 8 && rate > 0.45) say('file', `right option is the longest in ${longest} of ${mcN} multiple-choice blocks (${Math.round(rate * 100)}%): players can guess by length`);
    // Any length rank (longest, second-longest...) that holds the right answer far more often than chance is a guessable pattern.
    ranks.slice(1).forEach((n, i) => { if (mcN >= 12 && n / mcN > 0.45) say('file', `right option has length rank ${i + 1} in ${n} of ${mcN} blocks (${Math.round(n / mcN * 100)}%): guessable pattern`); });
    console.log(`${f.split('/').pop()}: ${items.length} cards in ${units.length} unit(s), ${units.reduce((n, u) => n + u.lessons.length, 0)} lessons; right option longest in ${longest}/${mcN} choices; rank spread ${ranks.slice(1).join('/')}`);
  }
  console.log(problems ? `${problems} problem(s)` : 'clean');
}

function merge(pre, out, srcOut, files, oldIds) {
  const units = files.flatMap(load), sources = [], used = new Set();
  for (const { ui, li, it } of itemsOf(units)) {
    if (!it.id || it.id === 'new') { let id; do { id = `${pre}u${ui}l${li}#n${rand()}`; } while (used.has(id)); it.id = id; }
    if (used.has(it.id)) throw new Error('duplicate id ' + it.id);
    used.add(it.id);
    sources.push({ id: it.id, q: (it.p || it.q || '').slice(0, 120), src: it.src || [] });
  }
  const clean = JSON.parse(JSON.stringify(units, (k, v) => STRIP.has(k) ? undefined : v));
  fs.writeFileSync(out, JSON.stringify(clean, null, 1));
  fs.writeFileSync(srcOut, JSON.stringify(sources, null, 1));
  const kept = oldIds ? [...used].filter(i => oldIds.has(i)).length : 0;
  console.log(`merged ${used.size} cards into ${clean.length} units; ${kept} kept old ids`);
}

if (cmd === 'lint') lint(args);
else if (cmd === 'merge') { const [pre, out, srcOut, ...files] = args; merge(pre, out, srcOut, files); }
else console.log('usage: lint <files> | merge <pre> <out> <sources-out> <files>');
