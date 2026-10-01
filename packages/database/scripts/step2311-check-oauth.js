const fs=require('fs');const path=require('path');
function loadEnv(){for(const line of fs.readFileSync(path.resolve(__dirname,'../../../.env'),'utf8').split(/\r?\n/)){const t=line.trim();if(!t||t.startsWith('#')||!t.includes('='))continue;const i=t.indexOf('=');const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[k]=v;}}
loadEnv();
const {PrismaClient}=require('../generated/client');
const p=new PrismaClient();
(async()=>{
  const c=await p.gitProviderConnection.findFirst({where:{status:'ACTIVE'}});
  console.log(JSON.stringify({
    hasEncryptedSecrets:Boolean(c?.encryptedSecrets),
    secretsLen:c?.encryptedSecrets?.length||0,
    login:c?.login,
    installationIdSuffix:String(c?.installationId||'').slice(-4),
  },null,2));
  await p.$disconnect();
})();
