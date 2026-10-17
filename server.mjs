import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
mkdirSync('data',{recursive:true});
const db=new DatabaseSync('data/peso.db');
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,name TEXT,phone TEXT,numbers TEXT,status TEXT,created INTEGER,expires INTEGER); CREATE TABLE IF NOT EXISTS tickets(number INTEGER PRIMARY KEY,reservation TEXT);`);
const sessions=new Map(), attempts=new Map();
const salt=randomBytes(32), password=process.env.ADMIN_PASSWORD;
const hash=password?scryptSync(password,salt,64):null;
const price=50,count=100;
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
function expire(){const now=Date.now(); db.prepare("DELETE FROM tickets WHERE reservation IN (SELECT id FROM reservations WHERE status='pending' AND expires < ?)").run(now);db.prepare("UPDATE reservations SET status='expired' WHERE status='pending' AND expires < ?").run(now);}
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8192)throw Error('Solicitud demasiado grande');}return JSON.parse(raw||'{}');}
function admin(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('session='))?.slice(8);return sessions.get(token)>Date.now();}
const server=http.createServer(async(req,res)=>{
res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
try{
const path=new URL(req.url,'http://localhost').pathname;
if(req.method==='POST'){
const expected=process.env.PUBLIC_ORIGIN||`http://localhost:${process.env.PORT||3000}`;
if(req.headers.origin!==expected)return send(res,403,{error:'Origen no autorizado'});
}
expire();
if(path==='/api/raffle'&&req.method==='GET')return send(res,200,{title:'Tu próximo premio empieza aquí',price,count,demo:true,taken:db.prepare('SELECT number FROM tickets').all().map(x=>x.number)});
if(path==='/api/reservations'&&req.method==='POST'){
const b=await body(req);const nums=[...new Set(b.numbers)];
if(typeof b.name!=='string'||b.name.trim().length<3||b.name.length>100||typeof b.phone!=='string'||!/^\d{10}$/.test(b.phone)||!nums.length||nums.length>10||nums.some(n=>!Number.isInteger(n)||n<0||n>=count))return send(res,400,{error:'Revisa nombre, teléfono y boletos (máximo 10).'});
const id=randomBytes(12).toString('hex');db.exec('BEGIN IMMEDIATE');
try{db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?)').run(id,b.name.trim(),b.phone,JSON.stringify(nums),'pending',Date.now(),Date.now()+3600000);for(const n of nums)db.prepare('INSERT INTO tickets VALUES(?,?)').run(n,id);db.exec('COMMIT');}catch{db.exec('ROLLBACK');return send(res,409,{error:'Algún boleto acaba de ser apartado. Actualiza tu selección.'});}
return send(res,201,{id,total:nums.length*price,message:'Apartado de demostración por 60 minutos. No realices pagos.'});
}
if(path==='/api/login'&&req.method==='POST'){
if(!hash)return send(res,503,{error:'Administrador pendiente de configurar en el servidor.'});
const key=req.socket.remoteAddress,now=Date.now(),a=attempts.get(key)||{count:0,until:now+900000};if(a.until<now){a.count=0;a.until=now+900000;}if(++a.count>5)return send(res,429,{error:'Intenta nuevamente en 15 minutos.'});attempts.set(key,a);
const b=await body(req);if(typeof b.password!=='string'||b.password.length>200||!timingSafeEqual(hash,scryptSync(b.password,salt,64)))return send(res,401,{error:'Credenciales incorrectas'});
attempts.delete(key);const token=randomBytes(32).toString('hex');sessions.set(token,now+3600000);res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${process.env.PUBLIC_ORIGIN?.startsWith('https:')?'; Secure':''}`);return send(res,200,{ok:true});
}
if(path.startsWith('/api/admin/')){
if(!admin(req))return send(res,401,{error:'Inicia sesión'});
if(path==='/api/admin/reservations'&&req.method==='GET')return send(res,200,db.prepare('SELECT * FROM reservations ORDER BY created DESC').all());
if(path==='/api/admin/confirm'&&req.method==='POST'){const b=await body(req);const result=db.prepare("UPDATE reservations SET status='paid' WHERE id=? AND status='pending' AND expires>=?").run(b.id,Date.now());return send(res,result.changes?200:409,{ok:!!result.changes});}
}
const files={'/':'index.html','/CFAD':'admin.html','/CFAD/':'admin.html','/app.js':'app.js','/admin.js':'admin.js','/style.css':'style.css'};
if(req.method==='GET'&&files[path]){res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');return res.end(readFileSync(`public/${files[path]}`));}
send(res,404,{error:'No encontrado'});
}catch{send(res,400,{error:'Solicitud inválida'});}
});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`Peso Ganador: puerto ${process.env.PORT||3000}`));
