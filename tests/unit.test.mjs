import { computeStreak, validateCourse } from '../src/course-format.js';
import { pairStreak } from '../src/social.js';
let f = 0; const t = (c, n, x) => { if (!c) { f++; console.log('FAIL', n, JSON.stringify(x)); } };
const all = [true,true,true,true,true,true,true], wk = [false,true,true,true,true,true,false];
const days = []; for (let d = new Date('2026-09-28T12:00:00Z'); d <= new Date('2026-10-16T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) { const s = d.toISOString().slice(0, 10); if (![0, 6].includes(d.getUTCDay())) days.push(s); }
days.push('2026-10-19');
// weekdays streak Mon 9/28 .. Mon 10/19 = 16 practice days
const w = computeStreak(days, { days: wk, pauses: [] }, '2026-10-19'); t(w.streak === 16, 'weekday streak', w.streak);
// switching to every day today WITHOUT history rewrites the past (old behavior)
const naive = computeStreak(days, { days: all, pauses: [] }, '2026-10-19'); t(naive.streak < 16, 'naive switch breaks (documents old bug)', naive.streak);
// with history it stays intact
const hist = computeStreak(days, { days: all, pauses: [], past: [{ until: '2026-10-18', days: wk }] }, '2026-10-19'); t(hist.streak === 16, 'history keeps streak', hist.streak);
// bad past entries are ignored
t(computeStreak(days, { days: wk, past: [{ until: 'x', days: [] }, null] }, '2026-10-19').streak === 16, 'garbage past ignored');
t(!validateCourse({ format: 'wonkolingo-course/1', id: 'sp', title: 'x', units: [{ title: 'u', lessons: [{ title: 'l', items: [{ t: 'mc', who: 'constructor', q: 'hi', o: ['a', 'b'], a: 0, x: 'x' }, { t: 'recall', p: 'q', answer: 'a', x: 'x' }] }] }] }).ok, 'constructor speaker rejected');
t(validateCourse({ format: 'wonkolingo-course/1', id: 'sp', title: 'x', speakers: { m: { n: 'M' } }, units: [{ title: 'u', lessons: [{ title: 'l', items: [{ t: 'mc', who: 'm', q: 'hi', o: ['a', 'b'], a: 0, x: 'x' }, { t: 'recall', p: 'q', answer: 'a', x: 'x' }] }] }] }).ok, 'real speaker accepted');

// question ids and multiple-choice versions of short-answer cards
const mk = items => ({ format: 'wonkolingo-course/1', id: 'vt', title: 'V', units: [{ title: 'u', lessons: [{ title: 'l', items }] }] });
const rc = extra => ({ t: 'recall', p: 'q', answer: 'a', x: 'x', ...extra });
t(validateCourse(mk([rc({ id: 'q-1', choice: { p: 'mc?', o: ['a', 'b', 'c'], a: 1, ow: ['x', '', 'y'] } }), rc({ id: 'q-2' })])).ok, 'ids and choice accepted');
t(validateCourse(mk([rc({ id: 'q-1', choice: { o: ['a', 'b'], a: 0 } }), rc({})])).course.units[0].lessons[0].items[0].choice.o.length === 2, 'choice kept in output');
t(!validateCourse(mk([rc({ id: 'same' }), rc({ id: 'same' })])).ok, 'duplicate ids rejected');
t(!validateCourse(mk([rc({ id: 'Bad ID' }), rc({})])).ok, 'bad id rejected');
t(!validateCourse(mk([rc({ choice: { o: ['a', 'b'], a: 5 } }), rc({})])).ok, 'choice.a out of range rejected');
t(!validateCourse(mk([rc({ choice: ['a'] }), rc({})])).ok, 'choice array rejected');
t(!validateCourse(mk([rc({ choice: { o: ['a', 'b'], a: 0, ow: [''] } }), rc({})])).ok, 'choice.ow wrong length rejected');

// Retention (10/21): bought freezes, repairs, kept days, friend streaks.
const run_ = (from, to, skip = []) => { const out = []; for (let d = new Date(from + 'T12:00:00Z'); d <= new Date(to + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) { const s = d.toISOString().slice(0, 10); if (!skip.includes(s)) out.push(s); } return out; };
const ten = run_('2026-10-01', '2026-10-10');
// a 10-day streak earns freezes, so a missed 10/11 is frozen, not broken, and no repair is offered
const br = computeStreak(ten.concat('2026-10-12'), { days: all }, '2026-10-12');
t(br.streak === 11 && br.frozen.join() === '2026-10-11' && !br.repair, 'earned freeze covers a miss', br);
const four = run_('2026-10-07', '2026-10-10');
const br2 = computeStreak(four.concat('2026-10-12'), { days: all }, '2026-10-12');
t(br2.streak === 1 && br2.repair && br2.repair.days.join() === '2026-10-11' && br2.repair.lost === 4 && br2.repair.cost === 0, 'earn-back offered after a break (no freezes)', br2);
const fixed = computeStreak(four.concat('2026-10-12'), { days: all, repaired: ['2026-10-11'] }, '2026-10-12');
t(fixed.streak === 5 && !fixed.repair && fixed.spent === 0, 'earn-back restores the streak for free', fixed);
t(!computeStreak(four, { days: all }, '2026-10-15').repair, 'no repair after the window or for 4+ missed days');
// a bought freeze covers a later missed day; it counts as spent
const bf = computeStreak(four.concat('2026-10-12'), { days: all, bought: ['2026-10-09'] }, '2026-10-12');
t(bf.streak === 5 && bf.frozen.join() === '2026-10-11' && bf.spent === 100, 'bought freeze covers a miss', bf);
t(computeStreak(four, { days: all, bought: ['2026-10-08', '2026-10-08', '2026-10-08', '2026-10-08', '2026-10-08'] }, '2026-10-10').freezes === 3, 'bought freezes capped at 3');
t(computeStreak(four, { days: all, bought: ['junk', 5] }, '2026-10-10').spent === 0, 'junk bought entries ignored');
t(br.kept.includes('2026-10-11') && fixed.kept.includes('2026-10-11') && !br2.kept.includes('2026-10-11'), 'kept days include frozen and repaired days only');
// friend streaks
const P = (days, settings, today) => { const st = computeStreak(days, settings, today); return { practiced: new Set(days), kept: new Set(st.kept) }; };
const A = P(run_('2026-10-01', '2026-10-12'), { days: all }, '2026-10-12'), B = P(run_('2026-10-01', '2026-10-11'), { days: all }, '2026-10-12');
let ps = pairStreak(A, B, '2026-10-05', '2026-10-12'); t(ps.count === 7 && ps.aDone && !ps.bDone, 'friend streak waits on B today', ps);
const B2 = P(run_('2026-10-01', '2026-10-12'), { days: all }, '2026-10-12');
ps = pairStreak(A, B2, '2026-10-05', '2026-10-12'); t(ps.count === 8, 'both done today adds one', ps);
// B misses 10/08 with no freeze (started 10/06) -> resets, then counts 10/09..10/12
const B3 = P(run_('2026-10-06', '2026-10-12', ['2026-10-08']), { days: all }, '2026-10-12');
ps = pairStreak(A, B3, '2026-10-06', '2026-10-12'); t(ps.count === 4 && ps.best === 4, 'friend streak resets on a plain miss', ps);
// B's weekend off day holds the friend streak without adding
const B4 = P(run_('2026-10-05', '2026-10-12', ['2026-10-10', '2026-10-11']), { days: wk }, '2026-10-12');
ps = pairStreak(A, B4, '2026-10-05', '2026-10-12'); t(ps.count === 6, 'off days hold a friend streak', ps);
console.log(f ? f + ' failures' : 'unit tests pass');
