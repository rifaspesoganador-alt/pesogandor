import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
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
const data={name:'Test User',phone:'5512345678',email:'TEST@example.com',numbers:[5]};const responses=await Promise.all([post('/api/reservations',data),post('/api/reservations',data)]);assert.deepEqual(responses.map(x=>x.status).sort(),[201,409]);
const reservation=await responses.find(x=>x.status===201).json();const login=await post('/api/login',{password:'test-only-strong-secret'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
const lookup=(method,value,folio=reservation.id)=>post('/api/tickets/lookup',{method,value,folio});
assert.equal((await fetch(base+'/api/tickets/lookup')).status,404);
assert.equal((await post('/api/tickets/lookup',{method:'phone',value:data.phone})).status,400);
assert.equal((await lookup('phone',data.phone)).status,200);
assert.equal((await (await lookup('phone',data.phone)).json()).status,'pending');
assert.equal((await lookup('name',' test   USER ')).status,200);
assert.equal((await lookup('email',' Test@Example.COM ')).status,200);
const wrong=await lookup('phone','5599999999');const absent=await lookup('phone',data.phone,'0'.repeat(24));assert.equal(wrong.status,404);assert.equal(absent.status,404);assert.deepEqual(await wrong.json(),await absent.json());
assert.equal((await post('/api/tickets/lookup',{method:'phone',value:data.phone,folio:reservation.id},{Origin:'https://evil.example'})).status,403);
assert.equal((await post('/api/reservations',{...data,numbers:[6],email:123})).status,400);
assert.equal((await post('/api/admin/confirm',{id:reservation.id},{Cookie:cookie})).status,410);
const receipt={type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='};
const submitted=await post('/api/payments/submit',{folio:reservation.id,phone:data.phone,tracking:'PRUEBA123456',receipt});assert.equal(submitted.status,201);const payment=await submitted.json();
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Evidencia de prueba verificada'},{Cookie:cookie})).status,200);
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Reintento'},{Cookie:cookie})).status,409);
const paid=await (await lookup('email','test@example.com')).json();assert.equal(paid.status,'paid');assert.deepEqual(paid.numbers,[5]);assert.equal(paid.demo,true);for(const key of ['name','phone','email','password'])assert.equal(Object.hasOwn(paid,key),false);
assert.equal((await post('/api/admin/confirm',{id:reservation.id},{Cookie:cookie})).status,410);
const records=await (await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie}})).json();assert.equal(records[0].status,'paid');
assert.equal((await post('/api/admin/confirm',{id:{}},{Cookie:cookie})).status,410);
assert.equal((await post('/api/admin/logout',{}, {Cookie:cookie,Origin:'https://evil.example'})).status,403);
assert.equal((await post('/api/admin/logout',{}, {Cookie:cookie})).status,200);
assert.equal((await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie}})).status,401);
const ten={name:'Pending User',phone:'5512345679',numbers:[10,11,12,13,14,15,16,17,18,19]};
assert.equal((await post('/api/reservations',ten)).status,201);
assert.equal((await post('/api/reservations',{...ten,numbers:[20]})).status,429);
for(let i=0;i<4;i++)assert.equal((await post('/api/login',{password:'wrong'})).status,401);
const throttled=await post('/api/login',{password:'wrong'}, {'X-Forwarded-For':'1.2.3.4'});assert.equal(throttled.status,429);assert.ok(Number(throttled.headers.get('retry-after'))>0);
for(let i=0;i<30;i++)await lookup('phone','5599999999');assert.equal((await lookup('phone',data.phone)).status,429);
}finally{proc.kill();await new Promise(r=>proc.once('exit',r));rmSync(dir,{recursive:true,force:true});}
});

