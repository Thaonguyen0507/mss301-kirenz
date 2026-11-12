import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const entries=['.gitignore','README.md','package.json','package-lock.json','compose.integration.json','Kirenz-API.postman_collection.json','Kirenz-Integration.postman_collection.json','Kirenz-Local.postman_environment.json','docker','modules','schema','scripts'];
const reports=['collection-coverage.json','newman-report.json','newman-junit.xml','websocket-report.json','event-projection-report.json','resilience-report.json','summary.json','TEST-RESULTS.md','findings.md','chat-findings.md','social-findings.md','.gitkeep'];
const stage=path.join(root,'.local','exports',Date.now().toString(),'kirenz-postman');
const files=[];
function copy(relative){
  const input=path.join(root,relative);
  const stat=fs.lstatSync(input);
  if(stat.isSymbolicLink())throw new Error('Refusing symlink in test kit');
  if(stat.isDirectory()){for(const name of fs.readdirSync(input))copy(path.join(relative,name));return;}
  const content=fs.readFileSync(input);
  if(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(content.toString('utf8')))throw new Error('Refusing JWT-bearing artifact: '+relative);
  const target=path.join(stage,relative);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,content);
  files.push({path:relative.replaceAll('\\','/'),bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')});
}
for(const entry of entries)copy(entry);
for(const file of reports)copy(path.join('reports',file));
const manifest={createdAt:new Date().toISOString(),sourceTree:'5e439abc2ded3f0efdefbce0941f6ce07dd0bbcf',excluded:['.local','node_modules','raw console/build logs'],files};
fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const zip=path.join(path.dirname(root),'Kirenz-Postman-TestKit.zip');
execFileSync('tar',['-a','-cf',zip,'-C',path.dirname(stage),'kirenz-postman'],{stdio:'pipe',windowsHide:true});
fs.writeFileSync(path.join(root,'.local','package-location.json'),JSON.stringify({stage,zip,files:files.length},null,2));
console.log(JSON.stringify({stage,zip,files:files.length,zipBytes:fs.statSync(zip).size}));
