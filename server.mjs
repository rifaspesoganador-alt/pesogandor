import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import {randomBytes,randomInt} from 'node:crypto';
import {credentialStore} from './credentials.mjs';
process.umask(0o077);
const production=process.env.NODE_ENV==='production';
const origin=process.env.PUBLIC_ORIGIN||`http://localhost:${process.env.PORT||3000}`;
if(production&&!origin.startsWith('https://'))throw Error('Producción requiere PUBLIC_ORIGIN HTTPS');
mkdirSync('data',{recursive:true});
const db=new DatabaseSync('data/peso.db');
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,name TEXT,phone TEXT,numbers TEXT,status TEXT,created INTEGER,expires INTEGER); CREATE TABLE IF NOT EXISTS tickets(number INTEGER PRIMARY KEY,reservation TEXT);`);
const hasColumn=(table,name)=>db.prepare(`PRAGMA table_info(${table})`).all().some(column=>column.name===name);
for(const [column,type] of [['email','TEXT'],['raffle','TEXT'],['amount_cents','INTEGER'],['name_key','TEXT']])if(!hasColumn('reservations',column))db.exec(`ALTER TABLE reservations ADD COLUMN ${column} ${type}`);
const normalizeName=value=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('es');
// Lookups search by name, phone or email, so older rows get their normalized name and all three are indexed.
for(const row of db.prepare('SELECT id,name FROM reservations WHERE name_key IS NULL AND name IS NOT NULL').all())db.prepare('UPDATE reservations SET name_key=? WHERE id=?').run(normalizeName(row.name),row.id);
db.exec('CREATE INDEX IF NOT EXISTS reservations_name_key ON reservations(name_key); CREATE INDEX IF NOT EXISTS reservations_phone ON reservations(phone); CREATE INDEX IF NOT EXISTS reservations_email ON reservations(email);');
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
db.exec('CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,count INTEGER,until INTEGER); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,event TEXT,reservation TEXT,created INTEGER);');
db.exec("CREATE TABLE IF NOT EXISTS raffles(id TEXT PRIMARY KEY,prize TEXT NOT NULL,description TEXT NOT NULL,price_cents INTEGER NOT NULL CHECK(price_cents>0),ticket_count INTEGER NOT NULL CHECK(ticket_count>0),status TEXT NOT NULL DEFAULT 'draft',photo BLOB,photo_type TEXT,created INTEGER NOT NULL);");
for(const column of ['starts_at','ends_at','draw_at'])if(!hasColumn('raffles',column))db.exec(`ALTER TABLE raffles ADD COLUMN ${column} INTEGER`);
// Former demo previews go back to draft: going on sale is always an explicit admin action.
db.exec("UPDATE raffles SET status='draft' WHERE status='published_demo'");
// Tickets belong to a raffle; the legacy global `tickets` table is kept untouched for old databases.
db.exec('CREATE TABLE IF NOT EXISTS raffle_tickets(raffle TEXT NOT NULL,number INTEGER NOT NULL,reservation TEXT NOT NULL,PRIMARY KEY(raffle,number)); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
const sessions=new Map();
db.exec("CREATE TABLE IF NOT EXISTS payment_submissions(id TEXT PRIMARY KEY,reservation TEXT NOT NULL,tracking TEXT NOT NULL UNIQUE,receipt BLOB NOT NULL,receipt_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reason TEXT,created INTEGER NOT NULL,reviewed INTEGER); CREATE UNIQUE INDEX IF NOT EXISTS one_pending_payment ON payment_submissions(reservation) WHERE status='pending';");
const credentials=credentialStore(db,process.env.ADMIN_PASSWORD);
if(production&&!credentials.exists())throw Error('Configura ADMIN_PASSWORD de al menos 5 caracteres para el primer arranque.');
function raffleDates(b){const values=[b.startsAt,b.endsAt,b.drawAt];if(values.some(value=>typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-06:00$/.test(value)))throw problem(400,'Indica inicio, cierre y sorteo en hora del centro de México.');const dates=values.map(Date.parse);if(dates.some((n,i)=>!Number.isFinite(n)||new Date(n-21600000).toISOString().slice(0,16)!==values[i].slice(0,16))||dates[0]>=dates[1]||dates[1]>dates[2])throw problem(400,'El inicio debe ser anterior al cierre y el sorteo debe ser igual o posterior al cierre.');return dates;}
const MAX_PER_PHONE=10,MAX_TICKETS=100000,REVIEW_HOLD=48*3600000;
function paymentInfo(){const row=db.prepare("SELECT value FROM settings WHERE key='payment'").get();return row?JSON.parse(row.value):null;}
function holdMs(){return (paymentInfo()?.holdHours||24)*3600000;}
function activeRaffle(){return db.prepare("SELECT id,prize,description,price_cents,ticket_count,starts_at,ends_at,draw_at,photo IS NOT NULL AS has_photo FROM raffles WHERE status='active' ORDER BY created DESC LIMIT 1").get();}
function salesOpen(raffle,now=Date.now()){return !!raffle&&!!paymentInfo()&&now>=raffle.starts_at&&now<raffle.ends_at;}
function closedMessage(raffle){if(!raffle)return 'No hay una rifa en venta en este momento.';if(!paymentInfo())return 'La venta abrirá en cuanto publiquemos los datos de pago.';return Date.now()<raffle.starts_at?'La venta de boletos aún no comienza.':'La venta de boletos ya cerró.';}
function takenNumbers(raffleId){return db.prepare('SELECT number FROM raffle_tickets WHERE raffle=? ORDER BY number').all(raffleId).map(x=>x.number);}
// One bit per ticket keeps the public availability payload small (about 17 KB for 100,000 tickets).
function takenBitmap(raffle){const bits=Buffer.alloc(Math.ceil(raffle.ticket_count/8));for(const n of takenNumbers(raffle.id))bits[n>>3]|=1<<(n&7);return bits.toString('base64');}
const money=cents=>new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(cents/100);
// Sends a WhatsApp text through WAHA (WhatsApp HTTP API).
async function sendWhatsApp(phone,text){
const base=(process.env.WAHA_URL||'').replace(/\/+$/,''),session=process.env.WAHA_SESSION||'default';
const headers={'Content-Type':'application/json',Accept:'application/json'};if(process.env.WAHA_API_KEY)headers['X-Api-Key']=process.env.WAHA_API_KEY;
// Mexican mobiles can be registered on WhatsApp as 52 or 521 + 10 digits; WAHA reports the real chat id.
let chatId=`52${phone}@c.us`;
try{const check=await fetch(`${base}/api/contacts/check-exists?phone=52${phone}&session=${encodeURIComponent(session)}`,{headers,signal:AbortSignal.timeout(10000)});if(check.ok){const found=await check.json();if(found.numberExists===false)throw problem(404,'number_not_on_whatsapp');if(found.chatId)chatId=found.chatId;}}catch(error){if(error.status===404)throw error;}
const res=await fetch(`${base}/api/sendText`,{method:'POST',headers,body:JSON.stringify({session,chatId,text}),signal:AbortSignal.timeout(15000)});if(!res.ok)throw problem(res.status,'waha_send_failed');
}
// Confirms an approved payment by WhatsApp (WAHA) and/or n8n. Failures are logged and never undo the approval.
function notifyApproved(reservationId){
const waha=!!process.env.WAHA_URL,hook=process.env.N8N_WEBHOOK_URL;if(!waha&&!hook)return;
const r=db.prepare('SELECT r.id,r.name,r.phone,r.numbers,r.amount_cents,f.prize,f.ticket_count,f.draw_at FROM reservations r LEFT JOIN raffles f ON f.id=r.raffle WHERE r.id=?').get(reservationId);if(!r)return;
const width=Math.max(3,String((r.ticket_count||1)-1).length),numbers=JSON.parse(r.numbers).map(n=>String(n).padStart(width,'0'));
const payload={event:'payment_approved',name:r.name,phone:r.phone,whatsapp:'52'+r.phone,numbers,amount:r.amount_cents?money(r.amount_cents):null,prize:r.prize,draw_at:r.draw_at?new Date(r.draw_at).toLocaleString('es-MX',{timeZone:'America/Mexico_City',dateStyle:'long',timeStyle:'short'}):null,lookup_url:`${origin}/#mis-boletos`};
if(waha){const text=[`¡Hola, ${r.name}! 🎉 Confirmamos tu pago en Peso Ganador.`,'',payload.prize&&`Rifa: ${payload.prize}`,`Tus boletos: ${numbers.join(', ')}`,payload.amount&&`Total pagado: ${payload.amount} MXN`,payload.draw_at&&`Sorteo: ${payload.draw_at}`,'',`Revisa que tus boletos ya aparecen como aprobados en ${payload.lookup_url} buscando con tu teléfono.`,'','¡Mucha suerte! 🍀'].filter(line=>line!==null&&line!==undefined).join('\n');
sendWhatsApp(r.phone,text).then(()=>audit('whatsapp_sent',r.id)).catch(error=>{audit('whatsapp_failed',r.id);console.error('whatsapp_failed',error.message);});}
if(hook){const headers={'Content-Type':'application/json'};if(process.env.N8N_WEBHOOK_SECRET)headers['X-Peso-Secret']=process.env.N8N_WEBHOOK_SECRET;
fetch(hook,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)}).then(res=>{if(!res.ok)console.error('n8n_webhook_failed',res.status);}).catch(()=>console.error('n8n_webhook_failed'));}
}
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
function expire(){const now=Date.now();db.prepare("DELETE FROM raffle_tickets WHERE reservation IN (SELECT id FROM reservations WHERE status='pending' AND expires < ?)").run(now);db.prepare("DELETE FROM tickets WHERE reservation IN (SELECT id FROM reservations WHERE status='pending' AND expires < ?)").run(now);db.prepare("UPDATE reservations SET status='expired' WHERE status='pending' AND expires < ?").run(now);}
function problem(status,message){return Object.assign(Error(message),{status});}
async function body(req,maxBytes=8192){
if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw problem(415,'Se requiere application/json');
if(Number(req.headers['content-length'])>maxBytes)throw problem(413,'Solicitud demasiado grande');
const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw problem(413,'Solicitud demasiado grande');chunks.push(chunk);}
let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw problem(400,'JSON inválido');}
if(!value||typeof value!=='object'||Array.isArray(value))throw problem(400,'Se requiere un objeto JSON');return value;
}
function rafflePhoto(photo,{maxBytes=1048576,maxSide=4096,label='foto'}={}){
if(photo==null)return {bytes:null,type:null};
const sizeError=`Usa una ${label} JPG o PNG de máximo ${maxBytes/1048576} MB.`;
if(!photo||typeof photo!=='object'||!['image/png','image/jpeg'].includes(photo.type)||typeof photo.base64!=='string'||photo.base64.length>Math.ceil(maxBytes/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(photo.base64))throw problem(400,sizeError);
const bytes=Buffer.from(photo.base64,'base64');let width=0,height=0;
if(bytes.length<45||bytes.length>maxBytes||bytes.toString('base64')!==photo.base64)throw problem(400,sizeError);
if(photo.type==='image/png'){
if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND')throw problem(400,`La ${label} PNG no es válida.`);
width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
}else{
if(bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)throw problem(400,`La ${label} JPG no es válida.`);
let offset=2;while(offset+4<bytes.length){if(bytes[offset]!==255)break;while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===218||marker===217)break;if(marker===1||marker>=208&&marker<=215)continue;const size=bytes.readUInt16BE(offset);if(size<2||offset+size>bytes.length)break;if([192,193,194].includes(marker)&&size>=8){height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;}offset+=size;}
}
if(!width||!height||width>maxSide||height>maxSide)throw problem(400,`La ${label} debe medir como máximo ${maxSide} × ${maxSide} píxeles.`);
return {bytes,type:photo.type};
}
const RECEIPT_MAX=5242880;
function receiptFile(file){
if(file?.type!=='application/pdf')return rafflePhoto(file,{maxBytes:RECEIPT_MAX,maxSide:12000,label:'imagen'});
if(typeof file.base64!=='string'||file.base64.length>Math.ceil(RECEIPT_MAX/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64))throw problem(400,'Usa un PDF de máximo 5 MB.');
const bytes=Buffer.from(file.base64,'base64');
if(bytes.length<20||bytes.toString('base64')!==file.base64||bytes.toString('ascii',0,5)!=='%PDF-')throw problem(400,'El PDF no es válido.');
return {bytes,type:'application/pdf'};
}
function paymentSettings(b){
const text=(value,max)=>typeof value==='string'&&value.length<=max?value.trim():null;
const digits=value=>typeof value==='string'?value.replace(/[\s-]/g,''):null;
const info={bank:text(b.bank,80),holder:text(b.holder,120),clabe:digits(b.clabe),account:digits(b.account),card:digits(b.card),instructions:text(b.instructions,1000),whatsapp:digits(b.whatsapp),holdHours:b.holdHours};
if(!info.bank||info.bank.length<2||!info.holder||info.holder.length<3)throw problem(400,'Indica el banco y el nombre del titular.');
if(info.clabe===null||info.account===null||info.card===null||info.instructions===null||info.whatsapp===null)throw problem(400,'Revisa los datos de pago.');
if(info.clabe&&!/^\d{18}$/.test(info.clabe))throw problem(400,'La CLABE debe tener 18 dígitos.');
if(info.account&&!/^\d{6,20}$/.test(info.account))throw problem(400,'El número de cuenta debe tener de 6 a 20 dígitos.');
if(info.card&&!/^\d{16}$/.test(info.card))throw problem(400,'La tarjeta debe tener 16 dígitos.');
if(!info.clabe&&!info.account&&!info.card)throw problem(400,'Agrega al menos una CLABE, cuenta o tarjeta.');
if(info.whatsapp&&!/^\d{10,15}$/.test(info.whatsapp))throw problem(400,'El WhatsApp debe tener de 10 a 15 dígitos.');
if(!Number.isInteger(info.holdHours)||info.holdHours<1||info.holdHours>72)throw problem(400,'El tiempo para pagar debe ser de 1 a 72 horas.');
return info;
}
const cookieName=production?'__Host-session':'session';
function token(req){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);}
function admin(req){const now=Date.now(),s=sessions.get(token(req));if(!s||s.expires<=now||s.last+900000<=now)return false;s.last=now;return true;}
function cookie(value,age){return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${production||origin.startsWith('https:')?'; Secure':''}`;}
function audit(event,id=null){db.prepare('INSERT INTO audit(event,reservation,created) VALUES(?,?,?)').run(event,id,Date.now());}
// Behind Traefik (TRUST_PROXY=1) the last X-Forwarded-For entry is the one the proxy added; earlier entries come from the client.
function clientIp(req){if(process.env.TRUST_PROXY==='1'){const chain=String(req.headers['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean);if(chain.length)return chain[chain.length-1];}return req.socket.remoteAddress||'unknown';}
// Each public action has a generous site-wide ceiling plus a per-visitor limit, so one person cannot block everyone else.
function limits(req,key,globalMax,perIpMax){limit(key,globalMax,60000);limit(`${key}:${clientIp(req)}`,perIpMax,60000);}
function limit(key,max,window){const now=Date.now();db.prepare('DELETE FROM limits WHERE until<=?').run(now);db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,now+window);const a=db.prepare('SELECT count,until FROM limits WHERE key=?').get(key);if(a.count>max)throw Object.assign(problem(429,'Demasiadas solicitudes. Intenta más tarde.'),{retry:Math.ceil((a.until-now)/1000)});}
setInterval(()=>{const now=Date.now();for(const [key,s] of sessions)if(s.expires<=now||s.last+900000<=now)sessions.delete(key);},60000).unref();
// Expired holds are released once a minute and before every write, not on each page view.
expire();setInterval(expire,60000).unref();
const server=http.createServer({maxHeaderSize:16384,requestTimeout:30000,headersTimeout:10000},async(req,res)=>{
res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
try{
const path=new URL(req.url,'http://localhost').pathname;
if(!['GET','HEAD','POST'].includes(req.method)){res.setHeader('Allow','GET, HEAD, POST');return send(res,405,{error:'Método no permitido'});}
if(req.method==='POST'){
if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'Origen no autorizado'});
}
if(req.method==='POST'||path.startsWith('/api/admin/'))expire();
if(path==='/api/raffle'&&req.method==='GET'){const raffle=activeRaffle();if(!raffle)return send(res,200,{raffle:null,open:false,message:closedMessage(null),taken:''});return send(res,200,{raffle,open:salesOpen(raffle),message:salesOpen(raffle)?null:closedMessage(raffle),holdHours:holdMs()/3600000,maxPerPhone:MAX_PER_PHONE,taken:takenBitmap(raffle)});}
if(path==='/api/payment-info'&&req.method==='GET')return send(res,200,paymentInfo());
const publicPhoto=path.match(/^\/api\/raffles\/([a-f0-9]{24})\/photo$/);
if(publicPhoto&&['GET','HEAD'].includes(req.method)){const row=db.prepare("SELECT photo,photo_type FROM raffles WHERE id=? AND status IN ('active','closed')").get(publicPhoto[1]);if(!row?.photo)return send(res,404,{error:'Foto no disponible'});res.setHeader('Content-Type',row.photo_type);return res.end(req.method==='HEAD'?undefined:Buffer.from(row.photo));}
if(path==='/api/payments/submit'&&req.method==='POST'){
limits(req,'payment_submit',300,10);const b=await body(req,Math.ceil(RECEIPT_MAX/3)*4+4096);
if(typeof b.phone!=='string'||!/^\d{10}$/.test(b.phone)||typeof b.tracking!=='string'||b.tracking.length>100)return send(res,400,{error:'Revisa tu teléfono y la clave de rastreo.'});
// Each phone has at most one pending reservation per raffle, so the phone identifies what is being paid.
const row=db.prepare("SELECT id FROM reservations WHERE phone=? AND status='pending' AND expires>=? ORDER BY created DESC LIMIT 1").get(b.phone,Date.now());
if(!row){const paid=db.prepare("SELECT 1 FROM reservations WHERE phone=? AND status='paid' LIMIT 1").get(b.phone);return send(res,paid?409:404,{error:paid?'Los boletos de este teléfono ya tienen el pago confirmado. Revísalos en «Mis boletos».':'No encontramos boletos pendientes de pago con ese teléfono. Si tu apartado venció y ya pagaste, contáctanos con tu comprobante.'});}
const tracking=b.tracking.replace(/\s/g,'').toUpperCase();if(!/^[A-Z0-9]{6,64}$/.test(tracking))return send(res,400,{error:'La clave de rastreo o referencia debe tener de 6 a 64 letras o números.'});
if(!b.receipt)return send(res,400,{error:'Adjunta tu comprobante en JPG, PNG o PDF.'});
const receipt=receiptFile(b.receipt),id=randomBytes(12).toString('hex'),now=Date.now();
db.exec('BEGIN IMMEDIATE');
try{db.prepare('INSERT INTO payment_submissions(id,reservation,tracking,receipt,receipt_type,created) VALUES(?,?,?,?,?,?)').run(id,row.id,tracking,receipt.bytes,receipt.type,now);
// Keep the tickets held while the receipt waits for review.
db.prepare('UPDATE reservations SET expires=MAX(expires,?) WHERE id=?').run(now+REVIEW_HOLD,row.id);db.exec('COMMIT');}
catch(error){db.exec('ROLLBACK');if(String(error.code).includes('CONSTRAINT')||String(error.message).includes('UNIQUE'))return send(res,409,{error:'No se pudo registrar: ya hay un comprobante en revisión para este teléfono o la referencia ya fue utilizada.'});throw error;}
return send(res,201,{id,status:'pending',message:'¡Comprobante recibido! Tus boletos quedan apartados mientras revisamos tu pago. Consulta el estado en «Mis boletos» con tu teléfono.'});
}
if(path==='/api/tickets/random'&&req.method==='POST'){
limits(req,'random_tickets',1200,60);const b=await body(req);
if(!Number.isInteger(b.quantity)||b.quantity<1||b.quantity>MAX_PER_PHONE)return send(res,400,{error:`Elige entre 1 y ${MAX_PER_PHONE} boletos.`});
const raffle=activeRaffle();if(!salesOpen(raffle))return send(res,409,{error:closedMessage(raffle)});
const taken=new Set(takenNumbers(raffle.id));
const available=Array.from({length:raffle.ticket_count},(_,n)=>n).filter(n=>!taken.has(n));
if(available.length<b.quantity)return send(res,409,{error:`Solo quedan ${available.length} boletos disponibles. Reduce la cantidad.`,available:available.length});
for(let i=0;i<b.quantity;i++){const j=randomInt(i,available.length);[available[i],available[j]]=[available[j],available[i]];}
return send(res,200,{numbers:available.slice(0,b.quantity),quantity:b.quantity});
}
if(path==='/api/tickets/lookup'&&req.method==='POST'){
limits(req,'ticket_lookup',600,20);
const b=await body(req);
if(!['name','phone','email'].includes(b.method)||typeof b.value!=='string'||!b.value.trim()||b.value.length>254)return send(res,400,{error:'Elige cómo buscar y escribe tu nombre, teléfono o correo.'});
const value=b.method==='name'?normalizeName(b.value):b.value.trim().toLowerCase();
if(b.method==='phone'&&!/^\d{10}$/.test(value))return send(res,400,{error:'Escribe tu teléfono de 10 dígitos.'});
// Results only carry ticket numbers and statuses, never names, phones or emails.
const rows=db.prepare(`SELECT r.id,r.numbers,r.status,r.created,r.expires,r.amount_cents,f.prize,f.ticket_count,f.draw_at FROM reservations r LEFT JOIN raffles f ON f.id=r.raffle WHERE r.${{name:'name_key',phone:'phone',email:'email'}[b.method]}=? ORDER BY r.created DESC LIMIT 20`).all(value);
if(!rows.length)return send(res,404,{error:'No encontramos boletos con ese dato. Revisa que esté escrito igual que cuando apartaste.'});
const lastPayment=db.prepare('SELECT status,reason FROM payment_submissions WHERE reservation=? ORDER BY created DESC,id DESC LIMIT 1');
return send(res,200,{results:rows.map(row=>({numbers:JSON.parse(row.numbers),status:row.status,created:row.created,expires:row.expires,amount_cents:row.amount_cents,prize:row.prize,ticket_count:row.ticket_count,draw_at:row.draw_at,payment:lastPayment.get(row.id)||null}))});
}
if(path==='/api/reservations'&&req.method==='POST'){
limits(req,'reservations',600,20);
const b=await body(req);if(!Array.isArray(b.numbers)||b.numbers.length>MAX_PER_PHONE)return send(res,400,{error:`Selecciona de 1 a ${MAX_PER_PHONE} boletos`});const nums=[...new Set(b.numbers)];
const raffle=activeRaffle();if(!salesOpen(raffle))return send(res,409,{error:closedMessage(raffle)});
if(typeof b.name!=='string'||b.name.trim().length<3||b.name.length>100||typeof b.phone!=='string'||!/^\d{10}$/.test(b.phone)||!nums.length||nums.length>MAX_PER_PHONE||nums.some(n=>!Number.isInteger(n)||n<0||n>=raffle.ticket_count))return send(res,400,{error:`Revisa nombre, teléfono y boletos (máximo ${MAX_PER_PHONE}).`});
const email=b.email==null||b.email===''?null:typeof b.email==='string'?b.email.trim().toLowerCase():b.email;
if(email!==null&&!validEmail(email))return send(res,400,{error:'Revisa el correo electrónico.'});
const now=Date.now();let current,numbers,amount,expires;db.exec('BEGIN IMMEDIATE');
try{
// New tickets join the phone's pending reservation, so each phone pays a single total per raffle.
current=db.prepare("SELECT id,numbers,expires FROM reservations WHERE phone=? AND raffle=? AND status='pending' ORDER BY created DESC LIMIT 1").get(b.phone,raffle.id);
if(current&&db.prepare("SELECT 1 FROM payment_submissions WHERE reservation=? AND status='pending'").get(current.id)){db.exec('ROLLBACK');return send(res,409,{error:'Tienes un comprobante en revisión. Espera la confirmación de tu pago para apartar más boletos.'});}
const previous=current?JSON.parse(current.numbers):[];
if(previous.length+nums.length>MAX_PER_PHONE){db.exec('ROLLBACK');return send(res,429,{error:`Este teléfono ya tiene ${previous.length} boletos pendientes de pago; el máximo es ${MAX_PER_PHONE}. Paga tu apartado para poder apartar más.`});}
numbers=[...previous,...nums];amount=numbers.length*raffle.price_cents;expires=Math.max(current?.expires||0,now+holdMs());const id=current?.id||randomBytes(12).toString('hex');
if(current)db.prepare('UPDATE reservations SET numbers=?,amount_cents=?,expires=?,email=COALESCE(email,?) WHERE id=?').run(JSON.stringify(numbers),amount,expires,email,id);
else db.prepare('INSERT INTO reservations(id,name,phone,numbers,status,created,expires,email,raffle,amount_cents,name_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,b.name.trim(),b.phone,JSON.stringify(numbers),'pending',now,expires,email,raffle.id,amount,normalizeName(b.name));
for(const n of nums)db.prepare('INSERT INTO raffle_tickets VALUES(?,?,?)').run(raffle.id,n,id);db.exec('COMMIT');}catch{db.exec('ROLLBACK');return send(res,409,{error:'Algún boleto acaba de ser apartado. Actualiza tu selección.'});}
return send(res,201,{numbers,added:nums.length,amount_cents:amount,expires,message:numbers.length>nums.length?'¡Agregamos los boletos a tu apartado! Paga el nuevo total antes de que venza y envía tu comprobante con tu teléfono.':'¡Boletos apartados! Realiza tu pago antes de que venza el apartado y envía tu comprobante con tu teléfono.'});
}
if(path==='/api/login'&&req.method==='POST'){
if(!credentials.exists())return send(res,503,{error:'Administrador pendiente de configurar en el servidor.'});
limit('login',5,900000);const now=Date.now();
const b=await body(req);if(!credentials.verify(b.password))return send(res,401,{error:'Credenciales incorrectas'});
// Rotate only the session used by this browser; keep other devices signed in.
sessions.delete(token(req));for(const [key,s] of sessions)if(s.expires<=now||s.last+900000<=now)sessions.delete(key);
if(sessions.size>=20)return send(res,429,{error:'Se alcanzó el límite de sesiones. Cierra alguna o espera a que expire.'});
const sessionToken=randomBytes(32).toString('hex');sessions.set(sessionToken,{expires:now+3600000,last:now});audit('login');res.setHeader('Set-Cookie',cookie(sessionToken,3600));return send(res,200,{ok:true});
}
if(path.startsWith('/api/admin/')){
if(!admin(req))return send(res,401,{error:'Inicia sesión'});
if(path==='/api/admin/password'&&req.method==='POST'){limit('change_password',5,900000);const b=await body(req);if(!credentials.verify(b.currentPassword))return send(res,401,{error:'La contraseña actual no coincide.'});if(typeof b.newPassword!=='string'||b.newPassword.length<5||b.newPassword.length>200)return send(res,400,{error:'La contraseña debe tener entre 5 y 200 caracteres.'});credentials.save(b.newPassword);const current=token(req);for(const key of sessions.keys())if(key!==current)sessions.delete(key);audit('password_changed');return send(res,200,{ok:true});}
if(path==='/api/admin/payment-settings'&&req.method==='GET')return send(res,200,paymentInfo());
if(path==='/api/admin/payment-settings'&&req.method==='POST'){const info=paymentSettings(await body(req));db.prepare("INSERT INTO settings VALUES('payment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(info));audit('payment_settings_changed');return send(res,200,info);}
if(path==='/api/admin/raffles/dates'&&req.method==='POST'){const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id))return send(res,400,{error:'Rifa inválida'});const dates=raffleDates(b);const result=db.prepare('UPDATE raffles SET starts_at=?,ends_at=?,draw_at=? WHERE id=?').run(...dates,b.id);if(!result.changes)return send(res,404,{error:'Rifa no disponible'});audit('raffle_dates_changed',b.id);return send(res,200,{ok:true});}
if(path==='/api/admin/raffles/status'&&req.method==='POST'){
const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id)||!['draft','active','closed'].includes(b.status))return send(res,400,{error:'Revisa la rifa y el estado.'});
db.exec('BEGIN IMMEDIATE');try{
const raffle=db.prepare('SELECT id,status,starts_at,ends_at,draw_at FROM raffles WHERE id=?').get(b.id);
const fail=(status,error)=>{db.exec('ROLLBACK');return send(res,status,{error});};
if(!raffle)return fail(404,'Rifa no disponible');
if(b.status==='active'){if(!raffle.starts_at||!raffle.ends_at||!raffle.draw_at)return fail(400,'Guarda inicio, cierre y fecha del sorteo antes de poner la rifa en venta.');if(db.prepare("SELECT id FROM raffles WHERE status='active' AND id<>?").get(b.id))return fail(409,'Ya hay otra rifa en venta. Cierra sus ventas antes de activar esta.');}
if(b.status==='draft'&&db.prepare('SELECT 1 FROM reservations WHERE raffle=? LIMIT 1').get(b.id))return fail(409,'Esta rifa ya tiene apartados. Usa «Cerrar ventas» en lugar de regresarla a borrador.');
db.prepare('UPDATE raffles SET status=? WHERE id=?').run(b.status,b.id);audit('raffle_'+b.status,b.id);db.exec('COMMIT');return send(res,200,{ok:true});
}catch(error){db.exec('ROLLBACK');throw error;}}
if(path==='/api/admin/payments'&&req.method==='GET')return send(res,200,db.prepare('SELECT p.id,p.reservation,p.tracking,p.receipt_type,p.status,p.reason,p.created,p.reviewed,r.name,r.phone,r.numbers,r.amount_cents,r.status AS reservation_status,r.expires,f.prize FROM payment_submissions p JOIN reservations r ON r.id=p.reservation LEFT JOIN raffles f ON f.id=r.raffle ORDER BY p.created DESC,p.id DESC LIMIT 100').all());
const receiptMatch=path.match(/^\/api\/admin\/payments\/([a-f0-9]{24})\/receipt$/);
if(receiptMatch&&['GET','HEAD'].includes(req.method)){const row=db.prepare('SELECT receipt,receipt_type FROM payment_submissions WHERE id=?').get(receiptMatch[1]);if(!row)return send(res,404,{error:'Comprobante no disponible'});res.setHeader('Content-Type',row.receipt_type);res.setHeader('Content-Disposition','inline');return res.end(req.method==='HEAD'?undefined:Buffer.from(row.receipt));}
if(path==='/api/admin/payments/review'&&req.method==='POST'){
const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id)||!['approved','rejected'].includes(b.decision)||typeof b.reason!=='string'||b.reason.trim().length<5||b.reason.length>500)return send(res,400,{error:'Selecciona una decisión y escribe un motivo de 5 a 500 caracteres.'});
db.exec('BEGIN IMMEDIATE');try{const p=db.prepare('SELECT * FROM payment_submissions WHERE id=?').get(b.id);if(!p||p.status!=='pending'){db.exec('ROLLBACK');return send(res,409,{error:'El comprobante ya fue revisado o no existe.'});}
if(b.decision==='approved'){const changed=db.prepare("UPDATE reservations SET status='paid' WHERE id=? AND status='pending' AND expires>=?").run(p.reservation,Date.now());if(!changed.changes){db.exec('ROLLBACK');return send(res,409,{error:'El apartado venció o ya fue procesado. No se reasignaron boletos; requiere aclaración.'});}}
// A rejected receipt gives the participant the normal payment window again instead of the review hold.
else db.prepare("UPDATE reservations SET expires=MIN(expires,?) WHERE id=? AND status='pending'").run(Date.now()+holdMs(),p.reservation);
db.prepare('UPDATE payment_submissions SET status=?,reason=?,reviewed=? WHERE id=?').run(b.decision,b.reason.trim(),Date.now(),p.id);audit(b.decision==='approved'?'payment_confirmed':'payment_rejected',p.reservation);db.exec('COMMIT');if(b.decision==='approved')notifyApproved(p.reservation);return send(res,200,{ok:true});}catch(error){db.exec('ROLLBACK');throw error;}
}
if(path==='/api/admin/raffles'&&req.method==='GET')return send(res,200,db.prepare("SELECT f.id,f.prize,f.description,f.price_cents,f.ticket_count,f.status,f.created,f.starts_at,f.ends_at,f.draw_at,f.photo IS NOT NULL AS has_photo,(SELECT COUNT(*) FROM raffle_tickets t JOIN reservations r ON r.id=t.reservation WHERE t.raffle=f.id AND r.status='paid') AS sold,(SELECT COUNT(*) FROM raffle_tickets t JOIN reservations r ON r.id=t.reservation WHERE t.raffle=f.id AND r.status='pending') AS held FROM raffles f ORDER BY f.created DESC,f.id DESC LIMIT 100").all());
if(path==='/api/admin/raffles'&&req.method==='POST'){
limit('create_raffle',10,60000);const b=await body(req,1500000);
if(typeof b.prize!=='string'||b.prize.trim().length<3||b.prize.length>120||typeof b.description!=='string'||!b.description.trim()||b.description.length>5000||typeof b.price!=='string'||!/^\d{1,7}(?:\.\d{1,2})?$/.test(b.price)||!Number.isInteger(b.ticketCount)||b.ticketCount<1||b.ticketCount>MAX_TICKETS)return send(res,400,{error:'Revisa premio, descripción, precio y cantidad (1 a 100,000 boletos).'});
const cents=Math.round(Number(b.price)*100);if(cents<1||cents>100000000)return send(res,400,{error:'El precio debe estar entre $0.01 y $1,000,000 MXN.'});
const dates=raffleDates(b),photo=rafflePhoto(b.photo),id=randomBytes(12).toString('hex');db.exec('BEGIN IMMEDIATE');try{db.prepare("INSERT INTO raffles(id,prize,description,price_cents,ticket_count,status,photo,photo_type,created,starts_at,ends_at,draw_at) VALUES(?,?,?,?,?,'draft',?,?,?,?,?,?)").run(id,b.prize.trim(),b.description.trim(),cents,b.ticketCount,photo.bytes,photo.type,Date.now(),...dates);audit('raffle_created',id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return send(res,201,{id,status:'draft',message:'Rifa guardada como borrador. Pulsa «Poner en venta» cuando quieras publicarla.'});
}
const photoMatch=path.match(/^\/api\/admin\/raffles\/([a-f0-9]{24})\/photo$/);
if(photoMatch&&['GET','HEAD'].includes(req.method)){const row=db.prepare('SELECT photo,photo_type FROM raffles WHERE id=?').get(photoMatch[1]);if(!row?.photo)return send(res,404,{error:'Foto no disponible'});res.setHeader('Content-Type',row.photo_type);res.setHeader('Content-Length',row.photo.length);res.setHeader('Content-Disposition','inline');return res.end(req.method==='HEAD'?undefined:Buffer.from(row.photo));}
if(path==='/api/admin/logout'&&req.method==='POST'){sessions.delete(token(req));audit('logout');res.setHeader('Set-Cookie',cookie('',0));return send(res,200,{ok:true});}
if(path==='/api/admin/reservations'&&req.method==='GET')return send(res,200,db.prepare('SELECT r.*,f.prize FROM reservations r LEFT JOIN raffles f ON f.id=r.raffle ORDER BY r.created DESC LIMIT 500').all());
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