test('old databases migrate without losing reservations; expired tickets are not purchases',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-migrate-'));const {mkdirSync}=await import('node:fs');mkdirSync(join(dir,'data'));const db=new DatabaseSync(join(dir,'data/peso.db'));
db.exec('CREATE TABLE reservations(id TEXT PRIMARY KEY,name TEXT,phone TEXT,numbers TEXT,status TEXT,created INTEGER,expires INTEGER); CREATE TABLE tickets(number INTEGER PRIMARY KEY,reservation TEXT);');
const id='a'.repeat(24);db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?)').run(id,'Legacy User','5512345678','[8]','pending',1,2);db.prepare('INSERT INTO tickets VALUES(?,?)').run(8,id);db.close();
const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3099',NODE_ENV:'test',PUBLIC_ORIGIN:'http://localhost:3099'}});
try{await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
const lookup=(method,value)=>fetch('http://localhost:3099/api/tickets/lookup',{method:'POST',headers:{Origin:'http://localhost:3099','Content-Type':'application/json'},body:JSON.stringify({method,value,folio:id})});
const r=await lookup('phone','5512345678');assert.equal(r.status,200);assert.equal((await r.json()).status,'expired');assert.equal((await lookup('name','Legacy User')).status,200);assert.equal((await lookup('email','none@example.com')).status,404);
const raffle=await (await fetch('http://localhost:3099/api/raffle')).json();assert.ok(!raffle.taken.includes(8));
}finally{const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;rmSync(dir,{recursive:true,force:true});}
});
test('production cookies, headers, and persisted login limits',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-prod-test-'));
const env={...process.env,PORT:'3098',PUBLIC_ORIGIN:'https://pesoganador.com',NODE_ENV:'production',ADMIN_PASSWORD:'abcde'};
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

test('lucky machine draws unique available tickets without reserving them',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-lucky-'));
const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3100',NODE_ENV:'test',PUBLIC_ORIGIN:'http://localhost:3100'}});
const base='http://localhost:3100';const post=(path,data,origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
const draw=quantity=>post('/api/tickets/random',{quantity});
try{
await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
for(const quantity of [0,11,-1,1.5,'3',null])assert.equal((await draw(quantity)).status,400);
assert.equal((await post('/api/tickets/random',{quantity:3},'https://evil.example')).status,403);
for(let i=0;i<5;i++){const r=await draw(10);assert.equal(r.status,200);const data=await r.json();assert.equal(data.numbers.length,10);assert.equal(new Set(data.numbers).size,10);assert.ok(data.numbers.every(n=>Number.isInteger(n)&&n>=0&&n<100));}
assert.deepEqual((await (await fetch(base+'/api/raffle')).json()).taken,[]);
for(let batch=0;batch<10;batch++){
const numbers=Array.from({length:10},(_,i)=>batch*10+i);
const reserved=await post('/api/reservations',{name:'Lucky Test',phone:'55'+String(batch).padStart(8,'0'),numbers});assert.equal(reserved.status,201);
if(batch===0){const r=await draw(10);const data=await r.json();assert.ok(data.numbers.every(n=>n>=10));}
}
const empty=await draw(1);assert.equal(empty.status,409);assert.equal((await empty.json()).available,0);
}finally{const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;rmSync(dir,{recursive:true,force:true});}
});

test('admin creates private raffle drafts with validated prices and photos',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-raffles-'));let proc;
const base='http://localhost:3101';const env={...process.env,PORT:'3101',NODE_ENV:'test',PUBLIC_ORIGIN:base,ADMIN_PASSWORD:'raffle-test-only-password'};
async function start(){proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env});await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});}
async function stop(){if(proc&&proc.exitCode===null){const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;}}
let cookie='';const post=(path,data,extra={})=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie,...extra},body:JSON.stringify(data)});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
const input={prize:'Premio de ejemplo',description:'Descripción de prueba',price:'75.25',ticketCount:500,photo:{type:'image/png',base64:png}};
try{await start();assert.equal((await post('/api/admin/raffles',input)).status,401);assert.equal((await fetch(base+'/api/admin/raffles')).status,401);
async function login(){const r=await post('/api/login',{password:env.ADMIN_PASSWORD});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];}await login();
assert.equal((await post('/api/admin/raffles',input,{Origin:'https://evil.example'})).status,403);
const good=await post('/api/admin/raffles',input);assert.equal(good.status,201);const saved=await good.json();assert.equal(saved.status,'draft');
const photoPath=`/api/admin/raffles/${saved.id}/photo`;assert.equal((await fetch(base+photoPath)).status,401);
const photo=await fetch(base+photoPath,{headers:{Cookie:cookie}});assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await photo.arrayBuffer()),Buffer.from(png,'base64'));
for(const change of [{price:'0'},{price:'1.001'},{ticketCount:0},{ticketCount:1.5},{prize:'x'},{description:''},{photo:{type:'image/svg+xml',base64:Buffer.from('<svg/>').toString('base64')}},{photo:{type:'image/jpeg',base64:png}}])assert.equal((await post('/api/admin/raffles',{...input,...change})).status,400);
const noPhoto=await post('/api/admin/raffles',{...input,photo:null});assert.equal(noPhoto.status,201);
const publicRaffle=await (await fetch(base+'/api/raffle')).json();assert.equal(publicRaffle.price,50);assert.equal(publicRaffle.count,100);
await stop();await start();cookie='';await login();const list=await (await fetch(base+'/api/admin/raffles',{headers:{Cookie:cookie}})).json();assert.equal(list.length,2);const draft=list.find(row=>row.id===saved.id);assert.equal(draft.price_cents,7525);assert.equal(draft.ticket_count,500);assert.equal(draft.has_photo,1);assert.equal(Object.hasOwn(draft,'photo'),false);
}finally{await stop();rmSync(dir,{recursive:true,force:true});}
});



