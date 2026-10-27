const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
let fixtures=[],view='table',search='',expanded=[];
const empty=()=>null,now=Date.parse('2026-10-27T20:45:00Z');
const auth={user:{companyId:'liquid-gold',email:'test@example.invalid'},loading:false,operatingCompanyId:'liquid-gold'};
const stubs={
 'next/link':{__esModule:true,default:({children,href,...props})=>React.createElement('a',{href,...props},children)},
 'next/navigation':{useRouter:()=>({push(){},back(){}}),useSearchParams:()=>new URLSearchParams({name:'FW North'})},
 '@/contexts/AuthContext':{useAuth:()=>auth},
 '@/lib/auth':new Proxy({},{get:()=>()=>true}),
 '@/lib/tenantScope':{canViewGovernedWellPool:()=>true,canViewGlobalWellPool:()=>true},
 '@/lib/useGovernedWellPool':{useGovernedWellPool:()=>({wells:fixtures,routes:[...new Set(fixtures.map(w=>w.route))],dataLoading:false,statusUnavailable:false,refresh:async()=>{}})},
 '@/lib/useSharedNow':{useSharedNow:()=>now},
 '@/lib/useDashboardViewState':{useDashboardViewState:(key,fallback)=>[key==='view'?view:key==='search'?search:fallback,()=>{}]},
 '@/components/AppHeader':{AppHeader:empty},'@/components/AddPullModal':{AddPullModal:empty},
 '@/components/TicketDetailModal':{TicketDetailModal:empty},'@/components/WellPoolEmptyState':{WellPoolEmptyState:empty},
 '@/lib/tickets':{fetchTickets:async()=>[]},'@/lib/firestoreWells':{loadDisposals:async()=>[]},
 '@/lib/pullDelete':{canDeletePull:()=>false},
};
function load(file){
 file=path.resolve(file);const exports={};
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true,target:ts.ScriptTarget.ES2020}}).outputText;
 const localRequire=id=>{
  if(stubs[id])return stubs[id];
  if(id==='@/lib/wells')return load('src/lib/wellPoolCore.ts');
  if(id.startsWith('@/')||id.startsWith('.')){
   let p=id.startsWith('@/')?path.join('src',id.slice(2)):path.resolve(path.dirname(file),id);
   for(const suffix of ['', '.ts','.tsx'])if(fs.existsSync(p+suffix)&&fs.statSync(p+suffix).isFile())return load(p+suffix);
   throw Error('Unresolved local import '+id);
  }
  return require(id);
 };
 new Function('require','exports','module','window','localStorage',code)(localRequire,exports,{exports},{localStorage:{getItem:()=>JSON.stringify(expanded)}},{getItem:()=>JSON.stringify(expanded),setItem(){}});
 return exports;
}
const {mergeWellPool}=load('src/lib/wellPoolCore.ts');
const cfg={
 'FW North':{routeType:'freshwater',displayName:'FW North',route:'Shared name',tanks:3,bblPerFoot:60,tankHeight:20,bottomLevel:8},
 'PW North':{route:'Shared name',tanks:1,bblPerFoot:20,tankHeight:20,bottomLevel:3,avgFlowRate:'2:15:00'},
 'FW Unknown':{routeType:'freshwater',route:'Fresh only',tanks:1,bblPerFoot:20,tankHeight:20},
 'PW Unrouted':{tanks:1},'FW Unrouted':{routeType:'freshwater',tanks:1},
};
fixtures=mergeWellPool(cfg,{'FW North':{inventoryDailyBbl:72,inventoryLevelFeet:13.5,inventoryAsOfUTC:'2026-10-27T19:45:00Z'}});
const {freshWaterRateDisplay}=load('src/lib/freshWaterRateDisplay.ts');
const {waterRouteFamilies,familyRouteKey}=load('src/lib/waterRouteFamilies.ts');
const groups=waterRouteFamilies(fixtures);
expanded=Object.values(groups).flatMap(g=>g.map(x=>x.key));
assert.notEqual(familyRouteKey('freshwater','Shared name'),familyRouteKey('produced-water','Shared name'));
assert.equal(freshWaterRateDisplay(fixtures[0]).perFoot,'20:00:00');assert.equal(freshWaterRateDisplay(fixtures[0]).perInch,'1:40:00');
assert.equal(freshWaterRateDisplay({...fixtures[0],inventoryDailyBbl:0}).perDay,'0 BBL/day');
assert.equal(freshWaterRateDisplay({...fixtures[0],inventoryDailyBbl:0}).perFoot,'--');
assert.equal(freshWaterRateDisplay({...fixtures[0],inventoryDailyBbl:undefined,flowRate:'99:00:00'}).daily,null);
const page=load('src/app/mobile/page.tsx').default;
function render(){return renderToStaticMarkup(React.createElement(page));}
function families(html){const sections=html.split('<section');return {produced:sections.find(s=>s.includes('Produced Water Routes')),fresh:sections.find(s=>s.includes('Freshwater Routes'))};}
for(view of ['table','cards']){
 search='';const html=render(),f=families(html);
 assert.ok(f.produced.includes('PW North')&&!f.produced.includes('FW North')&&!f.produced.includes('Fresh only'));
 assert.ok(f.fresh.includes('FW North')&&!f.fresh.includes('PW North')&&!f.fresh.includes('PW Unrouted'));
 assert.ok(f.produced.includes('PW Unrouted'));assert.ok(f.fresh.includes('FW Unrouted'));
 assert.ok(f.fresh.includes('20:00:00')&&f.fresh.includes('72 BBL/day')&&f.fresh.includes('estimated'));
 assert.ok(f.produced.includes('2:15:00'));assert.equal((html.match(/>FW North<\/a>|>FW North<\/h3>/g)||[]).length,1);
 search='  FW North  ';const searched=families(render());assert.ok(searched.fresh.includes('FW North'));assert.ok(!searched.produced.includes('Shared name'));
}
search='';view='table';expanded=[familyRouteKey('produced-water','Shared name')];let f=families(render());assert.ok(f.produced.includes('PW North')&&!f.fresh.includes('FW North'));
expanded=[familyRouteKey('freshwater','Shared name')];f=families(render());assert.ok(f.fresh.includes('FW North')&&!f.produced.includes('PW North'));
// Actual well-detail status JSX, including inch/foot/day rate units.
const detail=load('src/app/well/page.tsx').default;
const detailHtml=renderToStaticMarkup(React.createElement(detail));
assert.ok(detailHtml.includes('20:00:00')&&detailHtml.includes('1:40:00')&&detailHtml.includes('72 BBL/day'));
assert.ok(detailHtml.includes('estimated')&&!detailHtml.includes('>Unknown<'));
const {FreshWaterRate}=load('src/components/FreshWaterRate.tsx');
const down=renderToStaticMarkup(React.createElement(FreshWaterRate,{well:{...fixtures[0],isDown:true}}));assert.ok(down.includes('paused')&&down.includes('72 BBL/day'));
const zero=renderToStaticMarkup(React.createElement(FreshWaterRate,{well:{...fixtures[0],inventoryDailyBbl:0}}));assert.ok(zero.includes('0 BBL/day')&&!zero.includes('Infinity'));
// Actual Dispatch row and reassign information expressions, with stale copied legacy rates.
const dispatchText=fs.readFileSync('src/app/dispatch/page.tsx','utf8');
const ast=ts.createSourceFile('dispatch.tsx',dispatchText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const expressions=[];function visit(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(ast)==='FreshWaterRate'){let parent=n.parent;while(parent&&!ts.isJsxExpression(parent))parent=parent.parent;if(parent?.expression)expressions.push(parent.expression.getText(ast));}ts.forEachChild(n,visit);}visit(ast);
assert.equal(expressions.length,2);
for(const expression of expressions){const code=ts.transpileModule('module.exports = '+expression,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;const module={exports:null};new Function('require','module','well','wells','reassignJob','FreshWaterRate','const exports={};'+code)(require,module,fixtures[0],fixtures,{wellName:'FW North',flowRate:'Unknown'},FreshWaterRate);const html=renderToStaticMarkup(module.exports);assert.ok(html.includes('20:00:00')&&html.includes('72 BBL/day')&&!html.includes('Unknown'));}
// Unrouted pagination/counts must exclude freshwater and retain its independent inventory row.
fixtures=[...fixtures,...Array.from({length:24},(_,i)=>({...fixtures.find(w=>w.wellName==='PW Unrouted'),wellName:'PW extra '+i}))];
view='table';expanded=[familyRouteKey('produced-water','Unrouted'),familyRouteKey('freshwater','Unrouted')];
const paginated=families(render());assert.ok(paginated.produced.includes('Showing 20 of 25 wells'));assert.ok(!paginated.produced.includes('FW Unrouted'));assert.ok(paginated.fresh.includes('FW Unrouted'));
console.log('Dashboard actual table/card/detail freshwater displays and exclusive family render regressions passed.');
