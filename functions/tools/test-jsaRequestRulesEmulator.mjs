import assert from 'node:assert/strict';

const host=process.env.FIRESTORE_EMULATOR_HOST;
assert.match(host || '', /^(127\.0\.0\.1|localhost):\d+$/, 'Local emulator required');
const project='demo-wellbuilt-jsa-restore';
const base=`http://${host}/v1/projects/${project}/databases/(default)/documents`;
const path='/jsa_governed_requests/test-request';
const body=JSON.stringify({fields:{companyId:{stringValue:'company-test'},driverId:{stringValue:'driver-test'}}});
assert.equal((await fetch(base+path,{method:'PATCH',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body})).status,200);
const token=claims=>{
 const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
 const now=Math.floor(Date.now()/1000);
 return b({alg:'none',typ:'JWT'})+'.'+b({iss:`https://securetoken.google.com/${project}`,aud:project,iat:now,exp:now+3600,
  sub:'user-test',user_id:'user-test',auth_time:now,firebase:{sign_in_provider:'custom'},...claims})+'.';
};
let passed=0;
for(const claims of [null,{kind:'driver',app:'jsa',driverId:'driver-test',companyId:'company-test'},
 {kind:'driver',app:'wbt',driverId:'driver-test',companyId:'company-test'},
 {kind:'driver',app:'suite',driverId:'driver-test',companyId:'company-test'},
 {kind:'driver',app:'jsa',driverId:'foreign',companyId:'foreign'}]){
 const headers=claims?{Authorization:'Bearer '+token(claims)}:{};
 for(const [method,url] of [['GET',base+path],['GET',base+'/jsa_governed_requests'],['PATCH',base+path]]){
  const r=await fetch(url,{method,headers:{...headers,'Content-Type':'application/json'},...(method==='PATCH'?{body}:{})});
  assert.equal(r.status,403,`${method} must deny ${claims?.app || 'anonymous'}`);passed++;
 }
}
console.log(`Governed request direct-database checks: ${passed} passed`);
