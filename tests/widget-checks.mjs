export async function widgetChecks(p) {
  return await p.evaluate(() => eval(`(() => {
    const out=[], check=(v,n)=>out.push([!!v,n]), today=dstr(new Date());
    state=normalizeState({}); state.mix={tools:{on:true,perDay:5}}; state.prefs={goal:50};
    state.activeDays=Array.from({length:6},(_,i)=>addDays(today,i-7));
    state.xpDays={[today]:125};
    let days=widgetDays(), t=days[today];
    check(Object.keys(days).length===15,'fifteen local calendar days');
    check(t.xp===125 && t.goal===50,'uncapped XP and chosen goal');
    check(t.freezeUsed===true,'yesterday consumed a freeze');
    check(t.risk===true && t.done===false,'streak at risk until practice');
    check(days[addDays(today,1)].xp===0,'today XP never carries to tomorrow');
    check(days[addDays(today,1)].freezeUsed===false,'freeze warning not repeated without a new consumption');
    check(Object.values(days).every(x=>typeof x.reviews==='number'&&x.reviews>=0),'due review counts present');
    const card=courseCards('tools').find(x=>!isRemoved(x.id));
    state.srs[card.id]={s:2,last:addDays(today,-2),due:today,ok:2,reps:2,at:Date.now()};
    days=widgetDays(); check(days[today].reviews===dueCards(today).length && days[today].reviews>0,'counts available reviews in the mix');
    state.removed={}; equivalentIds(card.id).forEach(id=>state.removed[id]={at:Date.now(),reason:'none'});
    check(widgetDays()[today].reviews===dueCards(today).length,'uses session filtering for removed/shared cards');
    state.activeDays.push(today);days=widgetDays();check(days[today].done && !days[today].risk,'practice clears risk');
    state.prefs.goal=0;check(widgetDays()[today].goal===0,'goal off stays off');
    return out;
  })()`));
}
