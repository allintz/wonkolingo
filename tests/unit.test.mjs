import { computeStreak, validateCourse } from '../src/course-format.js';
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
console.log(f ? f + ' failures' : 'unit tests pass');
