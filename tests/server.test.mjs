import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const mx=ms=>new Date(ms-21600000).toISOString().slice(0,16)+':00-06:00';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
const bank={bank:'Banco Uno',holder:'Titular de Pruebas',clabe:'012345678901234567',account:'',card:'',whatsapp:'',instructions:'También aceptamos depósito en OXXO.',holdHours:1};
// Saves payment details, creates a raffle whose sale window includes now and puts it on sale.
async function openSale(base,cookie,{ticketCount=100,price='50'}={}){
const post=(path,data)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)});
assert.equal((await post('/api/admin/payment-settings',bank)).status,200);
const now=Date.now();const created=await post('/api/admin/raffles',{prize:'Premio',description:'Descripción',price,ticketCount,startsAt:mx(now-3600000),endsAt:mx(now+86400000),drawAt:mx(now+172800000),photo:null});assert.equal(created.status,201);const {id}=await created.json();
assert.equal((await post('/api/admin/raffles/status',{id,status:'active'})).status,200);return id;
}
const isTaken=(raffle,n)=>(Buffer.from(raffle.taken,'base64')[n>>3]>>(n&7))&1;
async function adminCookie(base,password){const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({password})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
test('reservations are exclusive and admin access is protected',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-test-'));const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3097',ADMIN_PASSWORD:'test-only-strong-secret'}});
try{
await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
const base='http://localhost:3097';const post=(path,data,extra={})=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
assert.equal((await post('/api/reservations',{name:'Test User',phone:'5512345678',numbers:[5]})).status,409);
const cookie=await adminCookie(base,'test-only-strong-secret');await openSale(base,cookie);
assert.equal((await fetch(base+'/')).status,200);
assert.equal((await fetch(base+'/',{method:'HEAD'})).status,200);
assert.equal((await fetch(base+'/.env')).status,404);
const css=await fetch(base+'/style.css');const etag=css.headers.get('etag');assert.ok(etag);assert.equal(css.headers.get('cache-control'),'no-cache');assert.equal((await fetch(base+'/style.css',{headers:{'If-None-Match':etag}})).status,304);
const logo=await fetch(base+'/logo-small.png');assert.equal(logo.status,200);assert.equal(logo.headers.get('cache-control'),'public, max-age=604800');assert.equal((await fetch(base+'/api/raffle')).headers.get('cache-control'),'no-store');
assert.equal((await fetch(base+'/data/peso.db')).status,404);
assert.equal((await fetch(base+'/constructor')).status,404);
assert.equal((await fetch(base+'/',{method:'DELETE'})).status,405);
assert.equal((await post('/api/reservations',null)).status,400);
assert.equal((await post('/api/reservations',{numbers:'123'})).status,400);
assert.equal((await post('/api/reservations',{}, {'Content-Type':'text/plain'})).status,415);
assert.equal((await post('/api/reservations',{name:'x'.repeat(9000)})).status,413);
assert.equal((await fetch(base+'/api/admin/reservations')).status,401);
assert.equal((await post('/api/reservations',{name:'Test User',phone:'5512345678',numbers:[5]},{Origin:'https://example.com'})).status,403);
assert.equal((await post('/api/reservations',{name:'Test User',phone:'5512345678',numbers:[100]})).status,400);
const data={name:'Test User',phone:'5512345678',email:'TEST@example.com',numbers:[5]};const responses=await Promise.all([post('/api/reservations',data),post('/api/reservations',data)]);assert.deepEqual(responses.map(x=>x.status).sort(),[201,409]);
const reservation=await responses.find(x=>x.status===201).json();assert.equal(reservation.amount_cents,5000);
assert.equal(Object.hasOwn(reservation,'id'),false);assert.deepEqual(reservation.numbers,[5]);
const lookup=(method,value)=>post('/api/tickets/lookup',{method,value});
assert.equal((await fetch(base+'/api/tickets/lookup')).status,404);
assert.equal((await post('/api/tickets/lookup',{method:'folio',value:'x'})).status,400);assert.equal((await lookup('phone','55123')).status,400);
assert.equal((await lookup('phone',data.phone)).status,200);
const pending=(await (await lookup('phone',data.phone)).json()).results;assert.equal(pending.length,1);assert.equal(pending[0].status,'pending');assert.equal(pending[0].prize,'Premio');assert.equal(pending[0].amount_cents,5000);
assert.equal((await lookup('name',' test   USER ')).status,200);
assert.equal((await lookup('email',' Test@Example.COM ')).status,200);
assert.equal((await lookup('phone','5599999999')).status,404);assert.equal((await lookup('name','Otra Persona')).status,404);
assert.equal((await post('/api/tickets/lookup',{method:'phone',value:data.phone},{Origin:'https://evil.example'})).status,403);
assert.equal((await post('/api/reservations',{...data,numbers:[6],email:123})).status,400);
// A second reservation from the same phone joins the pending one and the total grows.
const more=await (await post('/api/reservations',{...data,numbers:[6]})).json();assert.deepEqual(more.numbers,[5,6]);assert.equal(more.amount_cents,10000);assert.equal((await (await lookup('phone',data.phone)).json()).results.length,1);
assert.equal((await post('/api/admin/confirm',{id:'x'},{Cookie:cookie})).status,410);
const receipt={type:'image/png',base64:png};
assert.equal((await post('/api/payments/submit',{phone:'5599999999',tracking:'MBAN0123456',receipt})).status,404);
const submitted=await post('/api/payments/submit',{phone:data.phone,tracking:'MBAN0123456',receipt});assert.equal(submitted.status,201);const payment=await submitted.json();
assert.equal((await post('/api/reservations',{...data,numbers:[7]})).status,409);
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Depósito verificado'},{Cookie:cookie})).status,200);
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Reintento'},{Cookie:cookie})).status,409);
assert.equal((await post('/api/payments/submit',{phone:data.phone,tracking:'MBAN0999999',receipt})).status,409);
const paid=(await (await lookup('email','test@example.com')).json()).results[0];assert.equal(paid.status,'paid');assert.deepEqual(paid.numbers,[5,6]);for(const key of ['id','folio','name','phone','email','password','demo'])assert.equal(Object.hasOwn(paid,key),false);
const raffles=await (await fetch(base+'/api/admin/raffles',{headers:{Cookie:cookie}})).json();assert.equal(raffles[0].sold,2);
const records=await (await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie}})).json();assert.equal(records[0].status,'paid');assert.equal(records[0].prize,'Premio');
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
db.exec("CREATE TABLE raffles(id TEXT PRIMARY KEY,prize TEXT NOT NULL,description TEXT NOT NULL,price_cents INTEGER NOT NULL,ticket_count INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',photo BLOB,photo_type TEXT,created INTEGER NOT NULL); INSERT INTO raffles VALUES('"+'b'.repeat(24)+"','Viejo','Desc',100,10,'published_demo',NULL,NULL,1);");
const id='a'.repeat(24);db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?)').run(id,'Legacy User','5512345678','[8]','pending',1,2);db.prepare('INSERT INTO tickets VALUES(?,?)').run(8,id);db.close();
const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3099',NODE_ENV:'test',PUBLIC_ORIGIN:'http://localhost:3099'}});
try{await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
const lookup=(method,value)=>fetch('http://localhost:3099/api/tickets/lookup',{method:'POST',headers:{Origin:'http://localhost:3099','Content-Type':'application/json'},body:JSON.stringify({method,value})});
const r=await lookup('phone','5512345678');assert.equal(r.status,200);assert.equal((await r.json()).results[0].status,'expired');assert.equal((await lookup('name','Legacy User')).status,200);assert.equal((await lookup('email','none@example.com')).status,404);
const raffle=await (await fetch('http://localhost:3099/api/raffle')).json();assert.equal(raffle.raffle,null);assert.equal(raffle.open,false);
const check=new DatabaseSync(join(dir,'data/peso.db'));assert.equal(check.prepare('SELECT status FROM raffles').get().status,'draft');check.close();
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
const secondLogin=await post(env.ADMIN_PASSWORD);assert.equal(secondLogin.status,200);const secondCookie=secondLogin.headers.get('set-cookie').split(';')[0];assert.notEqual(secondCookie,cookie.split(';')[0]);
assert.equal((await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie.split(';')[0]}})).status,200);
assert.equal((await fetch(base+'/api/admin/logout',{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN,'Content-Type':'application/json',Cookie:secondCookie},body:'{}'})).status,200);
assert.equal((await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie.split(';')[0]}})).status,200);
for(let i=0;i<3;i++)assert.equal((await post('wrong')).status,401);
await stop();await start();assert.equal((await post(env.ADMIN_PASSWORD)).status,429);
assert.equal((await fetch(base+'/api/admin/reservations',{headers:{Cookie:cookie.split(';')[0]}})).status,401);
}finally{await stop();rmSync(dir,{recursive:true,force:true});}
});

