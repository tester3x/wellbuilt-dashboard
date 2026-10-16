import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {chromium} from 'playwright';
const source=fs.readFileSync('src/app/mobile/page.tsx','utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let toolbar;
function visit(node){if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(p=>p.name?.getText(ast)==='data-well-status-toolbar'))toolbar=node;ts.forEachChild(node,visit);}
visit(ast);assert.ok(toolbar,'Use the actual shipped toolbar JSX');
const noop=()=>{};const module={exports:null};
vm.runInNewContext(ts.transpileModule(`module.exports=()=>(${toolbar.getText(ast)});`,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,React,wells:Array(91),wellSearch:'',canAddPull:true,viewMode:'table',setViewMode:noop,setWellSearch:noop,expandAll:noop,collapseAll:noop,Link:({children,...props})=>React.createElement('a',props,children)});
const css=fs.readdirSync('out/_next/static/css').filter(f=>f.endsWith('.css')).map(f=>fs.readFileSync(path.join('out/_next/static/css',f),'utf8')).join('\n');
const html=renderToStaticMarkup(React.createElement(module.exports));
const browser=await chromium.launch({headless:true});
try{for(const [viewport,container]of [[344,344],[768,768],[1024,1024],[1280,1280],[1536,1000],[1536,1536]]){
 const page=await browser.newPage({viewport:{width:viewport,height:700}});
 await page.setContent(`<style>${css}</style><body style="margin:0;background:#111827"><main style="width:${container}px;max-width:100%;padding:16px;box-sizing:border-box">${html}</main></body>`);
 const metrics=await page.evaluate(()=>{const toolbar=document.querySelector('[data-well-status-toolbar]');const box=toolbar.getBoundingClientRect();const controls=[...toolbar.querySelectorAll('button,a,input')].map(el=>{const r=el.getBoundingClientRect();return {text:el.textContent.trim()||'search',left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};});return{overflow:document.documentElement.scrollWidth>innerWidth,box:{left:box.left,right:box.right},controls};});
 assert.equal(metrics.overflow,false,`${viewport}/${container}: page overflow`);
 for(const c of metrics.controls){assert.ok(c.left>=metrics.box.left-1&&c.right<=metrics.box.right+1,`${viewport}/${container}: ${c.text} escaped toolbar`);if(c.text.includes('Add Pull'))assert.ok(c.height<=42,'Add Pull must stay on one line');}
 for(let a=0;a<metrics.controls.length;a++)for(let b=a+1;b<metrics.controls.length;b++){const x=metrics.controls[a],y=metrics.controls[b];assert.ok(!(Math.min(x.right,y.right)-Math.max(x.left,y.left)>1&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>1),`${viewport}/${container}: overlapping controls`);}
 console.log(`PASS ${viewport}px viewport / ${container}px content: no overflow, overlap or split Add Pull label`);
 await page.close();
}}finally{await browser.close();}
