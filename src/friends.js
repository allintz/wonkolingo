// Account-to-account friendships. Groups remain only for compatible course access and older app versions.
import { takeRate, createHomeGroup } from './accounts.js';
import { computeStreak } from './course-format.js';
import { pairStreak } from './social.js';
import { pushTo } from './push.js';

const pair = (a,b) => a < b ? [a,b] : [b,a];
const shift = (d,n) => {const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
export async function isFriend(env,a,b) {
  const [x,y]=pair(a,b);
  return !!await env.DB.prepare("SELECT 1 FROM friendships WHERE a=? AND b=? AND status='accepted' AND NOT EXISTS(SELECT 1 FROM blocks WHERE (player_id=? AND blocked_id=?) OR (player_id=? AND blocked_id=?))").bind(x,y,a,b,b,a).first();
}
export async function ensureHandle(env,id) {
  let row=await env.DB.prepare('SELECT handle FROM friend_handles WHERE player_id=?').bind(id).first();
  if(!row){const p=await env.DB.prepare('SELECT username FROM passwords WHERE player_id=?').bind(id).first();
    if(p && !p.username.includes('@')) {await env.DB.prepare('INSERT OR IGNORE INTO friend_handles(player_id,handle) VALUES(?,?)').bind(id,p.username).run();row=await env.DB.prepare('SELECT handle FROM friend_handles WHERE player_id=?').bind(id).first()}}
  return row?.handle || null;
}
async function blocked(env,a,b){return !!await env.DB.prepare('SELECT 1 FROM blocks WHERE (player_id=? AND blocked_id=?) OR (player_id=? AND blocked_id=?)').bind(a,b,b,a).first()}
export async function friendNotice(env,to,from,kind,ref='') {
  // The durable claim (reward or request) decides whether this is called, so retries cannot send duplicate rewards.
  await env.DB.prepare('INSERT INTO notes(player_id,from_id,kind,ref,created_at,seen) VALUES(?,?,?,?,?,0)').bind(to,from.id,kind,ref,Date.now()).run();
  const prefs=await env.DB.prepare('SELECT requests,streaks,milestones FROM friend_preferences WHERE player_id=?').bind(to).first();
  const texts={friend_request:`${from.name} sent you a friend request.`,friend_accept:`${from.name} accepted your friend request.`,friend_reward:`You and ${from.name} earned 50 XP each for your friend streak.`,friend_badge:`You and ${from.name} earned a ${ref}-day friend streak badge.`,both_done:`You and ${from.name} both practiced today.`};
  const enabled=/^friend_(request|accept)$/.test(kind)?prefs?.requests!==0:kind==='friend_badge'?prefs?.milestones===1:false;
  if(enabled)await pushTo(env,to,{title:'WonkoLingo',body:texts[kind]||'A friend has an update.',kind});
}
async function people(env,ids,today) {
  if(!ids.length)return new Map();
  if(ids.length>40){const out=new Map();for(let i=0;i<ids.length;i+=40)for(const [k,v]of await people(env,ids.slice(i,i+40),today))out.set(k,v);return out;}
  const marks=ids.map(()=>'?').join(',');
  const [ps,states,cs,awards]=await env.DB.batch([
    env.DB.prepare(`SELECT p.id,p.name,h.handle FROM players p LEFT JOIN friend_handles h ON h.player_id=p.id WHERE p.id IN (${marks})`).bind(...ids),
    env.DB.prepare(`SELECT player_id,json FROM player_state WHERE player_id IN (${marks})`).bind(...ids),
    env.DB.prepare(`SELECT player_id,day,xp,created_at FROM completions WHERE player_id IN (${marks})`).bind(...ids),
    env.DB.prepare(`SELECT player_id,kind,milestone,xp,day,created_at FROM friend_rewards WHERE player_id IN (${marks})`).bind(...ids)
  ]);
  const st=new Map(states.results.map(r=>{try{return[r.player_id,JSON.parse(r.json)]}catch{return[r.player_id,{}]}}));
  // Match the existing weekly XP calendar, Monday 00:00 UTC.
  const now=new Date();now.setUTCHours(0,0,0,0);now.setUTCDate(now.getUTCDate()-(now.getUTCDay()+6)%7);const week=now.getTime();
  const out=new Map();
  for(const p of ps.results){const s=st.get(p.id)||{},c=cs.results.filter(x=>x.player_id===p.id),r=awards.results.filter(x=>x.player_id===p.id);
    const days=[...new Set([...(Array.isArray(s.activeDays)?s.activeDays:[]),...c.map(x=>x.day)])].filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)&&x<=today);
    const si=computeStreak(days,s.settings,today);
    out.set(p.id,{...p,streak:si.streak,doneToday:si.doneToday,atRisk:si.atRisk,offToday:si.offToday,freezes:si.freezes,
      week:c.filter(x=>x.created_at>=week).reduce((n,x)=>n+x.xp,0)+r.filter(x=>x.created_at>=week).reduce((n,x)=>n+x.xp,0),
      total:c.reduce((n,x)=>n+x.xp,0)+r.reduce((n,x)=>n+x.xp,0),practiced:new Set(days),kept:new Set(si.kept),
      badges:[...new Set(r.filter(x=>x.kind==='badge').map(x=>x.milestone))].sort((a,b)=>a-b)})}
  return out;
}
const publicPerson=p=>{const {practiced,kept,...rest}=p;return rest};
export async function settleFriendRewards(env,id,today) {
  const rows=(await env.DB.prepare("SELECT f.* FROM friend_streaks f JOIN friendships l ON l.a=f.a AND l.b=f.b AND l.status='accepted' WHERE (f.a=? OR f.b=?) AND f.status='active'").bind(id,id).all()).results;
  const per=await people(env,[...new Set(rows.flatMap(x=>[x.a,x.b]))],today);
  for(const f of rows){if(!per.has(f.a)||!per.has(f.b)||await blocked(env,f.a,f.b))continue;
    const s=pairStreak(per.get(f.a),per.get(f.b),f.started,today);
    // Milestone ids survive ending/removing/restarting the pair, preventing repeat XP from the same numbered milestone.
    for(const n of [...Array.from({length:Math.floor(Math.min(1100,s.count)/7)},(_,i)=>(i+1)*7),...[30,100].filter(n=>n<=s.count)]){
      const kind=n===30||n===100?'badge':'xp',xp=kind==='xp'?50:0,at=Date.now();
      const results=await env.DB.batch([f.a,f.b].map(who=>env.DB.prepare('INSERT OR IGNORE INTO friend_rewards(a,b,player_id,kind,milestone,xp,day,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(f.a,f.b,who,kind,n,xp,today,at)));
      for(let i=0;i<2;i++)if(results[i].meta?.changes){const to=i===0?f.a:f.b,from=per.get(i===0?f.b:f.a);await friendNotice(env,to,from,kind==='xp'?'friend_reward':'friend_badge',String(n))}
    }
    if(s.aDone&&s.bDone){const claim=await env.DB.prepare('INSERT OR IGNORE INTO friend_days(a,b,day) VALUES(?,?,?)').bind(f.a,f.b,today).run();if(claim.meta?.changes){await friendNotice(env,f.a,per.get(f.b),'both_done',today);await friendNotice(env,f.b,per.get(f.a),'both_done',today)}}
  }
}
export async function friendsBoard(env,me,today) {
  const handle=await ensureHandle(env,me.id);
  await settleFriendRewards(env,me.id,today);
  const links=(await env.DB.prepare('SELECT l.*,p.id,p.name,h.handle FROM friendships l JOIN players p ON p.id=CASE WHEN l.a=? THEN l.b ELSE l.a END LEFT JOIN friend_handles h ON h.player_id=p.id WHERE (l.a=? OR l.b=?) AND NOT EXISTS(SELECT 1 FROM blocks WHERE (player_id=? AND blocked_id=p.id) OR (player_id=p.id AND blocked_id=?))').bind(me.id,me.id,me.id,me.id,me.id).all()).results;
  const accepted=links.filter(l=>l.status==='accepted'),ids=[me.id,...accepted.map(l=>l.id)],per=await people(env,ids,today);
  const fs=(await env.DB.prepare('SELECT * FROM friend_streaks WHERE a=? OR b=?').bind(me.id,me.id).all()).results;
  const friends=fs.filter(f=>per.has(f.a)&&per.has(f.b)).map(f=>{const other=per.get(f.a===me.id?f.b:f.a),s=pairStreak(per.get(f.a),per.get(f.b),f.started,today);return {id:other.id,name:other.name,status:f.status,mine:f.requested_by===me.id,count:s.count,best:s.best,meDone:f.a===me.id?s.aDone:s.bDone,themDone:f.a===me.id?s.bDone:s.aDone,started:f.started}});
  const visible=accepted.filter(l=>(l.a===me.id?l.mute_a:l.mute_b)!==1).map(l=>l.id);
  const feed=visible.length?(await env.DB.prepare(`SELECT c.id AS ref,c.player_id AS id,p.name,c.lesson_id AS lessonId,c.title,c.xp,c.created_at AS at FROM completions c JOIN players p ON p.id=c.player_id JOIN friendships f ON f.a=min(?,c.player_id) AND f.b=max(?,c.player_id) WHERE f.status='accepted' AND CASE WHEN f.a=? THEN f.mute_a ELSE f.mute_b END=0 AND NOT EXISTS(SELECT 1 FROM blocks WHERE (player_id=? AND blocked_id=c.player_id) OR (player_id=c.player_id AND blocked_id=?)) AND c.created_at>=? ORDER BY c.created_at DESC LIMIT 40`).bind(me.id,me.id,me.id,me.id,me.id,Date.now()-14*864e5).all()).results:[];
  const seen=new Set();const quietFeed=feed.filter(f=>{const k=f.id+'|'+new Date(f.at).toISOString().slice(0,10);if(seen.has(k))return false;seen.add(k);return true}).slice(0,20);
  const rewards=(await env.DB.prepare('SELECT kind,milestone,xp,day,created_at AS at,a,b FROM friend_rewards WHERE player_id=? ORDER BY created_at DESC').bind(me.id).all()).results;
  const rewardDays={};for(const r of rewards)rewardDays[r.day]=(rewardDays[r.day]||0)+r.xp;
  const unseen=await env.DB.prepare('SELECT COUNT(*) AS n FROM notes WHERE player_id=? AND seen=0 AND NOT EXISTS(SELECT 1 FROM blocks WHERE (player_id=? AND blocked_id=from_id) OR (player_id=from_id AND blocked_id=?))').bind(me.id,me.id,me.id).first();
  const prefs=await env.DB.prepare('SELECT requests,streaks,milestones FROM friend_preferences WHERE player_id=?').bind(me.id).first();
  const hidden=(await env.DB.prepare('SELECT b.blocked_id AS id,p.name FROM blocks b LEFT JOIN players p ON p.id=b.blocked_id WHERE b.player_id=?').bind(me.id).all()).results;
  const suggestions=me.solo?[]:(await env.DB.prepare('SELECT p.id,p.name,h.handle FROM players p LEFT JOIN friend_handles h ON h.player_id=p.id WHERE p.group_code=? AND p.id!=? AND NOT EXISTS(SELECT 1 FROM friendships WHERE a=min(?,p.id) AND b=max(?,p.id)) AND NOT EXISTS(SELECT 1 FROM blocks WHERE (player_id=? AND blocked_id=p.id) OR (player_id=p.id AND blocked_id=?)) LIMIT 12').bind(me.group_code,me.id,me.id,me.id,me.id,me.id).all()).results;
  return {me:me.id,profile:{...publicPerson(per.get(me.id)),handle},players:ids.map(id=>per.get(id)).filter(Boolean).map(publicPerson),links:accepted.map(l=>({id:l.id,muted:(l.a===me.id?l.mute_a:l.mute_b)===1})),requests:links.filter(l=>l.status==='pending').map(l=>({id:l.id,name:l.name,handle:l.handle,mine:l.requested_by===me.id})),friends,feed:quietFeed,rewards, rewardXP:rewards.reduce((n,r)=>n+r.xp,0),rewardDays,unseen:unseen.n,blocked:hidden,suggestions,prefs:prefs||{requests:1,streaks:1,milestones:0}};
}
export async function friendsApi(req,env,path,me,{json,fail,body,today}) {
  if(!path.startsWith('/api/friends'))return null;
  const url=new URL(req.url);const t=url.searchParams.get('today');if(t&&/^\d{4}-\d{2}-\d{2}$/.test(t)&&t>=shift(today,-1)&&t<=shift(today,1))today=t;
  if(req.method==='GET'&&path==='/api/friends')return json(await friendsBoard(env,me,today));
  if(req.method==='GET'&&path==='/api/friends/search'){
    if(!await takeRate(env,'find-friend:'+me.id,120,'hour'))return fail('Try searching again later.',429);
    const q=(url.searchParams.get('q')||'').toLowerCase().replace(/^@/,'').trim();if(q.length<3||q.length>40)return json({people:[]});
    const rows=(await env.DB.prepare("SELECT p.id,p.name,h.handle,l.status,l.requested_by FROM friend_handles h JOIN players p ON p.id=h.player_id LEFT JOIN friendships l ON l.a=min(?,p.id) AND l.b=max(?,p.id) WHERE h.handle LIKE ? ESCAPE '!' AND p.id!=? AND NOT EXISTS(SELECT 1 FROM blocks WHERE (player_id=? AND blocked_id=p.id) OR (player_id=p.id AND blocked_id=?)) ORDER BY h.handle LIMIT 12").bind(me.id,me.id,q.replace(/[!%_]/g,x=>'!'+x)+'%',me.id,me.id,me.id).all()).results;
    return json({people:rows.map(r=>({id:r.id,name:r.name,handle:r.handle,status:r.status,mine:r.requested_by===me.id}))});
  }
  if(req.method!=='POST')return null;
  const b=await body(req);
  if(path==='/api/friends/username'){
    const h=String(b.username||'').trim().toLowerCase().replace(/^@/,'');
    if(!/^[a-z0-9._+-]{3,40}$/.test(h))return fail('Use 3–40 letters, numbers, dots, underscores or hyphens.');
    if(!await takeRate(env,'friend-handle:'+me.id,10,'hour'))return fail('Try again later.',429);
    const conflict=await env.DB.prepare('SELECT player_id FROM passwords WHERE username=? AND player_id!=? UNION ALL SELECT player_id FROM friend_handles WHERE handle=? AND player_id!=?').bind(h,me.id,h,me.id).first();if(conflict)return fail('That username is taken.',409);
    const own=await ensureHandle(env,me.id);if(own&&own!==h)return fail('Your username is already set. Contact support to change it.');
    await env.DB.prepare('INSERT OR IGNORE INTO friend_handles(player_id,handle) VALUES(?,?)').bind(me.id,h).run();
    return (await ensureHandle(env,me.id))===h?json({ok:true,handle:h}):fail('That username is taken.',409);
  }
  if(path==='/api/friends/settings'){
    await env.DB.prepare('INSERT INTO friend_preferences(player_id,requests,streaks,milestones) VALUES(?,?,?,?) ON CONFLICT(player_id) DO UPDATE SET requests=excluded.requests,streaks=excluded.streaks,milestones=excluded.milestones').bind(me.id,b.requests?1:0,b.streaks?1:0,b.milestones?1:0).run();return json({ok:true});
  }
  if(!['request','accept','decline','remove','mute'].some(x=>path==='/api/friends/'+x))return null;
  const id=String(b.to||'');if(!id||id===me.id)return fail('Choose another person.');
  const p=await env.DB.prepare('SELECT id,name FROM players WHERE id=?').bind(id).first();if(!p||await blocked(env,me.id,id))return fail('This person is unavailable.',404);
  const [a,z]=pair(me.id,id),l=await env.DB.prepare('SELECT * FROM friendships WHERE a=? AND b=?').bind(a,z).first();
  if(path==='/api/friends/request'){
    if(!await takeRate(env,'friend-request:'+me.id,30,'day'))return fail('Try sending more requests tomorrow.',429);
    if(l)return json({ok:true,status:l.status});
    const limit=await env.DB.prepare('SELECT COUNT(*) AS n FROM friendships WHERE a=? OR b=?').bind(me.id,me.id).first();if(limit.n>=200)return fail('Your friend list is full. Remove a connection before adding another.',409);
    const r=await env.DB.prepare("INSERT OR IGNORE INTO friendships(a,b,status,requested_by,created_at) VALUES(?,?,'pending',?,?)").bind(a,z,me.id,Date.now()).run();if(r.meta?.changes)await friendNotice(env,id,me,'friend_request');return json({ok:true,status:'pending'});
  }
  if(path==='/api/friends/accept'){
    if(!l||l.status!=='pending'||l.requested_by===me.id)return fail('No incoming request to accept.');
    const r=await env.DB.prepare("UPDATE friendships SET status='accepted',accepted_at=? WHERE a=? AND b=? AND status='pending' AND requested_by!=?").bind(Date.now(),a,z,me.id).run();if(r.meta?.changes)await friendNotice(env,id,me,'friend_accept');return json({ok:true});
  }
  if(path==='/api/friends/mute'){
    if(!l||l.status!=='accepted')return fail('Add this person as a friend first.');
    await env.DB.prepare(`UPDATE friendships SET ${a===me.id?'mute_a':'mute_b'}=? WHERE a=? AND b=?`).bind(b.muted?1:0,a,z).run();return json({ok:true});
  }
  if(path==='/api/friends/decline'&&l?.status==='accepted')return fail('Use Remove friend to remove an accepted friend.');
  await env.DB.batch([env.DB.prepare('DELETE FROM friendships WHERE a=? AND b=?').bind(a,z),env.DB.prepare('DELETE FROM friend_streaks WHERE a=? AND b=?').bind(a,z)]);
  return json({ok:true});
}
export async function personalCourseGroup(env,me){
  if(me.solo)return me.group_code;
  let row=await env.DB.prepare('SELECT group_code FROM course_libraries WHERE player_id=?').bind(me.id).first();if(row)return row.group_code;
  const code=await createHomeGroup(env);const r=await env.DB.prepare('INSERT OR IGNORE INTO course_libraries(player_id,group_code) VALUES(?,?)').bind(me.id,code).run();
  if(!r.meta?.changes)await env.DB.prepare('DELETE FROM groups WHERE code=? AND solo=1').bind(code).run();
  return (await env.DB.prepare('SELECT group_code FROM course_libraries WHERE player_id=?').bind(me.id).first()).group_code;
}
export async function courseShareApi(req,env,path,me,{json,fail,body}){
  if(path==='/api/course-share'&&req.method==='POST'){
    const b=await body(req),c=await env.DB.prepare('SELECT id FROM courses WHERE author_id=? AND slug=? ORDER BY updated_at DESC LIMIT 1').bind(me.id,String(b.slug||'')).first();if(!c)return fail('Only the author can share this course.',403);
    if(b.enabled===false){await env.DB.prepare('DELETE FROM course_shares WHERE course_id=?').bind(c.id).run();return json({ok:true});}
    await env.DB.prepare('INSERT OR IGNORE INTO course_shares(course_id,token,created_at) VALUES(?,?,?)').bind(c.id,crypto.randomUUID(),Date.now()).run();
    const row=await env.DB.prepare('SELECT token FROM course_shares WHERE course_id=?').bind(c.id).first();return json({token:row.token});
  }
  if(path==='/api/course-share'&&req.method==='GET'){
    const token=new URL(req.url).searchParams.get('token')||'';if(!/^[a-f0-9-]{36}$/i.test(token))return fail('This course link is unavailable.',404);
    const c=await env.DB.prepare('SELECT c.id,c.slug,c.author_id,p.name,c.json FROM course_shares s JOIN courses c ON c.id=s.course_id JOIN players p ON p.id=c.author_id WHERE s.token=? AND NOT EXISTS(SELECT 1 FROM blocks WHERE (player_id=? AND blocked_id=p.id) OR (player_id=p.id AND blocked_id=?))').bind(token,me.id,me.id).first();
    return c?json({id:c.id,slug:c.slug,authorId:c.author_id,author:c.name,course:JSON.parse(c.json)}):fail('This course link is unavailable.',404);
  }
  return null;
}
