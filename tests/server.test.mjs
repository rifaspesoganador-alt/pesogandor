import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
test('reservations are exclusive and admin access is protected',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-test-'));const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3097',ADMIN_PASSWORD:'test-only-strong-secret'}});
try{
await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
const base='http://localhost:3097';const post=(path,data,extra={})=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
assert.equal((await fetch(base+'/')).status,200);
assert.equal((await fetch(base+'/',{method:'HEAD'})).status,200);
assert.equal((await fetch(base+'/.env')).status,404);
assert.equal((await fetch(base+'/data/peso.db')).status,404);
assert.equal((await fetch(base+'/constructor')).status,404);
assert.equal((await fetch(base+'/',{method:'DELETE'})).status,405);
assert.equal((await post('/api/reservations',null)).status,400);
assert.equal((await post('/api/reservations',{numbers:'123'})).status,400);
assert.equal((await post('/api/reservations',{}, {'Content-Type':'text/plain'})).status,415);
assert.equal((await post('/api/reservations',{name:'x'.repeat(9000)})).status,413);
assert.equal((await fetch(base+'/api/admin/reservations')).status,401);
assert.equal((await post('/api/reservations',{name:'Test User',phone:'5512345678',numbers:[5]},{Origin:'https://example.com'})).status,403);
const data={name:'Test User',phone:'5512345678',numbers:[5]};const responses=await Promise.all([post('/api/reservations',data),post('/api/reservations',data)]);assert.deepEqual(responses.map(x=>x.status).sort(),[201,409]);
const reservation=await responses.find(x=>x.status===201).json();const login=await post('/api/login',{password:'test-only-strong-secret'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
assert.equal((await post('/api/admin/confirm',{id:reservation.id},{Cookie:cookie})).status,200);
assert.equal((await post('/api/admin/confirm',{id:reservation.id},{Cookie:cookie})).status,409);
const records=await (await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie}})).json();assert.equal(records[0].status,'paid');
assert.equal((await post('/api/admin/confirm',{id:{}},{Cookie:cookie})).status,400);
assert.equal((await post('/api/admin/logout',{}, {Cookie:cookie,Origin:'https://evil.example'})).status,403);
assert.equal((await post('/api/admin/logout',{}, {Cookie:cookie})).status,200);
assert.equal((await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie}})).status,401);
const ten={name:'Pending User',phone:'5512345679',numbers:[10,11,12,13,14,15,16,17,18,19]};
assert.equal((await post('/api/reservations',ten)).status,201);
assert.equal((await post('/api/reservations',{...ten,numbers:[20]})).status,429);
for(let i=0;i<4;i++)assert.equal((await post('/api/login',{password:'wrong'})).status,401);
const throttled=await post('/api/login',{password:'wrong'}, {'X-Forwarded-For':'1.2.3.4'});assert.equal(throttled.status,429);assert.ok(Number(throttled.headers.get('retry-after'))>0);
}finally{proc.kill();await new Promise(r=>proc.once('exit',r));rmSync(dir,{recursive:true,force:true});}
});
test('production cookies, headers, and persisted login limits',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-prod-test-'));
const env={...process.env,PORT:'3098',PUBLIC_ORIGIN:'https://pesoganador.com',NODE_ENV:'production',ADMIN_PASSWORD:'test-only-strong-secret'};
let proc;
async function start(){proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env});await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});}
async function stop(){if(proc&&proc.exitCode===null){const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;}}
const base='http://localhost:3098';const post=password=>fetch(base+'/api/login',{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({password})});
try{
await start();const page=await fetch(base+'/');assert.equal(page.status,200);assert.equal(page.headers.get('strict-transport-security'),'max-age=31536000');assert.equal(page.headers.get('x-frame-options'),'DENY');
const login=await post(env.ADMIN_PASSWORD);assert.equal(login.status,200);const cookie=login.headers.get('set-cookie');assert.match(cookie,/^__Host-session=/);for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(cookie.includes(flag));
for(let i=0;i<4;i++)assert.equal((await post('wrong')).status,401);
await stop();await start();assert.equal((await post(env.ADMIN_PASSWORD)).status,429);
assert.equal((await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie.split(';')[0]}})).status,401);
}finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