test('lucky machine draws unique available tickets without reserving them',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-lucky-'));
const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3100',NODE_ENV:'test',PUBLIC_ORIGIN:'http://localhost:3100',ADMIN_PASSWORD:'lucky-test-password'}});
const base='http://localhost:3100';const post=(path,data,origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
const draw=quantity=>post('/api/tickets/random',{quantity});
try{
await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
assert.equal((await draw(3)).status,409);
await openSale(base,await adminCookie(base,'lucky-test-password'));
for(const quantity of [0,11,-1,1.5,'3',null])assert.equal((await draw(quantity)).status,400);
assert.equal((await post('/api/tickets/random',{quantity:3},'https://evil.example')).status,403);
for(let i=0;i<5;i++){const r=await draw(10);assert.equal(r.status,200);const data=await r.json();assert.equal(data.numbers.length,10);assert.equal(new Set(data.numbers).size,10);assert.ok(data.numbers.every(n=>Number.isInteger(n)&&n>=0&&n<100));}
assert.ok(Buffer.from((await (await fetch(base+'/api/raffle')).json()).taken,'base64').every(byte=>byte===0));
for(let batch=0;batch<10;batch++){
const numbers=Array.from({length:10},(_,i)=>batch*10+i);
const reserved=await post('/api/reservations',{name:'Lucky Test',phone:'55'+String(batch).padStart(8,'0'),numbers});assert.equal(reserved.status,201);
if(batch===0){const r=await draw(10);const data=await r.json();assert.ok(data.numbers.every(n=>n>=10));}
}
const empty=await draw(1);assert.equal(empty.status,409);assert.equal((await empty.json()).available,0);
}finally{const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;rmSync(dir,{recursive:true,force:true});}
});

