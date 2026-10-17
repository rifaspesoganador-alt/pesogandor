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
assert.equal((await fetch(base+'/api/admin/reservations')).status,401);
assert.equal((await post('/api/reservations',{name:'Test User',phone:'5512345678',numbers:[5]},{Origin:'https://example.com'})).status,403);
const data={name:'Test User',phone:'5512345678',numbers:[5]};const responses=await Promise.all([post('/api/reservations',data),post('/api/reservations',data)]);assert.deepEqual(responses.map(x=>x.status).sort(),[201,409]);
const reservation=await responses.find(x=>x.status===201).json();const login=await post('/api/login',{password:'test-only-strong-secret'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
assert.equal((await post('/api/admin/confirm',{id:reservation.id},{Cookie:cookie})).status,200);
assert.equal((await post('/api/admin/confirm',{id:reservation.id},{Cookie:cookie})).status,409);
const records=await (await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie}})).json();assert.equal(records[0].status,'paid');
}finally{proc.kill();await new Promise(r=>proc.once('exit',r));rmSync(dir,{recursive:true,force:true});}
});
