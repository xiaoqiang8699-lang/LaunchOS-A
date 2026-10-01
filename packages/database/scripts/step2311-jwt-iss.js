const fs=require('fs');const path=require('path');const crypto=require('crypto');
function loadEnv(){for(const line of fs.readFileSync(path.resolve(__dirname,'../../../.env'),'utf8').split(/\r?\n/)){const t=line.trim();if(!t||t.startsWith('#')||!t.includes('='))continue;const i=t.indexOf('=');const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv();
const cfgAppId=process.env.GITHUB_APP_ID;
const clientId=process.env.GITHUB_APP_CLIENT_ID||'';
const key=process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g,'\n').trim();
const fp=crypto.createHash('sha256').update(crypto.createPublicKey(crypto.createPrivateKey(key)).export({type:'spki',format:'der'})).digest('base64');
async function tryIss(iss){
  const now=Math.floor(Date.now()/1000);
  const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
  const p=Buffer.from(JSON.stringify({iat:now-60,exp:now+540,iss})).toString('base64url');
  const data=`${h}.${p}`;
  const sig=crypto.sign('sha256',Buffer.from(data),crypto.createPrivateKey(key)).toString('base64url');
  const jwt=`${data}.${sig}`;
  const r=await fetch('https://api.github.com/app',{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${jwt}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'LaunchOS'}});
  return {iss,status:r.status,hint:(await r.text()).slice(0,160)};
}
(async()=>{
  const out={pubKeySha256:fp,hasClientId:Boolean(clientId),clientIdLen:clientId.length,appId:cfgAppId};
  out.byAppId=await tryIss(cfgAppId);
  out.byAppIdNum=await tryIss(Number(cfgAppId));
  if(clientId) out.byClientId=await tryIss(clientId);
  console.log(JSON.stringify(out,null,2));
})();
