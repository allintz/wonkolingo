// Writes docs/content.json: the built-in courses, glossary and card sources from the built page, so the iPhone app can
// pick up course changes without a new App Store build. Run by build.sh after docs/index.html is written.
// Usage: node scripts/build_content.mjs docs/index.html docs/content.json <builtAt>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, out, builtAt] = process.argv;
const html = readFileSync(src, 'utf8');
// The value after "const NAME = " up to the statement's closing bracket, as JSON.
function block(name, open, close) {
  const start = html.indexOf(`\nconst ${name} = ${open}`);
  if (start < 0) throw new Error(`${name} not found`);
  const from = html.indexOf(open, start);
  const end = html.indexOf(`${close};\n`, from);
  return html.slice(from, end + close.length);
}
const unitNames = [...html.matchAll(/\nconst (\w*UNITS) = \[/g)].map(m => m[1]);
const units = Object.fromEntries(unitNames.map(n => [n, JSON.parse(block(n, '[', '\n]'))]));
const glossary = JSON.parse(block('GLOSSARY', '[', ']'));
const sources = JSON.parse(block('CARD_SOURCES', '{', '}'));
// COURSES is a JS object literal naming the unit arrays; evaluate it with those arrays in scope.
const cStart = html.indexOf('const COURSES = Object.assign(Object.create(null), {');
const cFrom = html.indexOf('{', html.indexOf('Object.create(null)', cStart));
const cEnd = html.indexOf('\n});', cFrom);
const courses = new Function(...unitNames, `return (${html.slice(cFrom, cEnd + 2)});`)(...unitNames.map(n => units[n]));
const keep = ['name', 'units', 'pre', 'level', 'created', 'updated', 'description', 'caveat', 'meta', 'keyTerms'];
const data = { builtAt: +builtAt, courses: Object.fromEntries(Object.entries(courses).map(([k, c]) => [k, Object.fromEntries(keep.filter(f => c[f] !== undefined).map(f => [f, c[f]]))])), glossary, sources };
writeFileSync(out, JSON.stringify(data));
console.log(`content.json: ${Object.keys(data.courses).length} courses, ${glossary.length} terms, ${(JSON.stringify(data).length / 1e6).toFixed(2)} MB`);
