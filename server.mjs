import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import {randomBytes,randomInt,scryptSync,timingSafeEqual} from 'node:crypto';
process.umask(0o077);
const production=process.env.NODE_ENV==='production';
const origin=process.env.PUBLIC_ORIGIN||`http://localhost:${process.env.PORT||3000}`;
if(production&&(!origin.startsWith('https://')||!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<5))throw Error('Producción requiere PUBLIC_ORIGIN HTTPS y ADMIN_PASSWORD de al menos 5 caracteres');
mkdirSync('data',{recursive:true});
const db=new DatabaseSync('data/peso.db');
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,name TEXT,phone TEXT,numbers TEXT,status TEXT,created INTEGER,expires INTEGER); CREATE TABLE IF NOT EXISTS tickets(number INTEGER PRIMARY KEY,reservation TEXT);`);
if(!db.prepare('PRAGMA table_info(reservations)').all().some(column=>column.name==='email'))db.exec('ALTER TABLE reservations ADD COLUMN email TEXT');
const normalizeName=value=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('es');
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
db.exec('CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,count INTEGER,until INTEGER); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,event TEXT,reservation TEXT,created INTEGER);');
db.exec("CREATE TABLE IF NOT EXISTS raffles(id TEXT PRIMARY KEY,prize TEXT NOT NULL,description TEXT NOT NULL,price_cents INTEGER NOT NULL CHECK(price_cents>0),ticket_count INTEGER NOT NULL CHECK(ticket_count>0),status TEXT NOT NULL DEFAULT 'draft',photo BLOB,photo_type TEXT,created INTEGER NOT NULL);");
const sessions=new Map();
db.exec("CREATE TABLE IF NOT EXISTS payment_submissions(id TEXT PRIMARY KEY,reservation TEXT NOT NULL,tracking TEXT NOT NULL UNIQUE,receipt BLOB NOT NULL,receipt_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reason TEXT,created INTEGER NOT NULL,reviewed INTEGER); CREATE UNIQUE INDEX IF NOT EXISTS one_pending_payment ON payment_submissions(reservation) WHERE status='pending';");
const salt=randomBytes(32), password=process.env.ADMIN_PASSWORD;
const hash=password?scryptSync(password,salt,64):null;
const price=50,count=100;
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
function expire(){const now=Date.now(); db.prepare("DELETE FROM tickets WHERE reservation IN (SELECT id FROM reservations WHERE status='pending' AND expires < ?)").run(now);db.prepare("UPDATE reservations SET status='expired' WHERE status='pending' AND expires < ?").run(now);}
function problem(status,message){return Object.assign(Error(message),{status});}
async function body(req,maxBytes=8192){
if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw problem(415,'Se requiere application/json');
if(Number(req.headers['content-length'])>maxBytes)throw problem(413,'Solicitud demasiado grande');
const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw problem(413,'Solicitud demasiado grande');chunks.push(chunk);}
let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw problem(400,'JSON inválido');}
if(!value||typeof value!=='object'||Array.isArray(value))throw problem(400,'Se requiere un objeto JSON');return value;
}
function rafflePhoto(photo){
if(photo==null)return {bytes:null,type:null};
if(!photo||typeof photo!=='object'||!['image/png','image/jpeg'].includes(photo.type)||typeof photo.base64!=='string'||photo.base64.length>1398104||!/^[A-Za-z0-9+/]*={0,2}$/.test(photo.base64))throw problem(400,'Usa una foto JPG o PNG de máximo 1 MB.');
const bytes=Buffer.from(photo.base64,'base64');let width=0,height=0;
if(bytes.length<45||bytes.length>1048576||bytes.toString('base64')!==photo.base64)throw problem(400,'Usa una foto JPG o PNG de máximo 1 MB.');
if(photo.type==='image/png'){
if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND')throw problem(400,'La foto PNG no es válida.');
width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
}else{
if(bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)throw problem(400,'La foto JPG no es válida.');
let offset=2;while(offset+4<bytes.length){if(bytes[offset]!==255)break;while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===218||marker===217)break;if(marker===1||marker>=208&&marker<=215)continue;const size=bytes.readUInt16BE(offset);if(size<2||offset+size>bytes.length)break;if([192,193,194].includes(marker)&&size>=8){height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;}offset+=size;}
}
if(!width||!height||width>4096||height>4096)throw problem(400,'La foto debe medir como máximo 4096 × 4096 píxeles.');
return {bytes,type:photo.type};
}
const cookieName=production?'__Host-session':'session';
function token(req){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);}
function admin(req){const now=Date.now(),s=sessions.get(token(req));if(!s||s.expires<=now||s.last+900000<=now)return false;s.last=now;return true;}
function cookie(value,age){return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${production||origin.startsWith('https:')?'; Secure':''}`;}
function audit(event,id=null){db.prepare('INSERT INTO audit(event,reservation,created) VALUES(?,?,?)').run(event,id,Date.now());}
// Global limits deliberately ignore forwarded IP headers: other containers must not spoof clients.
function limit(key,max,window){const now=Date.now();db.prepare('DELETE FROM limits WHERE until<=?').run(now);db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+window);const a=db.prepare('SELECT count,until FROM limits WHERE key=?').get(key);if(a.count>max)throw Object.assign(problem(429,'Demasiadas solicitudes. Intenta más tarde.'),{retry:Math.ceil((a.until-now)/1000)});}
setInterval(()=>{const now=Date.now();for(const [key,s] of sessions)if(s.expires<=now||s.last+900000<=now)sessions.delete(key);},60000).unref();
const server=http.createServer({maxHeaderSize:16384,requestTimeout:15000,headersTimeout:10000},async(req,res)=>{
res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
try{
const path=new URL(req.url,'http://localhost').pathname;
if(!['GET','HEAD','POST'].includes(req.method)){res.setHeader('Allow','GET, HEAD, POST');return send(res,405,{error:'Método no permitido'});}
if(req.method==='POST'){
if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'Origen no autorizado'});
}
expire();
if(path==='/api/raffle'&&req.method==='GET')return send(res,200,{title:'Tu próximo premio empieza aquí',price,count,demo:true,taken:db.prepare('SELECT number FROM tickets').all().map(x=>x.number)});
if(path==='/api/raffles'&&req.method==='GET')return send(res,200,db.prepare("SELECT id,prize,description,price_cents,ticket_count,photo IS NOT NULL AS has_photo FROM raffles WHERE status='published_demo' ORDER BY created DESC LIMIT 100").all());
const publicPhoto=path.match(/^\/api\/raffles\/([a-f0-9]{24})\/photo$/);
if(publicPhoto&&['GET','HEAD'].includes(req.method)){const row=db.prepare("SELECT photo,photo_type FROM raffles WHERE id=? AND status='published_demo'").get(publicPhoto[1]);if(!row?.photo)return send(res,404,{error:'Foto no disponible'});res.setHeader('Content-Type',row.photo_type);return res.end(req.method==='HEAD'?undefined:Buffer.from(row.photo));}
if(path==='/api/payments/submit'&&req.method==='POST'){
limit('payment_submit',15,60000);const b=await body(req,1500000);
if(typeof b.folio!=='string'||!/^[a-f0-9]{24}$/i.test(b.folio.trim())||typeof b.phone!=='string'||!/^\d{10}$/.test(b.phone)||typeof b.tracking!=='string'||b.tracking.length>100)return send(res,400,{error:'Revisa folio, teléfono y clave de rastreo.'});
const row=db.prepare('SELECT id,status,expires FROM reservations WHERE id=? AND phone=?').get(b.folio.trim().toLowerCase(),b.phone);
if(!row)return send(res,404,{error:'No encontramos una coincidencia con esos datos y folio.'});
if(row.status!=='pending'||row.expires<Date.now())return send(res,409,{error:'El apartado no está vigente. Contacta a administración; no envíes pagos.'});
const tracking=b.tracking.replace(/\s/g,'').toUpperCase();if(!/^[A-Z0-9]{6,64}$/.test(tracking))return send(res,400,{error:'La clave de rastreo debe tener de 6 a 64 letras o números.'});
if(!b.receipt)return send(res,400,{error:'Adjunta el comprobante de prueba en JPG o PNG.'});
const receipt=rafflePhoto(b.receipt),id=randomBytes(12).toString('hex');
try{db.prepare('INSERT INTO payment_submissions(id,reservation,tracking,receipt,receipt_type,created) VALUES(?,?,?,?,?,?)').run(id,row.id,tracking,receipt.bytes,receipt.type,Date.now());}catch(error){if(String(error.code).includes('CONSTRAINT')||String(error.message).includes('UNIQUE'))return send(res,409,{error:'No se pudo registrar: existe un envío pendiente o la referencia ya fue utilizada. Consulta a administración.'});throw error;}
return send(res,201,{id,status:'pending',demo:true,message:'Comprobante de prueba recibido para revisión. No acredita un pago ni extiende el apartado.'});
}
if(path==='/api/tickets/random'&&req.method==='POST'){
limit('random_tickets',60,60000);const b=await body(req);
if(!Number.isInteger(b.quantity)||b.quantity<1||b.quantity>10)return send(res,400,{error:'Elige entre 1 y 10 boletos.'});
const taken=new Set(db.prepare('SELECT number FROM tickets').all().map(row=>row.number));
const available=Array.from({length:count},(_,n)=>n).filter(n=>!taken.has(n));
if(available.length<b.quantity)return send(res,409,{error:`Solo quedan ${available.length} boletos disponibles. Reduce la cantidad.`,available:available.length});
for(let i=0;i<b.quantity;i++){const j=randomInt(i,available.length);[available[i],available[j]]=[available[j],available[i]];}
return send(res,200,{numbers:available.slice(0,b.quantity),quantity:b.quantity,demo:true});
}
if(path==='/api/tickets/lookup'&&req.method==='POST'){
limit('ticket_lookup',30,60000);
const b=await body(req);
if(!['name','phone','email'].includes(b.method)||typeof b.value!=='string'||!b.value.trim()||b.value.length>254||typeof b.folio!=='string'||!/^[a-f0-9]{24}$/i.test(b.folio.trim()))return send(res,400,{error:'Selecciona un dato de registro e introduce tu folio de 24 caracteres.'});
const row=db.prepare('SELECT id,name,phone,email,numbers,status,created,expires FROM reservations WHERE id=?').get(b.folio.trim().toLowerCase());
const matches=row&&(b.method==='name'?normalizeName(row.name)===normalizeName(b.value):b.method==='phone'?row.phone===b.value.trim():row.email&&row.email===b.value.trim().toLowerCase());
if(!matches)return send(res,404,{error:'No encontramos una coincidencia con esos datos y folio. Revisa ambos e intenta de nuevo.'});
const payment=db.prepare('SELECT status,reason FROM payment_submissions WHERE reservation=? ORDER BY created DESC,id DESC LIMIT 1').get(row.id);
return send(res,200,{folio:row.id,numbers:JSON.parse(row.numbers),status:row.status,created:row.created,expires:row.expires,payment:payment||null,demo:true});
}
if(path==='/api/reservations'&&req.method==='POST'){
limit('reservations',30,60000);
const b=await body(req);if(!Array.isArray(b.numbers)||b.numbers.length>10)return send(res,400,{error:'Selecciona de 1 a 10 boletos'});const nums=[...new Set(b.numbers)];
if(typeof b.name!=='string'||b.name.trim().length<3||b.name.length>100||typeof b.phone!=='string'||!/^\d{10}$/.test(b.phone)||!nums.length||nums.length>10||nums.some(n=>!Number.isInteger(n)||n<0||n>=count))return send(res,400,{error:'Revisa nombre, teléfono y boletos (máximo 10).'});
const email=b.email==null||b.email===''?null:typeof b.email==='string'?b.email.trim().toLowerCase():b.email;
if(email!==null&&!validEmail(email))return send(res,400,{error:'Revisa el correo electrónico.'});
const id=randomBytes(12).toString('hex');db.exec('BEGIN IMMEDIATE');
try{
const active=db.prepare("SELECT numbers FROM reservations WHERE phone=? AND status='pending'").all(b.phone).reduce((sum,row)=>sum+JSON.parse(row.numbers).length,0);
if(active+nums.length>10){db.exec('ROLLBACK');return send(res,429,{error:'Este teléfono ya tiene el máximo de boletos pendientes'});}
db.prepare('INSERT INTO reservations(id,name,phone,numbers,status,created,expires,email) VALUES(?,?,?,?,?,?,?,?)').run(id,b.name.trim(),b.phone,JSON.stringify(nums),'pending',Date.now(),Date.now()+3600000,email);for(const n of nums)db.prepare('INSERT INTO tickets VALUES(?,?)').run(n,id);db.exec('COMMIT');}catch{db.exec('ROLLBACK');return send(res,409,{error:'Algún boleto acaba de ser apartado. Actualiza tu selección.'});}
return send(res,201,{id,total:nums.length*price,message:'Apartado de demostración por 60 minutos. No realices pagos.'});
}
if(path==='/api/login'&&req.method==='POST'){
if(!hash)return send(res,503,{error:'Administrador pendiente de configurar en el servidor.'});
limit('login',5,900000);const now=Date.now();
const b=await body(req);if(typeof b.password!=='string'||b.password.length>200||!timingSafeEqual(hash,scryptSync(b.password,salt,64)))return send(res,401,{error:'Credenciales incorrectas'});
// Rotate only the session used by this browser; keep other devices signed in.
sessions.delete(token(req));for(const [key,s] of sessions)if(s.expires<=now||s.last+900000<=now)sessions.delete(key);
if(sessions.size>=20)return send(res,429,{error:'Se alcanzó el límite de sesiones. Cierra alguna o espera a que expire.'});
const sessionToken=randomBytes(32).toString('hex');sessions.set(sessionToken,{expires:now+3600000,last:now});audit('login');res.setHeader('Set-Cookie',cookie(sessionToken,3600));return send(res,200,{ok:true});
}
if(path.startsWith('/api/admin/')){
if(!admin(req))return send(res,401,{error:'Inicia sesión'});
if(path==='/api/admin/raffles/visibility'&&req.method==='POST'){const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id)||typeof b.visible!=='boolean')return send(res,400,{error:'Revisa la rifa y la visibilidad.'});db.exec('BEGIN IMMEDIATE');try{const result=db.prepare("UPDATE raffles SET status=? WHERE id=? AND status IN ('draft','published_demo')").run(b.visible?'published_demo':'draft',b.id);if(!result.changes){db.exec('ROLLBACK');return send(res,404,{error:'Rifa no disponible'});}audit(b.visible?'raffle_demo_published':'raffle_demo_hidden',b.id);db.exec('COMMIT');return send(res,200,{ok:true});}catch(error){db.exec('ROLLBACK');throw error;}}
if(path==='/api/admin/payments'&&req.method==='GET')return send(res,200,db.prepare('SELECT p.id,p.reservation,p.tracking,p.status,p.reason,p.created,p.reviewed,r.name,r.phone,r.numbers,r.status AS reservation_status,r.expires FROM payment_submissions p JOIN reservations r ON r.id=p.reservation ORDER BY p.created DESC,p.id DESC LIMIT 100').all());
const receiptMatch=path.match(/^\/api\/admin\/payments\/([a-f0-9]{24})\/receipt$/);
if(receiptMatch&&['GET','HEAD'].includes(req.method)){const row=db.prepare('SELECT receipt,receipt_type FROM payment_submissions WHERE id=?').get(receiptMatch[1]);if(!row)return send(res,404,{error:'Comprobante no disponible'});res.setHeader('Content-Type',row.receipt_type);return res.end(req.method==='HEAD'?undefined:Buffer.from(row.receipt));}
if(path==='/api/admin/payments/review'&&req.method==='POST'){
const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id)||!['approved','rejected'].includes(b.decision)||typeof b.reason!=='string'||b.reason.trim().length<5||b.reason.length>500)return send(res,400,{error:'Selecciona una decisión y escribe un motivo de 5 a 500 caracteres.'});
db.exec('BEGIN IMMEDIATE');try{const p=db.prepare('SELECT * FROM payment_submissions WHERE id=?').get(b.id);if(!p||p.status!=='pending'){db.exec('ROLLBACK');return send(res,409,{error:'El comprobante ya fue revisado o no existe.'});}
if(b.decision==='approved'){const changed=db.prepare("UPDATE reservations SET status='paid' WHERE id=? AND status='pending' AND expires>=?").run(p.reservation,Date.now());if(!changed.changes){db.exec('ROLLBACK');return send(res,409,{error:'El apartado venció o ya fue procesado. No se reasignaron boletos; requiere aclaración.'});}}
db.prepare('UPDATE payment_submissions SET status=?,reason=?,reviewed=? WHERE id=?').run(b.decision,b.reason.trim(),Date.now(),p.id);audit(b.decision==='approved'?'payment_confirmed':'payment_rejected',p.reservation);db.exec('COMMIT');return send(res,200,{ok:true});}catch(error){db.exec('ROLLBACK');throw error;}
}
if(path==='/api/admin/raffles'&&req.method==='GET')return send(res,200,db.prepare("SELECT id,prize,description,price_cents,ticket_count,status,created,photo IS NOT NULL AS has_photo FROM raffles ORDER BY created DESC,id DESC LIMIT 100").all());
if(path==='/api/admin/raffles'&&req.method==='POST'){
limit('create_raffle',10,60000);const b=await body(req,1500000);
if(typeof b.prize!=='string'||b.prize.trim().length<3||b.prize.length>120||typeof b.description!=='string'||!b.description.trim()||b.description.length>5000||typeof b.price!=='string'||!/^\d{1,7}(?:\.\d{1,2})?$/.test(b.price)||!Number.isInteger(b.ticketCount)||b.ticketCount<1||b.ticketCount>100000)return send(res,400,{error:'Revisa premio, descripción, precio y cantidad (1 a 100,000 boletos).'});
const cents=Math.round(Number(b.price)*100);if(cents<1||cents>100000000)return send(res,400,{error:'El precio debe estar entre $0.01 y $1,000,000 MXN.'});
const photo=rafflePhoto(b.photo),id=randomBytes(12).toString('hex');db.exec('BEGIN IMMEDIATE');try{db.prepare("INSERT INTO raffles(id,prize,description,price_cents,ticket_count,status,photo,photo_type,created) VALUES(?,?,?,?,?,'draft',?,?,?)").run(id,b.prize.trim(),b.description.trim(),cents,b.ticketCount,photo.bytes,photo.type,Date.now());audit('raffle_created',id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return send(res,201,{id,status:'draft',message:'Rifa guardada como borrador. La rifa pública no cambió.'});
}
const photoMatch=path.match(/^\/api\/admin\/raffles\/([a-f0-9]{24})\/photo$/);
if(photoMatch&&['GET','HEAD'].includes(req.method)){const row=db.prepare('SELECT photo,photo_type FROM raffles WHERE id=?').get(photoMatch[1]);if(!row?.photo)return send(res,404,{error:'Foto no disponible'});res.setHeader('Content-Type',row.photo_type);res.setHeader('Content-Length',row.photo.length);res.setHeader('Content-Disposition','inline');return res.end(req.method==='HEAD'?undefined:Buffer.from(row.photo));}
if(path==='/api/admin/logout'&&req.method==='POST'){sessions.delete(token(req));audit('logout');res.setHeader('Set-Cookie',cookie('',0));return send(res,200,{ok:true});}
if(path==='/api/admin/reservations'&&req.method==='GET')return send(res,200,db.prepare('SELECT * FROM reservations ORDER BY created DESC LIMIT 500').all());
if(path==='/api/admin/confirm'&&req.method==='POST')return send(res,410,{error:'Revisa el comprobante y registra el motivo desde Pagos por revisar.'});
}
const files={'/':'index.html','/CFAD':'admin.html','/CFAD/':'admin.html','/app.js':'app.js','/admin.js':'admin.js','/style.css':'style.css','/admin.css':'admin.css','/logo.png':'logo.png','/favicon.ico':'favicon.ico','/favicon-32.png':'favicon-32.png','/favicon-192.png':'favicon-192.png','/apple-touch-icon.png':'apple-touch-icon.png'};
if(['GET','HEAD'].includes(req.method)&&Object.hasOwn(files,path)){res.setHeader('Content-Type',path.endsWith('.png')?'image/png':path.endsWith('.ico')?'image/x-icon':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');return res.end(req.method==='HEAD'?undefined:readFileSync(new URL(`public/${files[path]}`,import.meta.url)));}
send(res,404,{error:'No encontrado'});
}catch(error){if(error.retry)res.setHeader('Retry-After',String(error.retry));if(!error.status)console.error('request_failed');send(res,error.status||500,{error:error.status?error.message:'Error interno'});}
});
server.maxRequestsPerSocket=100;
server.keepAliveTimeout=5000;
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`Peso Ganador: puerto ${process.env.PORT||3000}`));



