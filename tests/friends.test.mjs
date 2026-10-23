// Friends integration tests. Only isolated local databases may be used.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const BASE=process.argv[2]||'http://127.0.0.1:8817';
assert(['localhost','127.0.0.1'].includes(new URL(BASE).hostname));
const tag=randomBytes(5).toString('hex'),IP=`10.83.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
let count=0;const ok=(v,msg)=>{assert(v,msg);count++;};
async function call(path,p,b,status=200){const r=await fetch(BASE+path,{method:b===undefined?'GET':'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':IP,...(p?{Authorization:'Bearer '+p.token}:{})},body:b===undefined?undefined:JSON.stringify(b)});const d=await r.json();assert.equal(r.status,status,path+' '+JSON.stringify(d));return d;}
const today=new Date().toISOString().slice(0,10),day=n=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const board=p=>call('/api/friends',p),post=(path,p,b,s)=>call(path,p,b,s);
const A=await post('/api/account',null,{name:'Friend Alpha',username:'alpha'+tag,password:'testingpass123'}),B=await post('/api/account',null,{name:'Friend Beta',username:'beta'+tag,password:'testingpass123'}),C=await post('/api/account',null,{name:'Friend Gamma'}),E=await post('/api/account',null,{name:'Private Email',username:'private'+tag+'@example.com',password:'testingpass123'});
await call('/api/friends',null,undefined,401);
ok((await board(A)).players.length===1,'new account has no automatic friends');await board(B);
ok(!(await board(E)).profile.handle,'email login stays private');
await post('/api/friends/username',C,{username:'gamma'+tag});
await post('/api/friends/username',A,{username:'gamma'+tag},409);
await post('/api/account',null,{name:'Conflict',username:'gamma'+tag,password:'testingpass123'},409);
const search=await call('/api/friends/search?q=beta'+tag,A);
ok(search.people.length===1&&search.people[0].id===B.player.id,'find username across private home groups');
ok(!('email'in search.people[0])&&!('total'in search.people[0]),'search shares identity only');
await post('/api/friends/request',A,{to:B.player.id});
let b=await board(B);ok(b.players.length===1&&b.requests[0].mine===false,'pending request shares no activity');
await post('/api/friends/accept',A,{to:B.player.id},400);await post('/api/friends/accept',B,{to:A.player.id});
b=await board(A);ok(b.players.length===2&&!b.players.some(x=>x.id===C.player.id),'mutual accepted friends only');
await post('/api/friend/request',A,{to:B.player.id,today});await post('/api/friend/accept',B,{to:A.player.id,today});
const state=n=>({state:{srs:{},activeDays:Array.from({length:n},(_,i)=>day(-i)),settings:{days:[true,true,true,true,true,true,true],pauses:[]}}});
await post('/api/state',A,state(1));await post('/api/state',B,state(1));
b=await board(A);ok(b.friends[0].count===1,'cross-group friend streak counts both practices');
await post('/api/complete',B,{lessonId:'review-friends-'+tag,reviewed:3,xp:30,acc:100,day:today});
b=await board(A);ok(b.feed.some(x=>x.id===B.player.id)&&!('acc'in b.feed[0]),'friend activity excludes answers and accuracy');
await post('/api/friends/mute',A,{to:B.player.id,muted:true});b=await board(A);ok(!b.feed.length&&b.friends.length===1,'muting hides activity and keeps streak');await post('/api/friends/mute',A,{to:B.player.id,muted:false});
await post('/api/friends/settings',A,{requests:true,streaks:true,milestones:false});ok((await board(A)).prefs.milestones===0,'milestone push opt-in default preserved');
const course=JSON.parse(readFileSync('example-course.json'));course.id='friends-'+tag;course.title='Private test course';
await post('/api/courses',A,{course,personal:true});
ok(!(await call('/api/courses',B)).courses.some(c=>c.slug===course.id),'friends do not automatically receive private courses');
const link=await post('/api/course-share',A,{slug:course.id});
ok((await call('/api/course-share?token='+link.token,B)).course.id===course.id,'explicit course link works outside groups');
await post('/api/course-share',B,{slug:course.id},403);
if(process.env.FRIENDS_TEST_DB){
 const [a,z]=[A.player.id,B.player.id].sort();const q=s=>"'"+s.replaceAll("'","''")+"'";
 async function streak(n){execFileSync('wrangler',['d1','execute','DB','--local','--persist-to',process.env.FRIENDS_TEST_DB,'--command',`UPDATE friend_streaks SET started=${q(day(1-n))} WHERE a=${q(a)} AND b=${q(z)}`],{stdio:'pipe'});await post('/api/state',A,state(n));await post('/api/state',B,state(n));return board(A);}
 b=await streak(7);ok(b.rewardXP===50&&(await board(B)).rewardXP===50,'seven days awards both partners 50 XP');
 const parallel=await Promise.all(Array.from({length:5},()=>board(A)));ok(parallel.every(x=>x.rewardXP===50),'concurrent refresh cannot award twice');
 b=await streak(30);ok(b.rewardXP===200&&b.profile.badges.includes(30),'30-day shared badge plus four weekly rewards');
 b=await streak(100);ok(b.rewardXP===700&&b.profile.badges.join(',')==='30,100','100-day badge and weekly rewards');
 b=await streak(7);ok(b.rewardXP===700&&b.profile.badges.length===2,'reset preserves badges and cannot farm milestones');
 await post('/api/friends/remove',A,{to:B.player.id});b=await board(A);ok(b.players.length===1&&!b.friends.length&&b.rewardXP===700,'remove ends pair and preserves earned rewards');
 await post('/api/friends/request',A,{to:B.player.id});await post('/api/friends/accept',B,{to:A.player.id});
}
if(process.env.FRIENDS_TEST_DB){
 const M=await post('/api/groups',null,{groupName:'Legacy '+tag,name:'Legacy One'}),N=await post('/api/join',null,{code:M.code,name:'Legacy Two'}),P=await post('/api/join',null,{code:M.code,name:'Legacy Three'});
 await post('/api/friend/request',M,{to:N.player.id,today});await post('/api/friend/accept',N,{to:M.player.id,today});
 await post('/api/state',M,state(1));await post('/api/state',N,state(1));
 const oldCourse={...course,id:'legacy-'+tag};await post('/api/courses',M,{course:oldCourse});
 execFileSync('wrangler',['d1','execute','DB','--local','--persist-to',process.env.FRIENDS_TEST_DB,'--file','migrations/2026-10-23-friends.sql'],{stdio:'pipe'});
 const migrated=await board(M);ok(migrated.players.some(x=>x.id===N.player.id)&&!migrated.players.some(x=>x.id===P.player.id),'migration keeps accepted streak partner without automatically adding group members');
 ok(migrated.friends[0].count===1&&migrated.suggestions.some(x=>x.id===P.player.id),'migration keeps streak history and offers old group suggestions');
 ok((await call('/api/courses',N)).courses.some(x=>x.slug===oldCourse.id),'migration keeps legacy course access and ids');
 for(const p of[M,N,P])await post('/api/account/delete',p,{});
}
await post('/api/block',A,{playerId:B.player.id});
ok(!(await call('/api/friends/search?q=beta'+tag,A)).people.length&&!(await call('/api/friends/search?q=alpha'+tag,B)).people.length,'block hides both people from search');
await post('/api/friends/request',B,{to:A.player.id},404);await call('/api/course-share?token='+link.token,B,undefined,404);
for(const p of[A,B,C,E])await post('/api/account/delete',p,{});
console.log('PASS '+count+' Friends assertions, including rewards, privacy, requests and sharing');