test('admin manages raffles, sale status and payment details',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-raffles-'));let proc;
const base='http://localhost:3101';const env={...process.env,PORT:'3101',NODE_ENV:'test',PUBLIC_ORIGIN:base,ADMIN_PASSWORD:'raffle-test-only-password'};
async function start(){proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env});await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});}
async function stop(){if(proc&&proc.exitCode===null){const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;}}
let cookie='';const post=(path,data,extra={})=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie,...extra},body:JSON.stringify(data)});
const input={prize:'Premio de ejemplo',description:'Descripción de prueba',price:'75.25',ticketCount:500,startsAt:'2030-01-01T09:00:00-06:00',endsAt:'2030-01-10T18:00:00-06:00',drawAt:'2030-01-11T12:00:00-06:00',photo:{type:'image/png',base64:png}};
try{await start();assert.equal((await post('/api/admin/raffles',input)).status,401);assert.equal((await fetch(base+'/api/admin/raffles')).status,401);assert.equal((await post('/api/admin/payment-settings',bank)).status,401);
async function login(){cookie=await adminCookie(base,env.ADMIN_PASSWORD);}await login();
assert.equal((await post('/api/admin/raffles',input,{Origin:'https://evil.example'})).status,403);
const good=await post('/api/admin/raffles',input);assert.equal(good.status,201);const saved=await good.json();assert.equal(saved.status,'draft');
const photoPath=`/api/admin/raffles/${saved.id}/photo`;assert.equal((await fetch(base+photoPath)).status,401);
const photo=await fetch(base+photoPath,{headers:{Cookie:cookie}});assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await photo.arrayBuffer()),Buffer.from(png,'base64'));
for(const change of [{price:'0'},{price:'1.001'},{ticketCount:0},{ticketCount:1.5},{ticketCount:100001},{prize:'x'},{description:''},{startsAt:undefined},{photo:{type:'image/svg+xml',base64:Buffer.from('<svg/>').toString('base64')}},{photo:{type:'image/jpeg',base64:png}}])assert.equal((await post('/api/admin/raffles',{...input,...change})).status,400);
const publicPhotoPath=`/api/raffles/${saved.id}/photo`;assert.equal((await fetch(base+publicPhotoPath)).status,404);assert.equal((await (await fetch(base+'/api/raffle')).json()).raffle,null);
assert.equal((await post('/api/admin/raffles/status',{id:saved.id,status:'active'},{Cookie:''})).status,401);
assert.equal((await post('/api/admin/raffles/status',{id:saved.id,status:'published_demo'})).status,400);
assert.equal((await post('/api/admin/raffles/status',{id:saved.id,status:'active'})).status,200);
let current=await (await fetch(base+'/api/raffle')).json();assert.equal(current.raffle.id,saved.id);assert.equal(current.raffle.price_cents,7525);assert.equal(current.open,false);assert.match(current.message,/datos de pago/);assert.equal((await fetch(base+publicPhotoPath)).status,200);
assert.equal(await (await fetch(base+'/api/payment-info')).json(),null);
for(const change of [{bank:''},{holder:''},{clabe:'123'},{clabe:'',account:'',card:''},{card:'1234'},{whatsapp:'12'},{holdHours:0},{holdHours:73},{holdHours:'2'}])assert.equal((await post('/api/admin/payment-settings',{...bank,...change})).status,400);
assert.equal((await post('/api/admin/payment-settings',{...bank,clabe:'012 345 678 901 234 567'})).status,200);
assert.equal((await (await fetch(base+'/api/payment-info')).json()).clabe,'012345678901234567');
current=await (await fetch(base+'/api/raffle')).json();assert.equal(current.open,false);assert.match(current.message,/aún no comienza/);
assert.equal((await post('/api/reservations',{name:'Early User',phone:'5512345678',numbers:[1]})).status,409);
const second=await (await post('/api/admin/raffles',{...input,photo:null})).json();assert.equal((await post('/api/admin/raffles/status',{id:second.id,status:'active'})).status,409);
assert.equal((await post('/api/admin/raffles/dates',{id:saved.id,startsAt:input.startsAt,endsAt:input.startsAt,drawAt:input.drawAt})).status,400);
assert.equal((await post('/api/admin/raffles/dates',{id:saved.id,startsAt:'2030-02-30T09:00:00-06:00',endsAt:'2030-03-10T09:00:00-06:00',drawAt:'2030-03-11T09:00:00-06:00'})).status,400);
assert.equal((await post('/api/admin/raffles/dates',{id:saved.id,startsAt:input.startsAt,endsAt:input.endsAt,drawAt:'2030-01-12T12:00:00-06:00'})).status,200);
assert.equal((await post('/api/admin/raffles/status',{id:saved.id,status:'closed'})).status,200);assert.equal((await (await fetch(base+'/api/raffle')).json()).raffle,null);assert.equal((await fetch(base+publicPhotoPath)).status,200);
assert.equal((await post('/api/admin/raffles/status',{id:saved.id,status:'draft'})).status,200);assert.equal((await fetch(base+publicPhotoPath)).status,404);
await stop();await start();cookie='';await login();const list=await (await fetch(base+'/api/admin/raffles',{headers:{Cookie:cookie}})).json();assert.equal(list.length,2);const draft=list.find(row=>row.id===saved.id);assert.equal(draft.price_cents,7525);assert.equal(draft.ticket_count,500);assert.equal(draft.has_photo,1);assert.equal(draft.starts_at,Date.parse(input.startsAt));assert.equal(draft.draw_at,Date.parse('2030-01-12T12:00:00-06:00'));assert.equal(Object.hasOwn(draft,'photo'),false);
assert.equal((await (await fetch(base+'/api/admin/payment-settings',{headers:{Cookie:cookie}})).json()).bank,'Banco Uno');
const live=await openSale(base,cookie);assert.equal((await post('/api/reservations',{name:'Live User',phone:'5512345678',numbers:[1]})).status,201);assert.equal((await post('/api/admin/raffles/status',{id:live,status:'draft'})).status,409);
}finally{await stop();rmSync(dir,{recursive:true,force:true});}
});

