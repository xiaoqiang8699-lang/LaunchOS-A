const fs = require('fs');
const path = require('path');
function loadEnv(){for(const line of fs.readFileSync(path.resolve(__dirname,'../../../.env'),'utf8').split(/\r?\n/)){const t=line.trim();if(!t||t.startsWith('#'))continue;const i=t.indexOf('=');if(i<=0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv();
const {readGitHubAppConfig,createGitHubAppJwt}=require('../../github/dist');
const cfg=readGitHubAppConfig();
const key=cfg.privateKey;
const out={
  startsWithBegin:key.startsWith('-----BEGIN'),
  endsWithEnd:key.trim().endsWith('-----'),
  hasLiteralSlashN:key.includes('\\n'),
  hasRealNewline:key.includes('\n'),
  lineCount:key.split('\n').length,
  first20:key.slice(0,20),
  last20:key.slice(-20),
  appId:cfg.appId,
};
// try jwt header decode
const jwt=createGitHubAppJwt(cfg.appId,key);
const [h,p]=jwt.split('.');
out.header=JSON.parse(Buffer.from(h,'base64url').toString());
out.payload=JSON.parse(Buffer.from(p,'base64url').toString());
out.sigLen=jwt.split('.')[2].length;
console.log(JSON.stringify(out,null,2));
