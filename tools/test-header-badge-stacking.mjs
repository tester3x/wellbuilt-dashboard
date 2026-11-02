import fs from 'node:fs';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Exercise the actual icon markup with the exported production CSS, without accounts.
const bell = fs.readFileSync('src/components/NotificationBell.tsx', 'utf8');
const start = bell.indexOf('<button', bell.indexOf('{/* Bell button */}'));
const button = bell.slice(start, bell.indexOf('</button>', start) + '</button>'.length);
const bundle = await build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ChatIcon} from './src/components/chat/ChatIcon';
function BellFixture(){const unreadCount=4,isOpen=false;const setIsOpen=()=>{},setShowSettings=()=>{};return (${button});}
createRoot(document.getElementById('root')).render(<div style={{position:'relative',width:200,height:100}}>
 <div id="icons" style={{display:'flex'}}><ChatIcon onClick={()=>{}} unreadCount={3}/><BellFixture/></div>
 <div id="panel" style={{display:'none',position:'absolute',inset:0,zIndex:50,background:'black'}}>Open panel</div>
</div>);
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = fs.readdirSync('out/_next/static/css').filter(n => n.endsWith('.css')).map(n => fs.readFileSync(`out/_next/static/css/${n}`, 'utf8')).join('\n');
const browser = await chromium.launch();
try {
 const page = await browser.newPage();
 await page.setContent('<style>body{margin:30px}</style><div id="root"></div>');
 await page.addStyleTag({content:css});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForSelector('[title="Messages"] span');
 for (const [title,count] of [['Messages','3'],['Notifications','4']]) {
  const badge=page.locator(`[title="${title}"] span`);
  assert.equal(await badge.textContent(),count);
  const point=await badge.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('button')?.title,point),title,'badge stays with its icon');
  await page.locator('#panel').evaluate(el=>el.style.display='block');
  assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.id,point),'panel',`${title} badge cannot escape above an open panel`);
  await page.locator('#panel').evaluate(el=>el.style.display='none');
 }
 console.log('Header badges: visible with icons, covered by open panels, counts preserved.');
} finally {await browser.close();}