test('receipts stay private; uploads need owner data and review never reallocates expired tickets',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-receipts-'));const base='http://localhost:3102';const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3102',NODE_ENV:'test',PUBLIC_ORIGIN:base,ADMIN_PASSWORD:'test-receipt-password'}});
const post=(path,data,cookie='')=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)});
const receipt={type:'image/png',base64:png};
try{await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
const cookie=await adminCookie(base,'test-receipt-password');await openSale(base,cookie);
assert.equal((await post('/api/reservations',{name:'Receipt Test',phone:'5512345678',numbers:[2]})).status,201);const payload={phone:'5512345678',tracking:'TEST123456',receipt};
assert.equal((await post('/api/payments/submit',{...payload,phone:'5500000000'})).status,404);assert.equal((await post('/api/payments/submit',{...payload,receipt:null})).status,400);
assert.equal((await post('/api/payments/submit',{...payload,receipt:{type:'application/pdf',base64:Buffer.from('not a pdf at all, nope').toString('base64')}})).status,400);
const created=await post('/api/payments/submit',payload);assert.equal(created.status,201);const payment=await created.json();assert.equal((await post('/api/payments/submit',payload)).status,409);
let db=new DatabaseSync(join(dir,'data/peso.db'));assert.ok(db.prepare('SELECT expires FROM reservations WHERE phone=?').get('5512345678').expires>Date.now()+40*3600000);db.close();
assert.equal((await fetch(base+`/api/admin/payments/${payment.id}/receipt`)).status,401);
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Test reason'})).status,401);
const receiptResponse=await fetch(base+`/api/admin/payments/${payment.id}/receipt`,{headers:{Cookie:cookie}});assert.equal(receiptResponse.status,200);assert.equal(receiptResponse.headers.get('content-type'),'image/png');
const listed=await (await fetch(base+'/api/admin/payments',{headers:{Cookie:cookie}})).json();assert.equal(listed[0].amount_cents,5000);assert.equal(Object.hasOwn(listed[0],'receipt'),false);
db=new DatabaseSync(join(dir,'data/peso.db'));db.prepare('UPDATE reservations SET expires=1 WHERE phone=?').run('5512345678');db.close();
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Test reason'},cookie)).status,409);
const raffle=await (await fetch(base+'/api/raffle')).json();assert.equal(isTaken(raffle,2),0);
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'rejected',reason:'Apartado vencido, aclarar pago'},cookie)).status,200);
const lookup=(await (await post('/api/tickets/lookup',{method:'phone',value:'5512345678'})).json()).results[0];assert.equal(lookup.payment.status,'rejected');assert.equal(lookup.status,'expired');assert.equal(Object.hasOwn(lookup.payment,'receipt'),false);
assert.equal((await post('/api/payments/submit',{...payload,tracking:'LATE123456'})).status,404);
assert.equal((await post('/api/reservations',{name:'Pdf Test',phone:'5512345670',numbers:[3]})).status,201);
const pdf=await post('/api/payments/submit',{phone:'5512345670',tracking:'PDF1234567',receipt:{type:'application/pdf',base64:Buffer.from('%PDF-1.4\n%%EOF placeholder').toString('base64')}});assert.equal(pdf.status,201);const pdfPayment=await pdf.json();
assert.equal((await post('/api/admin/payments/review',{id:pdfPayment.id,decision:'rejected',reason:'Monto incompleto'},cookie)).status,200);
db=new DatabaseSync(join(dir,'data/peso.db'));const back=db.prepare('SELECT status,expires FROM reservations WHERE phone=?').get('5512345670');db.close();assert.equal(back.status,'pending');assert.ok(back.expires<=Date.now()+3600000);
}finally{const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;rmSync(dir,{recursive:true,force:true});}
});

