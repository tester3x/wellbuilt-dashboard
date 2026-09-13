import http from 'node:http';
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const ns = 'wellbuilt-sync-default-rtdb';
// Unsigned JWT for an ordinary authed user — NO wellbuiltAdmin/platformAdmin claims.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({alg:'none',typ:'JWT'})}.${b64({sub:'attacker',user_id:'attacker',email:'attacker@x.co',auth_time:0,iat:0,exp:9999999999})}.`;
function put(path, val) {
  return new Promise((res) => {
    const body = JSON.stringify(val);
    const req = http.request(`http://${host}/${path}.json?ns=${ns}&auth=${jwt}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>res({ status: r.statusCode, body: d.slice(0,120) }));
    });
    req.on('error', e => res({ status: 'ERR', body: String(e) }));
    req.write(body); req.end();
  });
}
const r1 = await put('users/attacker/companyId', 'liquid-gold');
const r2 = await put('users/attacker/roles', ['it']);
console.log('WRITE users/attacker/companyId =>', r1.status, r1.status===200?'ALLOWED':'DENIED', r1.body);
console.log('WRITE users/attacker/roles      =>', r2.status, r2.status===200?'ALLOWED':'DENIED', r2.body);
