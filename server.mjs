import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import {randomBytes,randomInt,scryptSync,timingSafeEqual} from 'node:crypto';
process.umask(0o077);
const production=process.env.NODE_ENV==='production';
const origin=process.env.PUBLIC_ORIGIN||`http://localhost:${process.env.PORT||3000}`;
if(production&&(!origin.startsWith('https://')||!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<20))throw Error('Producción requiere PUBLIC_ORIGIN HTTPS y ADMIN_PASSWORD de al menos 20 caracteres');
mkdirSync('data',{recursive:true});
const db=new DatabaseSync('data/peso.db');
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,name TEXT,phone TEXT,numbers TEXT,status TEXT,created INTEGER,expires INTEGER); CREATE TABLE IF NOT EXISTS tickets(number INTEGER PRIMARY KEY,reservation TEXT);`);
if(!db.prepare('PRAGMA table_info(reservations)').all().some(column=>column.name==='email'))db.exec('ALTER TABLE reservations ADD COLUMN email TEXT');
const normalizeName=value=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('es');
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
db.exec('CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,count INTEGER,until INTEGER); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,event TEXT,reservation TEXT,created INTEGER);');
const sessions=new Map();
const salt=randomBytes(32), password=process.env.ADMIN_PASSWORD;
const hash=password?scryptSync(password,salt,64):null;
const price=50,count=100;
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
function expire(){const now=Date.now(); db.prepare("DELETE FROM tickets WHERE reservation IN (SELECT id FROM reservations WHERE status='pending' AND expires < ?)").run(now);db.prepare("UPDATE reservations SET status='expired' WHERE status='pending' AND expires < ?").run(now);}
function problem(status,message){return Object.assign(Error(message),{status});}
async function body(req){
if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw problem(415,'Se requiere application/json');
if(Number(req.headers['content-length'])>8192)throw problem(413,'Solicitud demasiado grande');
const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192)throw problem(413,'Solicitud demasiado grande');chunks.push(chunk);}
let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw problem(400,'JSON inválido');}
if(!value||typeof value!=='object'||Array.isArray(value))throw problem(400,'Se requiere un objeto JSON');return value;
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
return send(res,200,{folio:row.id,numbers:JSON.parse(row.numbers),status:row.status,created:row.created,expires:row.expires,demo:true});
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
sessions.clear();const sessionToken=randomBytes(32).toString('hex');sessions.set(sessionToken,{expires:now+3600000,last:now});audit('login');res.setHeader('Set-Cookie',cookie(sessionToken,3600));return send(res,200,{ok:true});
}
if(path.startsWith('/api/admin/')){
if(!admin(req))return send(res,401,{error:'Inicia sesión'});
if(path==='/api/admin/logout'&&req.method==='POST'){sessions.delete(token(req));audit('logout');res.setHeader('Set-Cookie',cookie('',0));return send(res,200,{ok:true});}
if(path==='/api/admin/reservations'&&req.method==='GET')return send(res,200,db.prepare('SELECT * FROM reservations ORDER BY created DESC LIMIT 500').all());
if(path==='/api/admin/confirm'&&req.method==='POST'){const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id))return send(res,400,{error:'Folio inválido'});db.exec('BEGIN IMMEDIATE');try{const result=db.prepare("UPDATE reservations SET status='paid' WHERE id=? AND status='pending' AND expires>=?").run(b.id,Date.now());if(result.changes)audit('payment_confirmed',b.id);db.exec('COMMIT');return send(res,result.changes?200:409,{ok:!!result.changes});}catch(error){db.exec('ROLLBACK');throw error;}}
}
const files={'/':'index.html','/CFAD':'admin.html','/CFAD/':'admin.html','/app.js':'app.js','/admin.js':'admin.js','/style.css':'style.css'};
if(['GET','HEAD'].includes(req.method)&&Object.hasOwn(files,path)){res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');return res.end(req.method==='HEAD'?undefined:readFileSync(new URL(`public/${files[path]}`,import.meta.url)));}
send(res,404,{error:'No encontrado'});
}catch(error){if(error.retry)res.setHeader('Retry-After',String(error.retry));if(!error.status)console.error('request_failed');send(res,error.status||500,{error:error.status?error.message:'Error interno'});}
});
server.maxRequestsPerSocket=100;
server.keepAliveTimeout=5000;
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`Peso Ganador: puerto ${process.env.PORT||3000}`));