test('approved payments send WhatsApp through WAHA and notify n8n; large raffles report availability as a bitmap',async()=>{
// One fake server plays both WAHA (/api/...) and the n8n webhook (/hook).
const {createServer}=await import('node:http');const calls=[],waha=[];const hook=createServer((req,res)=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{const url=new URL(req.url,'http://x');if(url.pathname==='/api/contacts/check-exists'){waha.push({path:url.pathname,phone:url.searchParams.get('phone'),session:url.searchParams.get('session'),key:req.headers['x-api-key']});res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({numberExists:true,chatId:'5215512345678@c.us'}));}if(url.pathname==='/api/sendText'){waha.push({path:url.pathname,key:req.headers['x-api-key'],body:JSON.parse(text)});res.setHeader('Content-Type','application/json');return res.end('{}');}calls.push({secret:req.headers['x-peso-secret'],body:JSON.parse(text)});res.end('ok');});});await new Promise(r=>hook.listen(3110,'127.0.0.1',r));
const dir=mkdtempSync(join(tmpdir(),'peso-n8n-'));const base='http://localhost:3104';const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3104',NODE_ENV:'test',PUBLIC_ORIGIN:base,ADMIN_PASSWORD:'n8n-test-password',N8N_WEBHOOK_URL:'http://127.0.0.1:3110/hook',N8N_WEBHOOK_SECRET:'hook-secret',WAHA_URL:'http://127.0.0.1:3110/',WAHA_API_KEY:'waha-key',WAHA_SESSION:'peso'}});
const post=(path,data,cookie='')=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)});
try{await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
const cookie=await adminCookie(base,'n8n-test-password');await openSale(base,cookie,{ticketCount:100000});
assert.equal((await post('/api/reservations',{name:'Ana Pérez',phone:'5512345678',numbers:[7,99999]})).status,201);
const raffle=await (await fetch(base+'/api/raffle')).json();assert.equal(Buffer.from(raffle.taken,'base64').length,12500);assert.equal(isTaken(raffle,7),1);assert.equal(isTaken(raffle,99999),1);assert.equal(isTaken(raffle,8),0);assert.equal(raffle.holdHours,1);
const payment=await (await post('/api/payments/submit',{phone:'5512345678',tracking:'HOOK123456',receipt:{type:'image/png',base64:png}})).json();
assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Depósito verificado'},cookie)).status,200);
for(let i=0;i<50&&(!calls.length||waha.length<2);i++)await new Promise(r=>setTimeout(r,100));
assert.deepEqual(waha.map(x=>x.path),['/api/contacts/check-exists','/api/sendText']);assert.equal(waha[0].phone,'525512345678');assert.equal(waha[0].session,'peso');assert.ok(waha.every(x=>x.key==='waha-key'));
const message=waha[1].body;assert.equal(message.session,'peso');assert.equal(message.chatId,'5215512345678@c.us');assert.match(message.text,/Ana Pérez/);assert.match(message.text,/00007, 99999/);assert.match(message.text,/#mis-boletos/);assert.doesNotMatch(message.text,/folio/i);
assert.equal(calls.length,1);assert.equal(calls[0].secret,'hook-secret');const sent=calls[0].body;assert.equal(sent.event,'payment_approved');assert.equal(Object.hasOwn(sent,'folio'),false);assert.equal(sent.whatsapp,'525512345678');assert.deepEqual(sent.numbers,['00007','99999']);assert.equal(sent.name,'Ana Pérez');assert.match(sent.lookup_url,/#mis-boletos$/);
}finally{const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;hook.close();rmSync(dir,{recursive:true,force:true});}
});

