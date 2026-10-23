import {chromium} from 'playwright-core';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {tidyChecks} from './tidy-checks.mjs';
const browser=await chromium.launch({executablePath:process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const c=await browser.newContext({viewport:{width:375,height:812}});
await c.route(u=>!u.href.startsWith('file:'),r=>r.abort());
await c.addInitScript(()=>localStorage.setItem('wl-account',JSON.stringify({token:'x.y',player:{id:'tidy',name:'Tidy'},passkeys:0})));
const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
try {
 await p.goto(pathToFileURL(resolve('docs/index.html')).href);
 const checks=await tidyChecks(p);checks.push([!errors.length,'no browser errors: '+errors.join('; ')]);
 checks.forEach(([ok,name])=>console.log((ok?'PASS ':'FAIL ')+name));
 if(checks.some(([ok])=>!ok))process.exitCode=1;
} finally {await browser.close();}
