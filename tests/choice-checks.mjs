export async function choiceChecks(p) { return p.evaluate(() => {
 const out=[],ok=(v,n)=>out.push([!!v,n]);
 state=normalizeState({});go('course','tech');
 const index=LESSONS.findIndex(l=>l.unit>=0);startLesson(index);
 ok(!!document.querySelector('.choice-guide')&&document.querySelector('#rmPre').textContent==='Don’t need this','first question gives permission and renamed action');
 const id=run.cur._card, xp=state.xp;
 document.querySelector('#rmPre').click();
 ok(isRemoved(id)&&state.xp===xp&&!state.srs[id],'unanswered removal is ungraded and earns no XP');
 ok(document.querySelector('#toast').textContent.includes('across all courses')&&!!document.querySelector('#toast button'),'immediate removal gives cross-course reassurance and Undo');
 ok(!document.querySelector('.choice-guide'),'first question guidance appears only once');
 document.querySelector('#toast button').click();ok(!isRemoved(id),'pre-answer Undo restores removed question after advancing');
 run.phase='feedback';document.querySelector('#fb').innerHTML=removeHTML(run.cur);const after=run.cur._card;document.querySelector('#rmBtn').click();ok(isRemoved(after)&&!!document.querySelector('#rmUndo'),'answered removal also offers Undo');document.querySelector('#rmUndo').click();ok(!isRemoved(after),'answered Undo restores question');
 state.prefs={};run.quickKnown=2;ok(choiceTipHTML()==='','no reminder before repeated quick answers');
 run.quickKnown=3;const tip=choiceTipHTML();ok(tip.includes('Too familiar?')&&choiceTipHTML()==='','gentle reminder requires repeated quick answers and is rate limited');
 state.prefs.choiceTipAt=Date.now()-8*86400000;ok(!!choiceTipHTML(),'a second reminder can appear after a week');state.prefs.choiceTipAt=0;ok(choiceTipHTML()==='','reminders stop after two');
 state.prefs={};removeCard(run.cur,'none');ok(choiceTipHTML()===''&&state.prefs.choiceTipOff,'using removal stops reminders');
 const cards=courseCards('tech').filter(c=>c.lessonId===LESSONS[index].id);for(const c of cards)state.removed[c.id]={at:Date.now()};refreshDone();ok(state.done[LESSONS[index].id],'removed questions count toward lesson resolution');
 state.prefs={};run.quickKnown=undefined;run.graded.clear();run.cur._shownAt=performance.now()-15000;srsRecord(run.cur,3);ok(!run.quickKnown,'slow correct answers do not trigger quick-answer reminder');
 run.graded.clear();run.cur._shownAt=performance.now();srsRecord(run.cur,3);ok(run.quickKnown===1,'quick correct answer contributes to reminder');
 show(null);run=null;state=normalizeState({});go('courses');return out;
}); }
