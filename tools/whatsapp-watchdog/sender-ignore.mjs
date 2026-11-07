import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';

export function loadSenderIgnoreRules(directory) {
 const file=path.join(directory,'sender-ignore.json');
 if(!existsSync(file))return {};
 const rules=JSON.parse(readFileSync(file,'utf8'));
 if(!rules||typeof rules!=='object'||Array.isArray(rules))throw Error('Invalid sender-ignore rules');
 for(const hashes of Object.values(rules)){
  if(!Array.isArray(hashes)||hashes.some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)))throw Error('Invalid sender-ignore rule hash');
 }
 return rules;
}

export function isIgnoredSender(rules,channelId,senderId) {
 if(typeof channelId!=='string'||typeof senderId!=='string'||!senderId)return false;
 const hashes=rules?.[channelId];
 if(!Array.isArray(hashes)||!hashes.length)return false;
 const senderHash=createHash('sha256').update(senderId).digest('hex');
 return hashes.includes(senderHash);
}
