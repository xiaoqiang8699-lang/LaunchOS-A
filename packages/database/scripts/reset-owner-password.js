const fs=require('fs');const path=require('path');
const envPath=path.resolve(__dirname,'../../../.env');
for (const line of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){const t=line.trim();if(!t||t.startsWith('#'))continue;const i=t.indexOf('=');if(i<=0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}
const bcrypt=require('../../../apps/api/node_modules/bcrypt');
const {PrismaClient}=require('../generated/client');
const p=new PrismaClient();
(async()=>{
  const hash=await bcrypt.hash('Launchos123!',10);
  const u=await p.user.update({where:{email:'xiaoqiang8699@gmail.com'},data:{passwordHash:hash},select:{id:true,email:true}});
  console.log('password_reset_ok', u.email);
  await p.$disconnect();
})().catch(async e=>{console.error(e.message);await p.$disconnect();process.exit(1);});
