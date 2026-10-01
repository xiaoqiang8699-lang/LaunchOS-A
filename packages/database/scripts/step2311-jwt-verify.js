const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function loadEnv(){for(const line of fs.readFileSync(path.resolve(__dirname,'../../../.env'),'utf8').split(/\r?\n/)){const t=line.trim();if(!t||t.startsWith('#'))continue;const i=t.indexOf('=');if(i<=0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv();
const {createGitHubAppJwt,readGitHubAppConfig}=require('../../github/dist');
const cfg=readGitHubAppConfig();
const keyObj=crypto.createPrivateKey(cfg.privateKey);
const pub=crypto.createPublicKey(keyObj).export({type:'spki',format:'pem'}).toString();
const jwt=createGitHubAppJwt(cfg.appId,cfg.privateKey);
const [h,p,s]=jwt.split('.');
const ok=crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).end().verify(pub, Buffer.from(s,'base64url'));
// Also try converting to PKCS8 and resign
const pkcs8=keyObj.export({type:'pkcs8',format:'pem'}).toString();
const now=Math.floor(Date.now()/1000);
const header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
const payload=Buffer.from(JSON.stringify({iat:now-60,exp:now+540,iss:cfg.appId})).toString('base64url');
const data=`${header}.${payload}`;
const sig=crypto.createSign('RSA-SHA256').update(data).end().sign(pkcs8).toString('base64url');
const jwt2=`${data}.${sig}`;
(async()=>{
  const r1=await fetch('https://api.github.com/app',{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${jwt}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'LaunchOS'}});
  const t1=await r1.text();
  const r2=await fetch('https://api.github.com/app',{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${jwt2}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'LaunchOS'}});
  const t2=await r2.text();
  console.log(JSON.stringify({
    keyType:keyObj.asymmetricKeyType,
    keySize:keyObj.asymmetricKeyDetails?.modulusLength,
    localVerify:ok,
    appWithCurrentJwt:{status:r1.status,hint:t1.slice(0,200)},
    appWithPkcs8Jwt:{status:r2.status,hint:t2.slice(0,200)},
  },null,2));
})();
