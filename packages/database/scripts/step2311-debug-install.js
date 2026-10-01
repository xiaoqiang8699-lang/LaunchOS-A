const fs = require('fs');
const path = require('path');
function loadEnv(){for(const line of fs.readFileSync(path.resolve(__dirname,'../../../.env'),'utf8').split(/\r?\n/)){const t=line.trim();if(!t||t.startsWith('#'))continue;const i=t.indexOf('=');if(i<=0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv();
const {PrismaClient}=require('../generated/client');
const {createGitHubAppJwt,readGitHubAppConfig}=require('../../github/dist');
const p=new PrismaClient();
(async()=>{
  const cfg=readGitHubAppConfig();
  const out={hasCfg:!!cfg,appId:cfg?.appId||null,slug:cfg?.slug||null,keyLen:(cfg?.privateKey||'').length};
  const jwt=createGitHubAppJwt(cfg.appId,cfg.privateKey);
  out.jwtLen=jwt.length;
  // list installations for this app
  const listRes=await fetch('https://api.github.com/app/installations',{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${jwt}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'LaunchOS'}});
  const listText=await listRes.text();
  out.listStatus=listRes.status;
  let listJson=null; try{listJson=JSON.parse(listText)}catch{}
  out.installations=Array.isArray(listJson)?listJson.map(i=>({id:i.id,account:i.account?.login,type:i.account?.type,suspended:!!i.suspended_at})):null;
  out.listHint=(!Array.isArray(listJson)?listText.slice(0,300):null);
  const c=await p.gitProviderConnection.findFirst({where:{status:'ACTIVE'}});
  out.dbInstallationId=c?.installationId||null;
  if(c?.installationId){
    const one=await fetch(`https://api.github.com/app/installations/${encodeURIComponent(c.installationId)}`,{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${jwt}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'LaunchOS'}});
    out.oneStatus=one.status;
    out.oneHint=(await one.text()).slice(0,300);
  }
  console.log(JSON.stringify(out,null,2));
  await p.$disconnect();
})().catch(async e=>{console.error(e);await p.$disconnect();process.exit(1);});
