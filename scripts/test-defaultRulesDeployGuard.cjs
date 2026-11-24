const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),cfg=JSON.parse(fs.readFileSync(path.join(root,'firebase.json')));
for(const kind of ['database','firestore','storage'])test(`${kind} default configuration enforces the no-rules-deploy policy`,()=>{
 const command=cfg[kind]?.predeploy?.find(x=>/^node /.test(x));assert.ok(command);const match=/^node ([\w./-]+)(?: .*)?$/.exec(command);assert.ok(match);
 const r=cp.spawnSync(process.execPath,[path.join(root,match[1])],{cwd:root,encoding:'utf8',env:{...process.env,CI:'true',FIREBASE_DEPLOY_FORCE:'true'}});assert.notEqual(r.status,0);assert.match(r.stderr,/BLOCKED/);
});
test('Functions and Hosting keep their existing release hooks',()=>{
 assert.ok(cfg.functions.predeploy.some(x=>x.includes('run build')));
 assert.ok(cfg.hosting.predeploy.includes('scripts/preflight-hosting-deploy.cmd'));
 assert.ok(cfg.hosting.postdeploy.includes('scripts/verify-hosting-deploy.cmd'));
});
