// Loopback-only read-only display. Browser receives aggregates, never auth.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const args=process.argv.slice(2),value=(key,fallback)=>{const i=args.indexOf(key);return i>=0?args[i+1]:fallback;};
const data=value('--data',path.join(process.env.LOCALAPPDATA,'WellBuilt','CloudActivityMonitor')),demo=args.includes('--demo'),port=Number(value('--port','8793'));
fs.mkdirSync(data,{recursive:true});let collector=null,lastView=Date.now();
const server=http.createServer((req,res)=>{
 const origin='http://127.0.0.1:'+server.address().port;
 if(![origin.slice(7),'localhost:'+server.address().port].includes(req.headers.host))return res.writeHead(403).end();
 if(req.method!=='GET')return res.writeHead(405).end();
 if(req.headers.origin&&![origin,origin.replace('127.0.0.1','localhost')].includes(req.headers.origin))return res.writeHead(403).end();
 const pathname=new URL(req.url,origin).pathname;
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
 res.setHeader('Permissions-Policy','picture-in-picture=(self)');
 if(pathname==='/status'){
  lastView=Date.now();res.setHeader('Content-Type','application/json');
  try{const snapshot=JSON.parse(fs.readFileSync(path.join(data,'status.json')));res.end(JSON.stringify({...snapshot,demo}));}
  catch{res.end(JSON.stringify({status:'UNKNOWN',collectedAt:Date.now(),functions:[],alerts:[],errors:['Collector/sign-in unavailable'],demo}));}return;
 }
 if(pathname==='/history'){
  lastView=Date.now();
  res.setHeader('Content-Type','application/json');
  try{res.end(fs.readFileSync(path.join(data,'history-summary.json'),'utf8'));}
  catch{res.end(JSON.stringify({hours:[],points:[],spikes:[],minutes:0,note:'No local history recorded yet.'}));}return;
 }
 const files={'/':['panel.html','text/html'],'/panel.js':['panel.js','text/javascript'],'/panel.css':['panel.css','text/css'],'/history-view':['history.html','text/html'],'/history.js':['history.js','text/javascript'],'/history.css':['history.css','text/css']};
 const file=files[pathname];if(!file)return res.writeHead(404).end();res.setHeader('Content-Type',file[1]);res.end(fs.readFileSync(path.join(__dirname,file[0])));
});
server.on('error',error=>{console.error('Monitor unavailable: '+error.code);if(collector)collector.kill();process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>{
 if(!demo){collector=spawn(process.execPath,[path.join(__dirname,'collector.cjs'),data],{windowsHide:true,stdio:'ignore'});collector.on('error',()=>{});}
 console.log('WB Cloud Watch ready at http://127.0.0.1:'+server.address().port+(demo?' (DEMO)':''));
});
const idle=setInterval(()=>{if(Date.now()-lastView>10*60000){if(collector)collector.kill();server.close(()=>process.exit(0));}},30000);idle.unref();
function stop(){if(collector)collector.kill();server.close(()=>process.exit(0));}process.on('SIGTERM',stop);process.on('SIGINT',stop);
