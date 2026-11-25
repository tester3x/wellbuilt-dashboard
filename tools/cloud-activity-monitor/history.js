const $=id=>document.getElementById(id),number=n=>Number(n).toLocaleString('en-US'),hour=3600000;
const time=(at,full=false)=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',...(full?{minute:'2-digit'}:{}),timeZoneName:'short'}).format(new Date(at));
let data=null,loading=false;
function node(tag,text,parent){const el=document.createElement(tag);el.textContent=text;if(parent)parent.append(el);return el;}
function svgNode(tag,attrs,text){const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs||{}))el.setAttribute(k,String(v));if(text!==undefined)el.textContent=text;return el;}
const metrics={reads:{label:'Document reads',color:'#f0c34e'},writes:{label:'Document writes',color:'#60c8ff'},calls:{label:'Function calls',color:'#ce9bff'}};
function chart(){
 const selected=$('metric').value,keys=selected==='all'?Object.keys(metrics):[selected],now=Date.now(),start=now-24*hour,points=(data?.points||[]).filter(p=>p.at>=start),max=Math.max(1,...points.flatMap(p=>keys.map(key=>Number.isFinite(p[key])?p[key]:0))),svg=$('chart');svg.replaceChildren();
 const x=at=>50+(at-start)/(24*hour)*890,y=n=>170-n/max*150;
 for(const fraction of [0,.5,1]){svg.append(svgNode('line',{x1:50,y1:y(max*fraction),x2:940,y2:y(max*fraction),class:'grid'}));svg.append(svgNode('text',{x:0,y:y(max*fraction)+4},number(Math.round(max*fraction))));}
 svg.append(svgNode('text',{x:50,y:196},time(start,true)),svgNode('text',{x:940,y:196,'text-anchor':'end'},time(now,true)));
 const legend=$('legend');legend.replaceChildren();let samples=0;
 for(const key of keys){const metric=metrics[key],rows=points.filter(p=>Number.isFinite(p[key]));samples+=rows.length;const item=node('span',metric.label,legend);item.style.color=metric.color;
 let path='',last=null;const group=svgNode('g',{'data-metric':key});for(const p of rows){path+=(last&&p.at-last<=90000?'L':'M')+x(p.at).toFixed(2)+','+y(p[key]).toFixed(2);last=p.at;const dot=svgNode('circle',{cx:x(p.at),cy:y(p[key]),r:5,fill:metric.color});dot.append(svgNode('title',{},time(p.at,true)+' � '+number(p[key])+' '+metric.label.toLowerCase()+'/min'));group.append(dot);}group.prepend(svgNode('path',{d:path,stroke:metric.color}));svg.append(group);}
 $('chartNote').textContent=samples?(selected==='all'?'All three metrics share the same per-minute scale. ': '')+'Hover a point for its value and time. Missing minutes remain gaps.':'No recorded minutes for these metrics yet.';
}

function render(){if(!data)return;const count=Number($('period').value),earliest=Math.floor(Date.now()/hour)*hour-(count-1)*hour,hours=(data.hours||[]).filter(h=>h.at>=earliest);
 for(const key of ['reads','writes','calls'])$(''+key).textContent=hours.some(h=>h.coverage[key]>0)?number(hours.reduce((sum,h)=>sum+h[key],0)):'No samples';
 $('fresh').textContent=(data.minutes?data.minutes+' saved minute records · ':'')+(data.lastAt?'latest '+time(data.lastAt,true):'No history recorded yet')+' · local file refreshed '+new Date().toLocaleTimeString();
 const body=$('hours');body.replaceChildren();for(const h of hours){const row=node('tr','',body);node('td',time(h.at),row);for(const key of ['reads','writes','calls'])node('td',h.coverage[key]?number(h[key]):'—',row);node('td',[h.coverage.reads,h.coverage.writes,h.coverage.calls].join(' / ')+' of 60',row);node('td',h.peaks.reads?number(h.peaks.reads.count)+' · '+time(h.peaks.reads.at,true):'—',row);const top=Object.entries(h.functions||{}).sort((a,b)=>b[1]-a[1])[0];node('td',top?top[0]+' · '+number(top[1]):'—',row);}if(!hours.length){const row=node('tr','',body);const cell=node('td','No saved hours in this range.',row);cell.colSpan=7;}
 const spikes=$('spikes');spikes.replaceChildren();const selected=(data.spikes||[]).filter(s=>s.at>=earliest).slice(0,30);for(const s of selected){const row=node('div','',spikes);row.className='spike';node('time',time(s.at,true),row);node('span',s.reasons.join(' · ')+(s.busiest?' · function activity: '+s.busiest.name+' '+number(s.busiest.count)+'/min':''),row);}if(!selected.length)node('p','No measured spikes saved in this range.',spikes);chart();
}
async function load(){if(loading)return;loading=true;try{const r=await fetch('/history',{cache:'no-store'});if(!r.ok)throw Error();data=await r.json();render();}catch{$('fresh').textContent='Local history unavailable. No cloud query was attempted.';}finally{loading=false;}}
$('period').onchange=render;$('metric').onchange=chart;document.addEventListener('visibilitychange',()=>{if(!document.hidden)void load();});void load();setInterval(()=>{if(!document.hidden)void load();},30000);
