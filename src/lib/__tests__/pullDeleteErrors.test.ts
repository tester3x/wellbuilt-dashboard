import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeDeleteError,runDeletePull} from '../pullDeleteCore.ts';

for(const prefix of ['', 'functions/']){
 test(prefix+'permission denial is distinct from connectivity',()=>assert.match(describeDeleteError({code:prefix+'permission-denied'}),/do not have permission/i));
 test(prefix+'expired session is actionable',()=>assert.match(describeDeleteError({code:prefix+'unauthenticated'}),/session expired/i));
 for(const code of ['unavailable','internal','deadline-exceeded'])test(prefix+code+' never claims an unknown outcome was unchanged',()=>{
  const message=describeDeleteError({code:prefix+code});assert.match(message,/refresh to confirm/i);assert.doesNotMatch(message,/was not deleted|was not changed/i);
 });
}
test('Firebase auth token/network failures are recognized before the callable is reached',()=>{
 assert.match(describeDeleteError({code:'auth/user-token-expired'}),/sign in again/i);
 assert.match(describeDeleteError({code:'auth/network-request-failed'}),/connection/i);
 assert.match(describeDeleteError(new TypeError('Failed to fetch')),/connection/i);
});
test('server reasons remain sanitized and no mutation is retried implicitly',async()=>{
 assert.match(describeDeleteError(new Error('well_mismatch:sensitive detail')),/already changed/i);
 assert.doesNotMatch(describeDeleteError(new Error('private exception data')),/private exception data|was not changed/i);
 let calls=0;await assert.rejects(()=>runDeletePull(async()=>{calls++;throw {code:'functions/unavailable'};},'packet','well'));
 assert.equal(calls,1);
});