test('admin edits, deletes and reschedules raffles against the sales goal',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-edit-'));const base='http://localhost:3105';const proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'3105',NODE_ENV:'test',PUBLIC_ORIGIN:base,ADMIN_PASSWORD:'edit-test-password'}});
let cookie='';const post=(path,data)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)});
const list=async()=>await (await fetch(base+'/api/admin/raffles',{headers:{Cookie:cookie}})).json();
try{await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});
cookie=await adminCookie(base,'edit-test-password');const now=Date.now();
const dates={startsAt:mx(now+86400000),endsAt:mx(now+2*86400000),drawAt:mx(now+3*86400000)};
const draft=await (await post('/api/admin/raffles',{prize:'Borrador',description:'D',price:'10',ticketCount:50,...dates,photo:null})).json();assert.equal((await list())[0].goal_percent,80);
assert.equal((await post('/api/admin/raffles/update',{id:draft.id,prize:'Premio corregido',description:'Nueva',price:'12.50',ticketCount:60,goalPercent:0,...dates})).status,400);
assert.equal((await post('/api/admin/raffles/update',{id:draft.id,prize:'Premio corregido',description:'Nueva',price:'12.50',ticketCount:60,goalPercent:50,...dates,photo:{type:'image/png',base64:png}})).status,200);
let row=(await list()).find(x=>x.id===draft.id);assert.equal(row.prize,'Premio corregido');assert.equal(row.price_cents,1250);assert.equal(row.ticket_count,60);assert.equal(row.goal_percent,50);assert.equal(row.has_photo,1);
assert.equal((await post('/api/admin/raffles/update',{id:draft.id,prize:'Premio corregido',description:'Nueva',price:'12.50',ticketCount:60,goalPercent:50,...dates,photo:null})).status,200);assert.equal((await list()).find(x=>x.id===draft.id).has_photo,0);
assert.equal((await post('/api/admin/raffles/delete',{id:draft.id})).status,200);assert.equal((await list()).some(x=>x.id===draft.id),false);
const live=await openSale(base,cookie,{ticketCount:10});row=(await list()).find(x=>x.id===live);const liveDates={startsAt:mx(row.starts_at),endsAt:mx(row.ends_at),drawAt:mx(row.draw_at)};
assert.equal((await post('/api/reservations',{name:'Goal Test',phone:'5512345678',numbers:[8]})).status,201);
const edit=changes=>post('/api/admin/raffles/update',{id:live,prize:'Premio',description:'Descripción',price:'50',ticketCount:20,goalPercent:80,...liveDates,...changes});
assert.equal((await edit({price:'99'})).status,409);assert.equal((await edit({ticketCount:8})).status,409);assert.equal((await edit({})).status,200);
assert.equal((await post('/api/admin/raffles/delete',{id:live})).status,409);
assert.equal((await post('/api/admin/raffles/reschedule',{id:live,endsAt:mx(now-60000),drawAt:mx(now+86400000)})).status,400);
const moved=await post('/api/admin/raffles/reschedule',{id:live,endsAt:mx(now+5*86400000),drawAt:mx(now+6*86400000)});assert.equal(moved.status,200);assert.equal((await moved.json()).status,'active');
const shown=(await (await fetch(base+'/api/raffle')).json()).raffle;assert.equal(shown.rescheduled,1);assert.equal(shown.ends_at,Date.parse(mx(now+5*86400000)));
assert.equal((await edit({goalPercent:5,...{endsAt:mx(now+5*86400000),drawAt:mx(now+6*86400000)}})).status,200);
const payment=await (await post('/api/payments/submit',{phone:'5512345678',tracking:'GOAL123456',receipt:{type:'image/png',base64:png}})).json();assert.equal((await post('/api/admin/payments/review',{id:payment.id,decision:'approved',reason:'Depósito verificado'})).status,200);
assert.equal((await post('/api/admin/raffles/reschedule',{id:live,endsAt:mx(now+7*86400000),drawAt:mx(now+8*86400000)})).status,409);
}finally{const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;rmSync(dir,{recursive:true,force:true});}
});

