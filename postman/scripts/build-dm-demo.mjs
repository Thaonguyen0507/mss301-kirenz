import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uid=value=>{const h=createHash('sha256').update(value).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const event=(listen,code)=>({listen,script:{type:'text/javascript',exec:['(()=>{',...code.split('\n'),'})();']}});
const initialize=`const run=Date.now().toString(36)+Math.random().toString(36).slice(2,7);
pm.environment.set('demo_run_id',run);
for(const actor of ['a','b']){
  pm.environment.set('demo_email_'+actor,'kirenz_demo_'+run+'_'+actor+'@example.invalid');
  pm.environment.set('demo_username_'+actor,'kirenz_demo_'+run+'_'+actor);
  pm.environment.set('demo_password_'+actor,'KirenzDemo!'+run+'_'+actor);
  pm.environment.set('demo_access_token_'+actor,'');
  pm.environment.set('demo_user_'+actor+'_id','');
}
pm.environment.set('demo_conversation_id','');
pm.environment.set('demo_call_id','');`;
const guard=`const base=pm.environment.get('base_url');
if(!['http://localhost:18080','http://127.0.0.1:18080'].includes(base)) throw new Error('Chon environment Kirenz | DM Block Demo, base_url=http://localhost:18080.');`;
let index=0;
function request(name,method,route,actor,expected,{body,tests='',captures=[],description='',pre}={}){
  const req={method,header:[{key:'Accept',value:'application/json'}],auth:actor?{type:'bearer',bearer:[{key:'token',type:'string',value:`{{demo_access_token_${actor}}}`}]}:{type:'noauth'},url:'{{base_url}}'+route,description};
  if(body!==undefined){req.header.push({key:'Content-Type',value:'application/json'});req.body={mode:'raw',raw:JSON.stringify(body,null,2),options:{raw:{language:'json'}}};}
  const code=`pm.test('HTTP ${expected}',()=>pm.expect(pm.response.code).to.eql(${expected}));
const response=pm.response.json();
pm.test('${expected<400?'Success':'Rejected'} envelope',()=>pm.expect(response.success).to.eql(${expected<400}));
if(pm.response.code===${expected} && pm.response.code<300){
  for(const capture of ${JSON.stringify(captures)}){
    const value=capture.path.split('.').reduce((v,k)=>v==null?undefined:v[k],response);
    pm.test('Capture '+capture.key,()=>pm.expect(value).to.be.a('string').and.not.empty);
    if(typeof value==='string' && value)pm.environment.set(capture.key,value);
  }
}
${tests}`;
  const item={id:uid(name),name,request:req,event:[event('test',code)]};
  if(pre)item.event.unshift(event('prerequest',pre));
  index++;
  return item;
}
const capture=(key,p='data.id')=>[{key,path:p}];
const state=s=>`pm.test('Call state ${s}',()=>pm.expect(response.data.status).to.eql('${s}'));`;
const permission=allowed=>`pm.test('DM permission ${allowed}',()=>pm.expect(response.data).to.eql(${allowed}));`;
const callBody={conversationId:'{{demo_conversation_id}}'};
function lifecycle(prefix){return[
  request(prefix+'.1 A bat dau goi - 200 RINGING','POST','/api/calls','a',200,{body:callBody,captures:capture('demo_call_id'),tests:state('RINGING'),description:'Chat hoi User-service ve DM, lay profile Identity, khoa Redis va luu video_call MongoDB. Chua truyen media.'}),
  request(prefix+'.2 B nhan cuoc goi - 200 ACCEPTED','POST','/api/calls/{{demo_call_id}}/accept','b',200,{tests:state('ACCEPTED'),description:'Gui trong 60 giay sau Start. Chat kiem tra lai quyen DM qua User-service.'}),
  request(prefix+'.3 A ket thuc - 200 ENDED','POST','/api/calls/{{demo_call_id}}/end','a',200,{tests:state('ENDED'),description:'Ket thuc ngay sau Accept de tranh heartbeat timeout 45 giay. Demo khong yeu cau video-access.'})
];}
const setup=[];
for(const actor of ['a','b']){
  const label=actor.toUpperCase();
  setup.push(request(`00.${setup.length+1} Dang ky tai khoan ${label} moi`,'POST','/api/auth/register',null,201,{pre:actor==='a'?initialize:undefined,body:{email:`{{demo_email_${actor}}}`,username:`{{demo_username_${actor}}}`,password:`{{demo_password_${actor}}}`,displayName:`Kirenz demo ${label} {{demo_run_id}}`},captures:capture(`demo_user_${actor}_id`),description:actor==='a'?'Request nay khoi tao run_id moi va reset cac bien demo. Luon chay setup tu request dau tien.':'Tao actor B rieng biet trong cung run.'}));
  setup.push(request(`00.${setup.length+1} Dang nhap ${label} - tu luu token`,'POST','/api/auth/login',null,200,{body:{email:`{{demo_email_${actor}}}`,password:`{{demo_password_${actor}}}`},captures:capture(`demo_access_token_${actor}`,'data.accessToken'),description:'Token chi luu trong environment local. Neu qua 15 phut, chay lai Login cho A va B.'}));
}
setup.push(request('00.5 B cho phep moi nguoi lien lac','PUT','/api/privacy/me','b',200,{body:{allowDirectMessages:true},tests:'pm.test("B allows DM",()=>pm.expect(response.data.allowDirectMessages).to.eql(true));',description:'Co y cho phep DM, de phan sau chung minh BLOCK van uu tien hon privacy permissive.'}));
setup.push(request('00.6 Tao hoi thoai A-B - tu luu conversation ID','POST','/api/conversations/direct/{{demo_user_b_id}}','a',200,{captures:capture('demo_conversation_id'),tests:'pm.test("DIRECT A-B",()=>{pm.expect(response.data.type).to.eql("DIRECT");pm.expect(response.data.participants.map(p=>p.userId)).to.include.members([pm.environment.get("demo_user_a_id"),pm.environment.get("demo_user_b_id")]);});'}));
const collection={info:{_postman_id:uid('kirenz-dm-block-demo'),name:'Kirenz | DEMO DM Block - Success va Tu choi',schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',description:'Demo co thu tu tren Gateway local18080 va User-service da sua block. Moi folder la mot phan trinh bay: setup tai khoan moi, success, B block A bi tu choi403, unblock success. HTTP403 mong doi van la test PASS. Khong goi video-access, khong kiem tra media LiveKit. Run collection de khong vuot thoi han ringing60s/heartbeat45s; hoac gui tungrequesttheothutu.'},event:[event('prerequest',guard)],item:[
  {name:'00 SETUP - tao A/B moi va hoi thoai',item:setup},
  {name:'01 SUCCESS - khong block, A goi B',item:[request('01.0 A duoc phep lien lac B - data true','GET','/api/privacy/can-message/{{demo_user_b_id}}','a',200,{tests:permission(true)}),...lifecycle('01')]},
  {name:'02 NEGATIVE - B block A, API tu choi dung 403',item:[
    request('02.1 B block A - 201','POST','/api/blocks/{{demo_user_a_id}}','b',201,{description:'Actor B la blocker; A la blocked. Day la thay doi duy nhat so voi success.'}),
    request('02.2 Quyen A sang B - 200 va data false','GET','/api/privacy/can-message/{{demo_user_b_id}}','a',200,{tests:permission(false)}),
    request('02.3 Quyen B sang A - 200 va data false','GET','/api/privacy/can-message/{{demo_user_a_id}}','b',200,{tests:permission(false)}),
    request('02.4 A goi B bi tu choi - 403, test PASS','POST','/api/calls','a',403,{body:callBody,description:'403 la ket qua dung vi cap A/B dang co block. Neu200 thi test FAIL va can kiem tra dang chay code cu.'}),
    request('02.5 B goi A cung bi tu choi - 403, test PASS','POST','/api/calls','b',403,{body:callBody}),
    request('02.6 A mo lai hoi thoai voi B bi tu choi - 403','POST','/api/conversations/direct/{{demo_user_b_id}}','a',403)
  ]},
  {name:'03 RESTORE - B unblock A, goi thanh cong lai',item:[
    request('03.0 B unblock A - 200','DELETE','/api/blocks/{{demo_user_a_id}}','b',200),
    request('03.1 Quyen A sang B duoc khoi phuc - data true','GET','/api/privacy/can-message/{{demo_user_b_id}}','a',200,{tests:permission(true)}),
    ...lifecycle('03')
  ]}
]};
const defaults={base_url:'http://localhost:18080',demo_run_id:'',demo_conversation_id:'',demo_call_id:''};
for(const actor of ['a','b'])for(const key of ['email','username','password','access_token'])defaults[`demo_${key}_${actor}`]='';
defaults.demo_user_a_id='';defaults.demo_user_b_id='';
const values=Object.entries(defaults).map(([key,value])=>({key,value,enabled:true,type:/password|token/.test(key)?'secret':'default'}));
collection.variable=values.map(v=>({key:v.key,value:v.value,type:'string'}));
const environment={id:uid('kirenz-dm-demo-environment'),name:'Kirenz | DM Block Demo',values,_postman_variable_scope:'environment'};
for(const [filename,json]of[['Kirenz-DM-Block-Demo.postman_collection.json',collection],['Kirenz-DM-Block-Demo.postman_environment.json',environment]])fs.writeFileSync(path.join(root,filename),JSON.stringify(json,null,2)+'\n');
console.log(JSON.stringify({requests:index,folders:collection.item.length,collection:'Kirenz-DM-Block-Demo.postman_collection.json',environment:environment.name}));
