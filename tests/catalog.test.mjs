import {chromium} from 'playwright-core';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';import {catalogChecks} from './catalog-checks.mjs';
const b=await chromium.launch({executablePath:process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});let fail=0;
try{for(const size of [{width:390,height:844},{width:320,height:740},{width:1280,height:900},{width:390,height:844,scheme:'dark'}]){
 const c=await b.newContext({viewport:{width:size.width,height:size.height},colorScheme:size.scheme||'light'});await c.route(u=>!u.href.startsWith('file:'),r=>r.abort());await c.addInitScript(()=>localStorage.setItem('wl-account',JSON.stringify({token:'x.y',player:{id:'catalog',name:'Catalog'}})));
 const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(pathToFileURL(resolve('docs/index.html')).href);
 for(const [v,name]of await catalogChecks(p)){console.log((v?'PASS ':'FAIL ')+size.width+' '+name);if(!v)fail++;}
 const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);if(overflow||errors.length){console.log('FAIL layout/errors',overflow,errors);fail++;}
 if(size.width===390&&!size.scheme&&process.env.CATALOG_PREVIEW_DIR){await p.evaluate(()=>{state.mix={};$('#toast').hidden=true;go('courses');});await p.screenshot({path:resolve(process.env.CATALOG_PREVIEW_DIR,'catalog-preview.png'),fullPage:false});await p.evaluate(()=>go('course','policy'));await p.screenshot({path:resolve(process.env.CATALOG_PREVIEW_DIR,'course-preview.png'),fullPage:false});}
 await c.close();
}}finally{await b.close();}process.exitCode=fail?1:0;
