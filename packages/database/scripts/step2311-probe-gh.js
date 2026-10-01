const fs = require('fs');
const path = require('path');
function loadEnv(){for(const line of fs.readFileSync(path.resolve(__dirname,'../../../.env'),'utf8').split(/\r?\n/)){const t=line.trim();if(!t||t.startsWith('#'))continue;const i=t.indexOf('=');if(i<=0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}
loadEnv();
const {PrismaClient}=require('../generated/client');
const {createInstallationAccessToken,listInstallationRepositories,getInstallation,isGitHubAppConfigured}=require('../../github/dist');
const p=new PrismaClient();
(async()=>{
  const out={configured:isGitHubAppConfigured()};
  const cons=await p.gitProviderConnection.findMany({orderBy:{updatedAt:'desc'},select:{id:true,status:true,installationId:true,login:true,accountType:true,updatedAt:true}});
  out.connections=cons.map(c=>({id:c.id,status:c.status,login:c.login,accountType:c.accountType,installationIdSuffix:c.installationId?String(c.installationId).slice(-4):null,updatedAt:c.updatedAt}));
  const active=cons.find(c=>c.status==='ACTIVE')||cons[0];
  if(!active){console.log(JSON.stringify(out,null,2));return;}
  try{
    const inst=await getInstallation(active.installationId);
    out.installation={login:inst.accountLogin,type:inst.accountType};
  }catch(e){out.installationError=String(e.message||e);}
  try{
    const tok=await createInstallationAccessToken(active.installationId);
    out.tokenIssued=true; out.tokenExpiresAt=tok.expiresAt; out.tokenLen=tok.token.length;
    const repos=await listInstallationRepositories(tok.token);
    out.repos=repos.map(r=>({fullName:r.fullName,private:r.private,defaultBranch:r.defaultBranch}));
    // try create private repo under user/org
    const name='launchos-multi-demo';
    const headers={Authorization:`Bearer ${tok.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'LaunchOS-Acceptance'};
    let create=await fetch('https://api.github.com/user/repos',{method:'POST',headers,body:JSON.stringify({name,private:true,description:'LaunchOS Step 23.11 multi-unit private demo',auto_init:true})});
    let body=await create.text();
    out.createUser={status:create.status,ok:create.ok,hint:body.slice(0,240).replace(/ghs_[A-Za-z0-9_]+/g,'***')};
    if(!create.ok && out.installation?.login){
      create=await fetch(`https://api.github.com/orgs/${encodeURIComponent(out.installation.login)}/repos`,{method:'POST',headers,body:JSON.stringify({name,private:true,description:'LaunchOS Step 23.11 multi-unit private demo',auto_init:true})});
      body=await create.text();
      out.createOrg={status:create.status,ok:create.ok,hint:body.slice(0,240).replace(/ghs_[A-Za-z0-9_]+/g,'***')};
    }
    // if exists, check privacy via API
    const existing=repos.find(r=>r.name==='launchos-multi-demo'||r.fullName.endsWith('/launchos-multi-demo'));
    if(existing) out.existing=existing;
    else if(out.installation?.login){
      const getRes=await fetch(`https://api.github.com/repos/${out.installation.login}/launchos-multi-demo`,{headers});
      const getBody=await getRes.text();
      out.getRepo={status:getRes.status,ok:getRes.ok,hint:getBody.slice(0,300).replace(/ghs_[A-Za-z0-9_]+/g,'***')};
    }
  }catch(e){out.tokenError=String(e.message||e);}
  console.log(JSON.stringify(out,null,2));
  await p.$disconnect();
})().catch(async e=>{console.error(e);await p.$disconnect();process.exit(1);});
