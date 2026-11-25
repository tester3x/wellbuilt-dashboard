const {test}=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),os=require('node:os'),fs=require('node:fs'),path=require('node:path');
test('loopback display serves only aggregates and static assets, rejects cross-origin and all writes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-cloud-display-'));fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'NORMAL',functions:[]}));
 const child=spawn(process.execPath,[path.join(__dirname,'web-monitor.cjs'),'--demo','--data',dir,'--port','0'],{windowsHide:true});
 try{
  const url=await new Promise((resolve,reject)=>{child.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});child.once('error',reject);setTimeout(()=>reject(Error('Server did not start')),5000).unref();});
  const response=await fetch(url+'/status');assert.equal(response.status,200);assert.equal((await response.json()).demo,true);
  assert.equal((await fetch(url+'/status',{method:'POST'})).status,405);
  assert.equal((await fetch(url+'/status',{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(url+'/credentials.json')).status,404);
  assert.match((await fetch(url)).headers.get('content-security-policy'),/frame-ancestors 'none'/);
 }finally{child.kill();}
});
