const refs=Object.fromEntries(['panel','health','cause','photo','reads','writes','fresh','details','detailsButton','sound','float','hint','demo'].map(id=>[id,document.getElementById(id)]));
let audio=null,sound=false,previous='',lastAlarm=0;
const count=value=>value?Math.round(value.count).toLocaleString()+'/min':'No recent data';
refs.detailsButton.onclick=()=>{refs.details.hidden=!refs.details.hidden;refs.detailsButton.textContent=refs.details.hidden?'Details':'Less';};
refs.sound.onclick=async()=>{try{audio=audio||new AudioContext();await audio.resume();sound=!sound;refs.sound.textContent=sound?'Sound on':'Sound off';}catch{refs.sound.textContent='Sound unavailable';}};
if(!('documentPictureInPicture'in window)){refs.float.disabled=true;refs.hint.textContent='Floating view requires a supported Chrome or Edge browser. This tab still shows the live metrics.';}
refs.float.onclick=async()=>{try{
 const pip=await documentPictureInPicture.requestWindow({width:380,height:320});pip.document.title='WB Cloud Watch';
 const css=pip.document.createElement('link');css.rel='stylesheet';css.href=location.origin+'/panel.css';pip.document.head.append(css);pip.document.body.append(refs.panel);refs.float.disabled=true;
 pip.addEventListener('pagehide',()=>{document.getElementById('home').append(refs.panel);refs.float.disabled=false;});
}catch{refs.hint.textContent='The browser could not open the floating view. The main panel remains available.';}};
function beep(){if(!audio||!sound)return;const oscillator=audio.createOscillator(),gain=audio.createGain();oscillator.connect(gain);gain.connect(audio.destination);oscillator.frequency.value=740;gain.gain.value=.07;oscillator.start();oscillator.stop(audio.currentTime+.25);}
async function refresh(){try{
 const response=await fetch('/status',{cache:'no-store'});if(!response.ok)throw Error('offline');const s=await response.json(),age=Date.now()-s.collectedAt;
 const status=age>150000?'STALE':s.status;
 refs.panel.style.setProperty('--status',({NORMAL:'#52c788',WARNING:'#f0be46',CRITICAL:'#ff6262'})[status]||'#a7aeb8');
 refs.health.textContent=({NORMAL:'Activity normal',WARNING:'High activity',CRITICAL:'ACTIVITY SPIKE',STALE:'Monitor is offline',NO_RECENT_DATA:'No recent metrics'})[status]||'Metrics unavailable';
 refs.demo.textContent=s.demo?'· DEMO':'';refs.cause.textContent=(s.alerts||[])[0]||'';
 refs.photo.textContent=count(s.photo);refs.reads.textContent=count(s.reads);refs.writes.textContent=count(s.writes);
 refs.fresh.textContent='Cloud sample '+(s.sampleAt?new Date(s.sampleAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'unavailable')+' · checked '+Math.max(0,Math.round(age/1000))+'s ago';
 refs.details.textContent=['wellbuilt-sync · read-only','Google metrics can lag by several minutes.',...(s.alerts||[]),...(s.errors||[]),...(s.functions||[]).map(f=>f.name+': '+Math.round(f.count).toLocaleString()+'/min ('+f.errors+' server errors)')].join('\n');
 if(!s.demo&&status==='CRITICAL'&&(previous!=='CRITICAL'||Date.now()-lastAlarm>300000)){beep();lastAlarm=Date.now();}previous=status;
}catch{refs.health.textContent='Monitor is offline';refs.panel.style.setProperty('--status','#a7aeb8');refs.fresh.textContent='Unable to refresh. No live status is being claimed.';}}
refresh();setInterval(refresh,5000);
