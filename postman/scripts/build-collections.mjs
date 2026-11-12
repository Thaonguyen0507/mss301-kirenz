import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventories = fs.readdirSync(path.join(root, 'modules')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(root, 'modules', f), 'utf8')));
const endpoints = inventories.flatMap(m => m.endpoints);
const byId = Object.fromEntries(endpoints.map(e => [e.id, e]));
const uuid = value => { const h = createHash('sha256').update(value).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
const event = (listen, code) => ({ listen, script: { type: 'text/javascript', exec: ['(()=>{',...code.split('\n'),'})();'] } });
const init = `if (!pm.environment.get('run_id')) pm.environment.set('run_id', Date.now().toString(36) + Math.random().toString(36).slice(2,7));
const run = pm.environment.get('run_id');
for (const actor of ['a','b','outsider']) {
  for (const [key,value] of Object.entries({email:'kirenz_it_'+run+'_'+actor+'@example.invalid',username:'kirenz_it_'+run+'_'+actor,password:'KirenzIT!'+run+'_'+actor,display_name:'Kirenz IT '+run+' '+actor})) {
    if (!pm.environment.get(key+'_'+actor)) pm.environment.set(key+'_'+actor,value);
  }
}
for (const [key,value] of Object.entries({profile_display_name:'Kirenz updated '+run,profile_bio:'Disposable integration '+run,from_date:new Date(Date.now()-86400000).toISOString().slice(0,10),to_date:new Date().toISOString().slice(0,10),suspended_until:new Date(Date.now()+3600000).toISOString(),target_type:'POST'})) if (!pm.environment.get(key)) pm.environment.set(key,value);`;
const actorMap = (value, actor) => {
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (actor && actor !== 'a') {
    for (const k of ['email','username','password','display_name','access_token','refresh_token']) s = s.replaceAll(`{{${k}_a}}`, `{{${k}_${actor}}}`);
    s = s.replaceAll('{{user_a_id}}', `{{user_${actor}_id}}`);
  }
  return typeof value === 'string' ? s : JSON.parse(s);
};
let sequence = 0;
function make(id, opts = {}) {
  const e = byId[id];
  if (!e) throw new Error(`Unknown endpoint ${id}`);
  const actor = opts.actor || 'a';
  const statuses = opts.statuses || e.expectedStatuses || [200];
  const prefix = e.service.replace('-service','').replace('api-gateway','gateway');
  const internal = e.auth === 'internal' || e.tags?.includes('direct-service') || e.tags?.includes('internal');
  const base = opts.base || (internal ? e.baseUrlVariable || `${prefix}_base_url` : 'base_url');
  const requestPath = opts.path || e.path;
  const query = opts.query === null ? [] : opts.query || e.query || [];
  const qs = query.filter(q => !q.disabled && q.value !== '' && !(/cursor/i.test(q.key) && String(q.value).startsWith('{{'))).map(q => `${encodeURIComponent(q.key)}=${q.value}`).join('&');
  const authType = opts.auth || e.auth;
  const auth = authType === 'none' ? {type:'noauth'} : {type:'bearer',bearer:[{key:'token',type:'string',value:authType === 'admin' || authType === 'internal' ? '{{admin_access_token}}' : `{{access_token_${actor}}}`}]};
  const request = {method:e.method,header:[{key:'Accept',value:'application/json'}],auth,url:`{{${base}}}${requestPath}${qs?'?'+qs:''}`,description:`Endpoint: ${id}\n\n${e.description || e.name}\n\nSource: ${e.source || e.service}`};
  if (opts.body !== undefined || e.body !== undefined) {
    request.header.push({key:'Content-Type',value:'application/json'});
    request.body = {mode:'raw',raw:JSON.stringify(actorMap(opts.body ?? e.body,actor),null,2),options:{raw:{language:'json'}}};
  }
  if (e.formData || e.formdata) request.body={mode:'formdata',formdata:e.formData || e.formdata};
  let captures = opts.captures ?? e.captures ?? [];
  if (opts.capture === false) captures=[];
  captures = captures.map(c => ({...c,variable:c.variable.replace(/_a$/,`_${actor}`).replace('user_a_id',`user_${actor}_id`)}));
  let tests = `const expected = ${JSON.stringify(statuses)};
pm.test('HTTP status '+expected.join('/'),()=>pm.expect(pm.response.code).to.be.oneOf(expected));
let body;
if (pm.response.text().trim()) { try { body=pm.response.json(); } catch(error) { pm.test('JSON response',()=>{throw error;}); } }
const data=body && body.data;
const ev=key=>pm.environment.get(key);
if (pm.response.code >=200 && pm.response.code<300 && body && typeof body==='object' && Object.prototype.hasOwnProperty.call(body,'success')) pm.test('Success envelope',()=>pm.expect(body.success).to.eql(true));
if (pm.response.code>=400 && body && Object.prototype.hasOwnProperty.call(body,'success')) pm.test('Error envelope',()=>pm.expect(body.success).to.eql(false));
if (expected.includes(pm.response.code) && pm.response.code<300) {
  for (const capture of ${JSON.stringify(captures)}) { const value=capture.path.split('.').reduce((v,k)=>v==null?undefined:v[k],body); pm.test('Capture '+capture.variable,()=>pm.expect(value).not.to.eql(undefined)); if(value!==undefined && value!==null) pm.environment.set(capture.variable,value); }
}
${opts.tests || ''}`;
  const item={id:uuid(`${id}:${sequence++}:${opts.name||''}`),name:opts.catalog?`[${id}] ${e.name}`:opts.name||e.name,request,event:[event('test',tests)]};
  if(opts.pre) item.event.unshift(event('prerequest',opts.pre));
  return item;
}
const assertion = (name, expression) => `pm.test(${JSON.stringify(name)},()=>pm.expect(${expression}).to.eql(true));`;
const eq = (name, left, right) => `pm.test(${JSON.stringify(name)},()=>pm.expect(${left}).to.eql(${right}));`;
const capture = (variable,p='data.id') => [{variable,path:p}];
const folder = (name,item,extra={}) => ({name,item,...extra});
const groups = new Map();
for(const e of endpoints){if(!groups.has(e.folder))groups.set(e.folder,[]);groups.get(e.folder).push(make(e.id,{catalog:true}));}
const catalog = {info:{_postman_id:uuid('kirenz-api'),name:'Kirenz | API Reference',schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',description:'Source-derived HTTP API catalogue for Thaonguyen0507/mss301-kirenz, source tree 5e439abc2ded3f0efdefbce0941f6ce07dd0bbcf. Import the local environment. Run the Integration collection first to create disposable actors/IDs. Internal endpoints use direct service URLs; media/Google/LiveKit provider requests need their own credentials. This catalogue is for individual requests, not an ordered destructive full run.'},event:[event('prerequest',init)],item:[...groups].map(([name,item])=>folder(name,item))};
const flows=[];
const bootstrap=[];
for(const actor of ['a','b','outsider']){
  bootstrap.push(make('identity_register',{actor,name:`Register disposable ${actor}`,captures:capture(`user_${actor}_id`),tests:assertion('OTP accepted by local mailbox','data.otpSent===true')}));
  bootstrap.push(make('identity_login',{actor,name:`Login ${actor}`}));
  bootstrap.push(make('identity_current_profile',{actor,name:`Identity profile ${actor}`,tests:eq('Own UUID','data.id',`ev('user_${actor}_id')`)}));
}
bootstrap.push({id:uuid('mailbox-otp'),name:'Read OTP from local Brevo stub (test infrastructure)',request:{method:'GET',auth:{type:'noauth'},url:'{{mailbox_url}}/messages?to={{email_a}}'},event:[event('test',`pm.test('Mailbox HTTP200',()=>pm.response.to.have.status(200)); const messages=pm.response.json().messages; const html=messages[messages.length-1]?.htmlContent||''; const match=html.match(/>\\s*(\\d{6})\\s*</); pm.test('Generated OTP captured',()=>pm.expect(match).not.to.eql(null)); if(match) pm.environment.set('otp_code',match[1]);`)]});
bootstrap.push(make('identity_verify_otp',{body:{email:'{{email_a}}',otp:'{{otp_code}}'},name:'Verify actual generated OTP through Redis'}));
bootstrap.push(make('identity_current_profile',{name:'Email verification persisted',tests:eq('Verified flag','data.emailVerified','true')}));
bootstrap.push(make('identity_refresh',{name:'Refresh actual refresh token'}));
flows.push(folder('00 Bootstrap | Identity → Kafka → local email/Redis',bootstrap));
flows.push(folder('01 Authentication and input boundaries',[
  make('identity_current_profile',{auth:'none',statuses:[401],capture:false,name:'Anonymous profile rejected'}),
  make('identity_login',{body:{email:'{{email_a}}',password:'incorrect-local-test-password'},statuses:[401],capture:false,name:'Wrong password rejected'}),
  make('identity_register',{body:{email:'invalid',username:'x',password:'x',displayName:''},statuses:[400],capture:false,name:'Registration validation'}),
  make('identity_refresh',{body:{refreshToken:'not.a.valid.jwt'},statuses:[401],capture:false,name:'Malformed refresh token rejected'}),
  make('identity_verify_otp',{body:{email:'{{email_b}}',otp:'000000'},statuses:[400],capture:false,name:'Wrong OTP rejected'}),
  make('identity_update_profile',{name:'Update profile used by other services',tests:eq('Profile display name','data.displayName',"ev('profile_display_name')")}),
  make('user_search',{actor:'b',query:[{key:'q',value:'{{username_a}}'}],name:'User search enriches from Identity',tests:assertion('Search includes actor A',"JSON.stringify(data||null).includes(ev('user_a_id'))")}),
  make('identity_refresh',{body:{refreshToken:'{{access_token_a}}'},statuses:[401],capture:false,name:'SECURITY | Access token cannot serve as refresh token'})
]));
flows.push(folder('02 Friendship | User ↔ Identity Feign',[
  make('user_send_friend_request',{name:'A requests friendship with B'}),
  make('user_accept_friend_request',{actor:'outsider',statuses:[404],capture:false,name:'Outsider cannot accept another request'}),
  make('user_incoming_requests',{actor:'b',name:'B sees incoming request',tests:assertion('Request belongs to current fixture',"JSON.stringify(data).includes(ev('friend_request_id'))")}),
  make('user_accept_friend_request',{actor:'b',name:'B accepts A request'}),
  make('user_friend_status',{path:'/api/friends/status/{{user_b_id}}',tests:eq('Relationship became FRIENDS','data.status',"'FRIENDS'")}),
  make('user_list_friends',{actor:'b',name:'Feign returns updated A profile, no fallback',tests:`const friend=Array.isArray(data)&&data.find(f=>f.friendId===ev('user_a_id')); ${assertion('Friend exists','!!friend')} ${eq('Identity username','friend && friend.username',"ev('username_a')")} ${eq('Updated Identity display name','friend && friend.displayName',"ev('profile_display_name')")}`}),
  make('user_mutual_friends',{path:'/api/users/{{user_b_id}}/mutual-friends'}),
  make('user_send_friend_request',{body:{receiverId:'{{user_a_id}}'},statuses:[400],capture:false,name:'Self friendship rejected'}),
  make('user_update_privacy',{actor:'b',body:{profileVisibility:'PUBLIC',postVisibility:'PUBLIC',allowDirectMessages:false,showOnlineStatus:true},name:'B restricts direct messages'}),
  make('user_can_message',{name:'Friend still allowed to message',tests:eq('Friend permission','data','true')}),
  make('user_can_message',{actor:'outsider',name:'Nonfriend denied by User privacy',tests:eq('Nonfriend permission','data','false')}),
  make('user_update_privacy',{actor:'b',name:'Restore permissive fixture privacy'})
]));
const pollNotifications=`const rows=Array.isArray(data)?data:[]; const found=rows.find(n=>n.type==='POST_COMMENT' && n.receiverId===ev('user_a_id') && n.targetId===ev('post_id') && n.actorId===ev('user_b_id')); const key='notification_poll'; const attempt=Number(pm.variables.get(key)||0); if(!found && attempt<25){pm.variables.set(key,attempt+1);pm.execution.setNextRequest(pm.info.requestId);}else{pm.variables.unset(key);${assertion('Kafka persisted receiver notification','!!found')} if(found)pm.environment.set('notification_id',found.id);}`;
flows.push(folder('03 Social → Kafka → Notifications + Feign profiles',[
  make('social_create_post',{tests:eq('Author enriched from Identity','data.author.displayName',"ev('profile_display_name')")}),
  make('social_public_post',{auth:'none',tests:eq('Public detail UUID','data.id',"ev('post_id')")}),
  make('social_update_post',{actor:'b',statuses:[403],capture:false,name:'Nonowner cannot modify post'}),
  make('social_create_comment',{actor:'b',name:'B comment emits notification'}),
  make('notification_list',{name:'Poll A notification from real Kafka',tests:pollNotifications}),
  make('notification_unread_count'),
  make('notification_get',{tests:eq('Notification receiver','data.receiverId',"ev('user_a_id')")}),
  make('notification_get',{actor:'outsider',statuses:[401,403,404],capture:false,name:'SECURITY | Outsider notification access rejected',tests:assertion('No foreign notification data','!data')}),
  make('notification_mark_read',{tests:eq('Read persisted','data.isRead','true')}),
  make('social_update_comment',{actor:'outsider',statuses:[403],capture:false,name:'Nonowner cannot edit comment'}),
  make('social_react_post',{actor:'b',tests:eq('Current reaction LIKE','data.currentUserReaction',"'LIKE'")+eq('One reaction','data.totalCount','1')}),make('social_update_post_reaction',{actor:'b',tests:eq('Reaction changed to LOVE','data.currentUserReaction',"'LOVE'")+eq('Updating does not duplicate','data.totalCount','1')}),make('social_list_post_reactions'),
  make('social_react_comment',{tests:eq('Comment reaction LIKE','data.currentUserReaction',"'LIKE'")}),make('social_update_comment_reaction',{tests:eq('Comment reaction changed','data.currentUserReaction',"'LOVE'")}),make('social_list_comment_reactions'),make('social_remove_comment_reaction',{tests:eq('Comment reaction removed','data.totalCount','0')}),
  make('social_share_post',{actor:'b',tests:eq('Share keeps original post','data.originalPostId',"ev('post_id')")+eq('Share author is B','data.author.id',"ev('user_b_id')")}),
  make('social_feed_page',{query:[{key:'limit',value:'2'}],tests:assertion('Cursor page has items',"Array.isArray(data.items) && typeof data.hasMore==='boolean'")}),
  make('social_explore',{query:[{key:'q',value:'kirenztest'},{key:'limit',value:'5'}]}),make('social_trending'),
  make('social_feed_page',{query:[{key:'limit',value:'0'}],statuses:[400],capture:false,name:'Invalid paging limit rejected'})
]));
flows.push(folder('04 Privacy and blocking across User/Social/Chat',[
  make('social_create_post',{body:{content:'Private fixture {{run_id}}',privacy:'ONLY_ME',media:[],taggedUserIds:[]},captures:capture('private_post_id'),name:'Create ONLY_ME post'}),
  make('social_get_post',{path:'/api/posts/{{private_post_id}}',actor:'b',statuses:[404],capture:false,name:'Nonowner cannot view ONLY_ME'}),
  make('social_public_post',{path:'/api/posts/public/{{private_post_id}}',auth:'none',statuses:[404],capture:false,name:'Anonymous cannot view ONLY_ME'}),
  make('social_create_post',{body:{content:'Friends fixture {{run_id}}',privacy:'FRIENDS',media:[],taggedUserIds:[]},captures:capture('friends_post_id'),name:'Create FRIENDS post'}),
  make('social_get_post',{path:'/api/posts/{{friends_post_id}}',actor:'b',name:'Friend reads FRIENDS through User Feign'}),
  make('social_get_post',{path:'/api/posts/{{friends_post_id}}',actor:'outsider',statuses:[404],capture:false,name:'Nonfriend cannot view FRIENDS'}),
  make('user_block',{name:'A blocks B and removes friendship'}),
  make('user_friend_status',{path:'/api/friends/status/{{user_b_id}}',tests:eq('Blocked state','data.status',"'BLOCKED'")}),
  make('social_get_post',{actor:'b',statuses:[404],capture:false,name:'Blocked B cannot read A PUBLIC post'}),
  make('social_create_comment',{actor:'b',statuses:[403,404],capture:false,name:'SECURITY | Blocked B cannot comment on A post'}),
  make('chat_conversation_direct',{actor:'b',path:'/api/conversations/direct/{{user_a_id}}',statuses:[403],capture:false,name:'Blocked B cannot start chat with A'}),
  make('user_unblock'),make('user_send_friend_request'),make('user_accept_friend_request',{actor:'b',name:'Restore friendship for remaining fixtures'})
]));
flows.push(folder('05 Chat REST + Identity/User Feign + Redis calls',[
  make('chat_conversation_direct',{name:'Create A/B direct conversation',tests:assertion('Both participants enriched',"JSON.stringify(data).includes(ev('user_b_id')) && JSON.stringify(data).includes(ev('user_a_id'))")}),
  make('chat_conversation_direct',{capture:false,name:'Direct creation is idempotent',tests:eq('Same direct conversation','data.id',"ev('conversation_id')")}),
  make('chat_conversation_get'),make('chat_message_history'),
  make('chat_message_history',{actor:'outsider',statuses:[400,403,404],capture:false,name:'Outsider cannot read history'}),
  make('chat_message_read',{actor:'outsider',statuses:[403,404],capture:false,name:'SECURITY | Outsider cannot mark another chat read'}),
  make('chat_conversation_nickname'),make('chat_presence_status'),make('chat_conversation_create'),make('chat_conversation_rename'),make('chat_conversation_promote'),
  make('chat_conversation_delete',{actor:'outsider',statuses:[400,403,404],capture:false,name:'Nonadmin cannot delete group'}),
  make('chat_call_start'),
  make('chat_call_get',{actor:'outsider',statuses:[403],capture:false,name:'Outsider cannot access call'}),
  make('chat_call_video_access',{statuses:[409],capture:false,name:'Media access before acceptance rejected'}),
  make('chat_call_accept',{actor:'b',tests:eq('Call accepted','data.status',"'ACCEPTED'")}),
  make('chat_call_heartbeat'),make('chat_call_active',{actor:'b'}),
  make('chat_call_video_access',{statuses:[503],capture:false,name:'Provider-unavailable failure is explicit (isolated mode)'}),
  make('chat_call_end',{tests:eq('Both sides see ended state','data.status',"'ENDED'")}),
  make('chat_call_active',{actor:'b',tests:eq('No active call after hangup','data','null')}),
  make('chat_call_start',{name:'New call for decline'}),make('chat_call_decline',{actor:'b',tests:eq('Declined call ended','data.status',"'ENDED'")})
]));
const adminSkip=event('prerequest',"if (!pm.environment.get('admin_access_token')) {console.warn('SKIPPED: admin_access_token is required; npm test prepares an isolated local admin');pm.execution.skipRequest();}");
flows.push(folder('06 Admin → Identity/Social → Kafka audit workflows',[
  make('admin_ping'),make('admin_user_summary'),make('admin_user_detail'),make('admin_dashboard_summary',{tests:eq('No partial fallback','data.partialData','false')}),make('admin_dashboard_user_growth',{tests:eq('Identity growth available','data.partialData','false')}),make('admin_dashboard_content_growth',{tests:eq('Social growth available','data.partialData','false')}),
  make('admin_create_report',{body:{targetType:'USER',targetId:'{{user_b_id}}',reason:'OTHER',description:'Disposable user report {{run_id}}'}}),
  make('admin_my_reports'),make('admin_report_detail'),make('admin_report_review'),make('admin_report_dismiss',{tests:eq('Report dismissed','data.status',"'DISMISSED'")}),
  make('admin_create_report',{body:{targetType:'POST',targetId:'{{post_id}}',reason:'OTHER',description:'Integration content report {{run_id}}'},capture:false,name:'REGRESSION | User can report POST through admin→social'}),
  make('admin_user_warn'),make('admin_target_action_detail',{actor:'b',tests:assertion('Private admin note is hidden',"!Object.prototype.hasOwnProperty.call(data||{},'adminNote')")}),
  make('admin_user_ban'),make('identity_login',{actor:'b',statuses:[403],capture:false,name:'Identity rejects banned B login'}),make('admin_user_unban'),make('identity_login',{actor:'b',name:'B login restored after unban'}),make('admin_user_actions'),make('admin_action_search'),
  make('admin_dashboard_summary',{actor:'a',auth:'user',statuses:[403],capture:false,name:'USER cannot access admin dashboard'})
],{event:[adminSkip]}));
flows.push(folder('99 Cleanup | only run-scoped API fixtures',[
  make('social_remove_post_reaction',{actor:'b'}),make('social_delete_comment',{actor:'b'}),
  make('social_delete_post',{actor:'b',path:'/api/posts/{{shared_post_id}}',name:'Delete B share'}),
  make('social_delete_post',{path:'/api/posts/{{private_post_id}}',name:'Delete ONLY_ME fixture'}),make('social_delete_post',{path:'/api/posts/{{friends_post_id}}',name:'Delete FRIENDS fixture'}),make('social_delete_post',{name:'Delete PUBLIC fixture'}),
  make('chat_conversation_delete'),make('user_unfriend'),make('notification_mark_all_read')
]));
const integration={info:{_postman_id:uuid('kirenz-integration'),name:'Kirenz | Integration & cross-service regression',schema:catalog.info.schema,description:'Ordered, real-Docker HTTP integration tests. Fresh run-scoped actors only. Brevo is replaced by a local mailbox stub; databases, Kafka, Redis, Eureka and service-to-service Feign calls are real. Default LiveKit is intentionally unreachable: call orchestration is tested, media/provider success is not. SECURITY/REGRESSION cases assert the intended rejection/behavior and may expose existing application bugs. npm test also prepares a local admin and emits redacted JSON/JUnit reports. Never run against production.'},event:[event('prerequest',init)],item:flows};
const defaults={base_url:'http://localhost:18080',identity_base_url:'http://localhost:18081',user_base_url:'http://localhost:18082',social_base_url:'http://localhost:18083',chat_base_url:'http://localhost:18084',notification_base_url:'http://localhost:18085',admin_base_url:'http://localhost:18086',discovery_base_url:'http://localhost:18761',mailbox_url:'http://localhost:18090',target_type:'POST',query:'kirenz_it_',profile_display_name:'',profile_bio:'',run_id:'',admin_access_token:'',run_livekit_cloud:'false'};
const variables=new Set(Object.keys(defaults));
for(const text of [JSON.stringify(catalog),JSON.stringify(integration)]) for(const m of text.matchAll(/{{([^{}]+)}}/g)) if(!m[1].startsWith('$'))variables.add(m[1]);
for(const e of endpoints)for(const c of e.captures||[])variables.add(c.variable);
for(const actor of ['a','b','outsider'])for(const k of ['email','username','password','display_name','access_token','refresh_token'])variables.add(`${k}_${actor}`);
for(const k of ['user_a_id','user_b_id','user_outsider_id','private_post_id','friends_post_id','from_date','to_date','suspended_until','otp_code','admin_email','admin_password'])variables.add(k);
const values=[...variables].sort().map(key=>({key,value:defaults[key]??'',enabled:true,type:/token|password|secret|otp_code/.test(key)?'secret':'default'}));
const environment={id:uuid('kirenz-local-env'),name:'Kirenz | isolated Docker local',values,_postman_variable_scope:'environment',_postman_exported_using:'Kirenz source-derived test kit'};
catalog.variable=values.map(v=>({key:v.key,value:v.value,type:'string'}));
integration.variable=catalog.variable;
for(const [file,data] of [['Kirenz-API.postman_collection.json',catalog],['Kirenz-Integration.postman_collection.json',integration],['Kirenz-Local.postman_environment.json',environment]])fs.writeFileSync(path.join(root,file),JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({catalogRequests:endpoints.length,integrationRequests:flows.reduce((n,f)=>n+f.item.length,0),folders:flows.length,variables:values.length}));
