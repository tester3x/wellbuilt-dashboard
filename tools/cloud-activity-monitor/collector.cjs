// Read-only Cloud Monitoring collector. No Firebase document polling/writes,
// no function invocation, no service-account keys and no credentials in output.
const fs=require('node:fs'),path=require('node:path');
const {summarize,defaults}=require('./metrics.cjs');
const {HistoryStore}=require('./history.cjs');
const args=process.argv.slice(2),data=args[0];if(!data||!path.isAbsolute(data))throw Error('Absolute private data directory required');
fs.mkdirSync(data,{recursive:true});
let history=null;
const lib=process.env.WB_FIREBASE_TOOLS_LIB||path.join(process.env.APPDATA||'','npm/node_modules/firebase-tools/lib');
const save=value=>{const tmp=path.join(data,'status.tmp'),dest=path.join(data,'status.json');fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,dest);};
const descriptors=[['run','run.googleapis.com/request_count'],['legacy','cloudfunctions.googleapis.com/function/execution_count'],['reads','firestore.googleapis.com/document/read_count'],['writes','firestore.googleapis.com/document/write_count']];
let stop=false;process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
(async()=>{
 await require(path.join(lib,'requireAuth')).requireAuth({project:'wellbuilt-sync',...require(path.join(lib,'auth')).getGlobalDefaultAccount()});
 const {Client}=require(path.join(lib,'apiv2'));const api=new Client({urlPrefix:'https://monitoring.googleapis.com',apiVersion:'v3',auth:true});
 while(!stop){
  const result={errors:[]},at=Date.now();
  // Query a completed window instead of painting an incomplete new bucket green.
  const end=new Date(Math.floor((at-120000)/60000)*60000).toISOString(),start=new Date(Date.parse(end)-10*60000).toISOString();
  await Promise.all(descriptors.map(async([key,metric])=>{
   try{let token='',rows=[],pages=0;
    do{const q=new URLSearchParams({filter:`metric.type="${metric}"`,'interval.startTime':start,'interval.endTime':end,'aggregation.alignmentPeriod':'60s','aggregation.perSeriesAligner':'ALIGN_SUM',pageSize:'1000',...(token?{pageToken:token}:{})});
     const {body}=await api.get('/projects/wellbuilt-sync/timeSeries?'+q);rows.push(...body.timeSeries||[]);token=body.nextPageToken||'';pages++;
    }while(token&&pages<5);
    if(token)result.truncated=true;result[key]=rows;
   }catch(e){result.errors.push(`${key}: metrics unavailable (${e.status||e.context?.response?.statusCode||'connection/sign-in'})`);}
  }));
  let limits=defaults;try{const local=JSON.parse(fs.readFileSync(path.join(data,'thresholds.json')));limits={...defaults,...Object.fromEntries(Object.entries(local).filter(([k,v])=>k in defaults&&Number.isFinite(v)&&v>0))};}catch{}
  const snapshot=summarize(result,Date.now(),limits);
  try{history??=new HistoryStore(data);history.record(result);snapshot.historyAvailable=true;}
  catch{snapshot.historyError='Local history could not be saved. Live metrics are still shown.';}
  save(snapshot);
  if(args.includes('--once'))return;
  await new Promise(resolve=>setTimeout(resolve,Math.max(1000,60000-(Date.now()-at))));
 }
})().catch(()=>{save({schemaVersion:1,project:'wellbuilt-sync',status:'UNKNOWN',collectedAt:Date.now(),sampleAt:null,alerts:[],errors:['Sign-in or collector unavailable. Use this computer’s Firebase CLI sign-in.'],functions:[]});process.exitCode=1;});
