import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import newman from 'newman';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
fs.mkdirSync('.local',{recursive:true});
fs.mkdirSync('reports',{recursive:true});
const env=JSON.parse(fs.readFileSync('Kirenz-Local.postman_environment.json','utf8'));
const set=(key,value)=>{let v=env.values.find(v=>v.key===key);if(!v){v={key,enabled:true,type:/token|password|secret/.test(key)?'secret':'default'};env.values.push(v);}v.value=value;};
const get=key=>env.values.find(v=>v.key===key)?.value;
const base=get('base_url');
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname))throw new Error('Integration runner only targets loopback Docker environments');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function http(url,method='GET',body,token){const r=await fetch(url,{method,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return{status:r.status,json};}
let ready=false;
for(let n=0;n<120;n++){
  try{const apps=await http(get('discovery_base_url')+'/eureka/apps');const names=(apps.json?.applications?.application||[]).map(a=>a.name);const probe=await http(base+'/api/posts/public');if(probe.status===200&&['IDENTITY-SERVICE','USER-SERVICE','SOCIAL-SERVICE','CHAT-SERVICE','NOTIFICATION-SERVICE','ADMIN-SERVICE'].every(x=>names.includes(x))){ready=true;break;}}catch{}
  if(n%15===0)console.log('Waiting for Gateway, Eureka and owner services...');
  await delay(1000);
}
if(!ready)throw new Error('Docker services are not ready; inspect docker compose -p kirenz-integration -f compose.integration.json logs');
const run=Date.now().toString(36)+randomBytes(3).toString('hex');
set('run_id',run);
const adminEmail=`kirenz_it_${run}_admin@example.invalid`;
const adminPassword='KirenzIT!'+randomBytes(12).toString('hex');
const registered=await http(base+'/api/auth/register','POST',{email:adminEmail,username:`kirenz_it_${run}_admin`,password:adminPassword,displayName:'Kirenz IT administrator '+run});
const adminId=registered.json?.data?.id;
if(registered.status!==201||!/^[-a-f0-9]{36}$/i.test(adminId||''))throw new Error('Could not create isolated administrator fixture: HTTP '+registered.status);
const docker=process.env.DOCKER_BIN||(process.platform==='win32'?'C:/Program Files/Docker/Docker/resources/bin/docker.exe':'docker');
const compose=['compose','-p','kirenz-integration','-f','compose.integration.json'];
const container=execFileSync(docker,[...compose,'ps','-q','postgres'],{encoding:'utf8'}).trim();
const label=execFileSync(docker,['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',container],{encoding:'utf8'}).trim();
if(label!=='kirenz-integration')throw new Error('Refusing fixture promotion outside the isolated Compose project');
const sql=`UPDATE users SET role='ADMIN',email_verified=true,email_verified_at=now() WHERE id='${adminId}' AND email='${adminEmail}' RETURNING id;`;
const promoted=execFileSync(docker,[...compose,'exec','-T','postgres','psql','-U','kirenz_it','-d','kirenz_identity','-v','ON_ERROR_STOP=1','-At','-c',sql],{encoding:'utf8'});
if(!promoted.includes(adminId))throw new Error('Isolated administrator fixture promotion failed');
const logged=await http(base+'/api/auth/login','POST',{email:adminEmail,password:adminPassword});
if(logged.status!==200||!logged.json?.data?.accessToken)throw new Error('Isolated administrator login failed');
let dependenciesReady=false;
for(let n=0;n<90;n++){
  try{
    const [search,summary]=await Promise.all([http(base+'/api/users/search?q=kirenz_it_', 'GET',undefined,logged.json.data.accessToken),http(base+'/api/admin/dashboard/summary','GET',undefined,logged.json.data.accessToken)]);
    if(search.status===200&&summary.status===200&&summary.json?.data?.partialData===false){dependenciesReady=true;break;}
  }catch{}
  if(n%15===0)console.log('Waiting for service-local Eureka caches and real Feign dependencies...');
  await delay(1000);
}
if(!dependenciesReady)throw new Error('Service-to-service readiness did not converge; inspect Feign/Eureka logs');
set('admin_access_token',logged.json.data.accessToken);set('admin_email',adminEmail);set('admin_password',adminPassword);set('admin_user_id',adminId);
const envPath='.local/runtime.postman_environment.json';
fs.writeFileSync(envPath,JSON.stringify(env,null,2));
const results=await new Promise((resolve,reject)=>{
  newman.run({collection:JSON.parse(fs.readFileSync('Kirenz-Integration.postman_collection.json','utf8')),environment:env,reporters:['cli','junit'],reporter:{cli:{noBanner:true,noSummary:false,noFailures:false,color:'off'},junit:{export:'reports/newman-junit.xml'}},timeoutRequest:15000,delayRequest:150,bail:false,insecure:false},(error,summary)=>error?reject(error):resolve(summary));
});
fs.writeFileSync(envPath,JSON.stringify({...results.environment.toJSON(),_postman_variable_scope:'environment'},null,2));
const redact=text=>String(text||'').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED_JWT]');
const report={generatedAt:new Date().toISOString(),sourceTree:'5e439abc2ded3f0efdefbce0941f6ce07dd0bbcf',target:base,runId:run,providers:{database:'isolated real PostgreSQL/MongoDB',messaging:'real Kafka/Redis/Eureka/Feign',email:'local Brevo HTTP stub',livekit:'provider-unavailable; orchestration only, not media'},stats:results.run.stats,timings:results.run.timings,requests:results.run.executions.map(e=>({name:e.item.name,method:e.request.method,status:e.response?.code,durationMs:e.response?.responseTime,assertions:e.assertions?.map(a=>({name:a.assertion,passed:!a.error,error:a.error?redact(a.error.message):undefined}))})),failures:results.run.failures.map(f=>({source:f.source?.name,test:f.error?.test,message:redact(f.error?.message)}))};
fs.writeFileSync('reports/newman-report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({requests:report.stats.requests,assertions:report.stats.assertions,failures:report.failures.length,report:'reports/newman-report.json',privateRuntimeEnvironment:envPath}));
process.exitCode=report.failures.length?1:0;
