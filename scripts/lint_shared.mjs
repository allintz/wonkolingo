// Cross-course identity checks complement validateCourse's per-course schema checks.
import fs from 'node:fs';
const data=JSON.parse(fs.readFileSync(process.argv[2]||'docs/content-v2.json','utf8'));
const cards=new Map(), errors=[];
for(const [k,c] of Object.entries(data.courses)) for(const u of c.units) for(const l of u.lessons) for(const it of l.items) {
 if(!it.id){errors.push(`${k}: missing stable card id`);continue;}
 if(cards.has(it.id))errors.push(`duplicate id ${it.id}`);else cards.set(it.id,it);
 const d=it.dup;if(d!==undefined&&!(typeof d==='string'||Array.isArray(d)&&d.every(x=>typeof x==='string')))errors.push(`${it.id}: invalid dup`);
}
const edges=new Map([...cards].map(([id,it])=>[id,typeof it.dup==='string'?[it.dup]:it.dup||[]]));
for(const [id,targets] of edges)for(const t of targets)if(!cards.has(t))errors.push(`${id}: dangling dup ${t}`);
const done=new Set();
function visit(id,path){if(path.has(id)){errors.push(`cyclic dup ${[...path,id].join(' -> ')}`);return;}if(done.has(id))return;const next=new Set([...path,id]);for(const t of edges.get(id)||[])if(cards.has(t))visit(t,next);done.add(id);}
for(const id of cards.keys())visit(id,new Set());
for(const [k,c] of Object.entries(data.courses))for(const id of c.basics||[])if(!cards.has(id))errors.push(`${k}: dangling Basics card ${id}`);
for(const [a,b] of Object.entries(data.aliases||{}))if(!cards.has(b))errors.push(`${a}: dangling history alias ${b}`);
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log(`shared-card lint: ${cards.size} unique ids, no dangling links or cycles`);