test('receipts stay private; uploads need owner data and review never reallocates expired tickets',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-receipts-'));const base='http://localhost:3102';const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3102',NODE_ENV:'test',PUBLIC_ORIGIN:base,ADMIN_PASSWORD:'test-receipt-password'}});
const post=(path,data,cookie='')=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)});
const receipt={type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='};
try{await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
const reserved=await (await post('/api/reservations',{name:'Receipt Test',phone:'5512345678',numbers:[2]})).json();const payload={folio:reserved.id,phone:'5512345678',tracking:'TEST123456',receipt};
assert.equal((await post('/api/payments/submit',{...payload,phone:'5500000000'})).status,404);assert.equal((await post('/api/payments/submit',{...payload,receipt:null})).status,400);
const created=await post('/api/payments/submit',payload);assert.equal(created.status,201);const payment=await created.json();assert.equal((await post('/api/payments/submit',payload)).status,409);
assert.equal((await fetch(base+`/api/admin/payments/${payment.id}/receipt`)).status,401);
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Test reason'})).status,401);
const login=await post('/api/login',{password:'test-receipt-password'});const cookie=login.headers.get('set-cookie').split(';')[0];const receiptResponse=await fetch(base+`/api/admin/payments/${payment.id}/receipt`,{headers:{Cookie:cookie}});assert.equal(receiptResponse.status,200);assert.equal(receiptResponse.headers.get('content-type'),'image/png');
const db=new DatabaseSync(join(dir,'data/peso.db'));db.prepare('UPDATE reservations SET expires=1 WHERE id=?').run(reserved.id);db.close();
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Test reason'},cookie)).status,409);
const raffle=await (await fetch(base+'/api/raffle')).json();assert.ok(!raffle.taken.includes(2));
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'rejected',reason:'Apartado vencido, aclarar prueba'},cookie)).status,200);
const lookup=await (await post('/api/tickets/lookup',{folio:reserved.id,method:'phone',value:'5512345678'})).json();assert.equal(lookup.payment.status,'rejected');assert.equal(lookup.status,'expired');assert.equal(Object.hasOwn(lookup.payment,'receipt'),false);
}finally{const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;rmSync(dir,{recursive:true,force:true});}
});