test('admin password changes survive restart and ignore old bootstrap environment',async()=>{
const dir=mkdtempSync(join(tmpdir(),'peso-password-'));const base='http://localhost:3103';let proc,cookie='';const env={...process.env,PORT:'3103',NODE_ENV:'production',PUBLIC_ORIGIN:'https://pesoganador.com',ADMIN_PASSWORD:'initial-test-password'};
async function start(){proc=spawn(process.execPath,[resolve('server.mjs')],{cwd:dir,env});await new Promise((resolve,reject)=>{proc.stdout.once('data',resolve);proc.once('error',reject);proc.once('exit',()=>reject(Error('Server exited')));});}
async function stop(){if(proc&&proc.exitCode===null){const done=new Promise(r=>proc.once('exit',r));proc.kill();await done;}}
const post=(path,data)=>fetch(base+path,{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)});
try{await start();assert.equal((await post('/api/admin/password',{currentPassword:env.ADMIN_PASSWORD,newPassword:'new-test-password'})).status,401);
const login=await post('/api/login',{password:env.ADMIN_PASSWORD});cookie=login.headers.get('set-cookie').split(';')[0];assert.equal(login.status,200);
assert.equal((await post('/api/admin/password',{currentPassword:'wrong-password',newPassword:'new-test-password'})).status,401);
assert.equal((await post('/api/admin/password',{currentPassword:env.ADMIN_PASSWORD,newPassword:'1234'})).status,400);
assert.equal((await post('/api/admin/password',{currentPassword:env.ADMIN_PASSWORD,newPassword:'new-test-password'})).status,200);
await stop();await start();cookie='';assert.equal((await post('/api/login',{password:env.ADMIN_PASSWORD})).status,401);assert.equal((await post('/api/login',{password:'new-test-password'})).status,200);
}finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
