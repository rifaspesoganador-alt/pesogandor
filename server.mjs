import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import {createHash,randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
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
for(const column of ['starts_at','ends_at','draw_at','goal_percent','rescheduled'])if(!hasColumn('raffles',column))db.exec(`ALTER TABLE raffles ADD COLUMN ${column} INTEGER`);
// Former demo previews go back to draft: going on sale is always an explicit admin action.
db.exec("UPDATE raffles SET status='draft' WHERE status='published_demo'");
// Tickets belong to a raffle; the legacy global `tickets` table is kept untouched for old databases.
db.exec('CREATE TABLE IF NOT EXISTS raffle_tickets(raffle TEXT NOT NULL,number INTEGER NOT NULL,reservation TEXT NOT NULL,PRIMARY KEY(raffle,number)); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
const sessions=new Map();
db.exec("CREATE TABLE IF NOT EXISTS payment_submissions(id TEXT PRIMARY KEY,reservation TEXT NOT NULL,tracking TEXT NOT NULL UNIQUE,receipt BLOB NOT NULL,receipt_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reason TEXT,created INTEGER NOT NULL,reviewed INTEGER); CREATE UNIQUE INDEX IF NOT EXISTS one_pending_payment ON payment_submissions(reservation) WHERE status='pending';");
const credentials=credentialStore(db,process.env.ADMIN_PASSWORD);
if(production&&!credentials.exists())throw Error('Configura ADMIN_PASSWORD de al menos 5 caracteres para el primer arranque.');
function raffleDates(b){const values=[b.startsAt,b.endsAt,b.drawAt];if(values.some(value=>typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-06:00$/.test(value)))throw problem(400,'Indica inicio, cierre y sorteo en hora del centro de México.');const dates=values.map(Date.parse);if(dates.some((n,i)=>!Number.isFinite(n)||new Date(n-21600000).toISOString().slice(0,16)!==values[i].slice(0,16))||dates[0]>=dates[1]||dates[1]>dates[2])throw problem(400,'El inicio debe ser anterior al cierre y el sorteo debe ser igual o posterior al cierre.');return dates;}
// No per-person ticket cap: a buyer may take any number of available tickets. The reservation body is sized for a whole 100,000-ticket raffle.
const MAX_TICKETS=100000,REVIEW_HOLD=48*3600000,RESERVATION_BODY=1100000;
function paymentInfo(){const row=db.prepare("SELECT value FROM settings WHERE key='payment'").get();return row?JSON.parse(row.value):null;}
function holdMs(){return (paymentInfo()?.holdHours||5)*3600000;}
// One-time raise: a saved payment window under 5 hours becomes 5 hours (afterwards the panel setting rules again).
if(!db.prepare("SELECT 1 FROM settings WHERE key='hold_min_5h'").get()){const info=paymentInfo();if(info&&info.holdHours<5)db.prepare("UPDATE settings SET value=? WHERE key='payment'").run(JSON.stringify({...info,holdHours:5}));db.prepare("INSERT INTO settings VALUES('hold_min_5h','1')").run();}
// Several raffles can be on sale at once. Without an id the newest one is used; an unknown or closed id gives none.
const RAFFLE_COLUMNS="id,prize,description,price_cents,ticket_count,starts_at,ends_at,draw_at,COALESCE(rescheduled,0) AS rescheduled,photo IS NOT NULL AS has_photo";
function activeRaffle(id){if(id==null)return db.prepare(`SELECT ${RAFFLE_COLUMNS} FROM raffles WHERE status='active' ORDER BY created DESC LIMIT 1`).get();return typeof id==='string'&&/^[a-f0-9]{24}$/.test(id)?db.prepare(`SELECT ${RAFFLE_COLUMNS} FROM raffles WHERE id=? AND status='active'`).get(id):undefined;}
function activeRaffles(){return db.prepare("SELECT id,prize,price_cents,ticket_count,starts_at,ends_at,draw_at,photo IS NOT NULL AS has_photo FROM raffles WHERE status='active' ORDER BY created DESC").all().map(raffle=>({...raffle,open:salesOpen(raffle)}));}
// Shared checks for creating and editing a raffle; the sales goal defaults to 80% of the tickets.
function raffleFields(b){
if(typeof b.prize!=='string'||b.prize.trim().length<3||b.prize.length>120||typeof b.description!=='string'||!b.description.trim()||b.description.length>5000||typeof b.price!=='string'||!/^\d{1,7}(?:\.\d{1,2})?$/.test(b.price)||!Number.isInteger(b.ticketCount)||b.ticketCount<1||b.ticketCount>MAX_TICKETS)throw problem(400,'Revisa premio, descripción, precio y cantidad (1 a 100,000 boletos).');
const cents=Math.round(Number(b.price)*100);if(cents<1||cents>100000000)throw problem(400,'El precio debe estar entre $0.01 y $1,000,000 MXN.');
const goal=b.goalPercent==null?80:b.goalPercent;if(!Number.isInteger(goal)||goal<1||goal>100)throw problem(400,'La meta de venta debe ser de 1% a 100%.');
return {prize:b.prize.trim(),description:b.description.trim(),cents,ticketCount:b.ticketCount,goal};}
function mxDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-06:00$/.test(value))return NaN;const n=Date.parse(value);return Number.isFinite(n)&&new Date(n-21600000).toISOString().slice(0,16)===value.slice(0,16)?n:NaN;}
function salesOpen(raffle,now=Date.now()){return !!raffle&&!!paymentInfo()&&now>=raffle.starts_at&&now<raffle.ends_at;}
function closedMessage(raffle){if(!raffle)return 'No hay una rifa en venta en este momento.';if(!paymentInfo())return 'La venta abrirá en cuanto publiquemos los datos de pago.';return Date.now()<raffle.starts_at?'La venta de boletos aún no comienza.':'La venta de boletos ya cerró.';}
function takenNumbers(raffleId){return db.prepare('SELECT number FROM raffle_tickets WHERE raffle=? ORDER BY number').all(raffleId).map(x=>x.number);}
// One bit per ticket keeps the public availability payload small (about 17 KB for 100,000 tickets).
function takenBitmap(raffle){const bits=Buffer.alloc(Math.ceil(raffle.ticket_count/8));for(const n of takenNumbers(raffle.id))bits[n>>3]|=1<<(n&7);return bits.toString('base64');}
const money=cents=>new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(cents/100);
// Sends a WhatsApp text through WAHA (WhatsApp HTTP API).
function waha(){const headers={'Content-Type':'application/json',Accept:'application/json'};if(process.env.WAHA_API_KEY)headers['X-Api-Key']=process.env.WAHA_API_KEY;return {base:(process.env.WAHA_URL||'').replace(/\/+$/,''),session:process.env.WAHA_SESSION||'default',headers};}
async function wahaText(chatId,text){const {base,session,headers}=waha();const res=await fetch(`${base}/api/sendText`,{method:'POST',headers,body:JSON.stringify({session,chatId,text}),signal:AbortSignal.timeout(15000)});if(!res.ok)throw problem(res.status,'waha_send_failed');}
async function sendWhatsApp(phone,text){
const {base,session,headers}=waha();
// Mexican mobiles can be registered on WhatsApp as 52 or 521 + 10 digits; WAHA reports the real chat id.
let chatId=`52${phone}@c.us`;
try{const check=await fetch(`${base}/api/contacts/check-exists?phone=52${phone}&session=${encodeURIComponent(session)}`,{headers,signal:AbortSignal.timeout(10000)});if(check.ok){const found=await check.json();if(found.numberExists===false)throw problem(404,'number_not_on_whatsapp');if(found.chatId)chatId=found.chatId;}}catch(error){if(error.status===404)throw error;}
await wahaText(chatId,text);
}
// Admin WhatsApp group: WAHA posts its messages to /api/waha/webhook and «menu», «corte» and «boletos» are answered there.
// Only the group in WAHA_ADMIN_GROUP is answered, and only when the webhook carries WAHA_WEBHOOK_SECRET.
const adminGroup=process.env.WAHA_ADMIN_GROUP||'',webhookSecret=process.env.WAHA_WEBHOOK_SECRET||'';
const sha256=value=>createHash('sha256').update(value).digest();
const validSecret=value=>typeof value==='string'&&timingSafeEqual(sha256(value),sha256(webhookSecret));
const answered=new Map();
const mxTime=ms=>new Date(ms).toLocaleString('es-MX',{timeZone:'America/Mexico_City',dateStyle:'medium',timeStyle:'short'});
function botCommand(text){if(typeof text!=='string'||text.length>40)return null;const word=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/^[/!#.]+/,'');return {menu:'menu',ayuda:'menu',corte:'corte',boletos:'boletos',boleto:'boletos','1':'corte','2':'boletos'}[word]||null;}
// Raffles on sale, plus closed ones whose draw is still ahead.
function reportRaffles(){return db.prepare("SELECT id,prize,price_cents,ticket_count,status,ends_at,draw_at,COALESCE(goal_percent,80) AS goal FROM raffles WHERE status='active' OR (status='closed' AND draw_at>=?) ORDER BY created").all(Date.now());}
function raffleSales(raffle){
const rows=db.prepare("SELECT r.name,r.phone,r.numbers,r.status,r.amount_cents,r.expires,EXISTS(SELECT 1 FROM payment_submissions p WHERE p.reservation=r.id AND p.status='pending') AS review FROM reservations r WHERE r.raffle=? AND r.status IN ('paid','pending') ORDER BY r.created").all(raffle.id);
const groups={paid:{count:0,cents:0,numbers:[]},review:{count:0,cents:0},unpaid:{count:0,cents:0},pending:[]};
for(const row of rows){const numbers=JSON.parse(row.numbers),cents=row.amount_cents??numbers.length*raffle.price_cents,group=row.status==='paid'?groups.paid:row.review?groups.review:groups.unpaid;group.count+=numbers.length;group.cents+=cents;if(row.status==='paid')group.numbers.push(...numbers);else groups.pending.push({...row,numbers,cents});}
return groups;}
function ticketRanges(numbers,width){const sorted=[...numbers].sort((a,b)=>a-b),pad=n=>String(n).padStart(width,'0'),out=[];for(let i=0;i<sorted.length;i++){let j=i;while(j+1<sorted.length&&sorted[j+1]===sorted[j]+1)j++;out.push(j>i?`${pad(sorted[i])}-${pad(sorted[j])}`:pad(sorted[i]));i=j;}return out.join(', ');}
function menuText(){return ['🎟️ *Peso Ganador · Menú*','','*1* o *corte*: resumen de ventas','*2* o *boletos*: boletos vendidos y pendientes','*menu*: este menú'].join('\n');}
function corteText(){
const raffles=reportRaffles(),lines=['📊 *Corte · Peso Ganador*',mxTime(Date.now())];let total=0;
if(!raffles.length)lines.push('','No hay rifas en venta.');
for(const raffle of raffles){const s=raffleSales(raffle),taken=s.paid.count+s.review.count+s.unpaid.count,goal=Math.ceil(raffle.ticket_count*raffle.goal/100);total+=s.paid.cents;
lines.push('',`*${raffle.prize}*${raffle.status==='closed'?' (ventas cerradas)':''}`,`✅ Vendidos: ${s.paid.count} · ${money(s.paid.cents)}`,`🧾 En revisión: ${s.review.count} · ${money(s.review.cents)}`,`⏳ Sin pagar: ${s.unpaid.count} · ${money(s.unpaid.cents)}`,`🎟️ Disponibles: ${raffle.ticket_count-taken} de ${raffle.ticket_count}`,`🎯 Meta ${raffle.goal}%: ${s.paid.count} de ${goal} (${Math.floor(s.paid.count*100/goal)}%)`);}
const reviews=db.prepare("SELECT COUNT(*) AS n FROM payment_submissions WHERE status='pending'").get().n;
const visits=visitStats(),people=n=>`${n} ${n===1?'persona':'personas'}`;
lines.push('',`💰 Total cobrado: ${money(total)}`,`📥 Comprobantes por revisar: ${reviews}`,`👀 Visitas hoy: ${people(visits.today.visitors)} · 7 días: ${people(visits.week.visitors)}`);return lines.join('\n');}
function boletosTexts(){
const raffles=reportRaffles();if(!raffles.length)return ['🎟️ No hay rifas en venta.'];
return raffles.map(raffle=>{const s=raffleSales(raffle),width=Math.max(3,String(raffle.ticket_count-1).length),taken=s.paid.count+s.review.count+s.unpaid.count;
const lines=[`🎟️ *Boletos · ${raffle.prize}*`,'',`✅ *Vendidos (${s.paid.count}):* ${s.paid.count?ticketRanges(s.paid.numbers,width):'ninguno'}`,'',`⏳ *Pendientes (${s.review.count+s.unpaid.count}):*${s.pending.length?'':' ninguno'}`];
for(const r of s.pending)lines.push(`• ${r.name} · ${r.phone}: ${ticketRanges(r.numbers,width)} · ${money(r.cents)} · ${r.review?'🧾 en revisión':`vence ${mxTime(r.expires)}`}`);
lines.push('',`🎟️ Disponibles: ${raffle.ticket_count-taken} de ${raffle.ticket_count}`);return lines.join('\n');});}
// WhatsApp texts stay well under its limit; long lists are split on line breaks and capped at a few messages.
function chunks(text){const max=3500,out=[];let current='';for(const line of text.split('\n'))for(const piece of line.match(/[^]{1,3500}/g)||['']){if(current&&current.length+piece.length+1>max){out.push(current);current=piece;}else current=current?`${current}\n${piece}`:piece;}if(current.trim())out.push(current);return out;}
async function answerAdmin(command){
let texts=command==='menu'?[menuText()]:command==='corte'?chunks(corteText()):boletosTexts().flatMap(text=>chunks(text));
if(texts.length>6)texts=[...texts.slice(0,6),'… La lista sigue. Revisa el detalle completo en el panel, sección Participaciones.'];
for(const text of texts)await wahaText(adminGroup,text);}
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
// Contacts: every phone that reserves is kept (name, first and last time seen) so the panel can announce new raffles and draws.
// Anyone stops the announcements by answering BAJA (or is marked by hand in the panel); opted-out phones get nothing from the outbox.
db.exec("CREATE TABLE IF NOT EXISTS contacts(phone TEXT PRIMARY KEY,name TEXT,created INTEGER NOT NULL,last_seen INTEGER NOT NULL,opted_out INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,phone TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,ref TEXT,batch TEXT,status TEXT NOT NULL DEFAULT 'queued',created INTEGER NOT NULL,sent INTEGER,error TEXT); CREATE INDEX IF NOT EXISTS outbox_queue ON outbox(status,id); CREATE INDEX IF NOT EXISTS outbox_ref ON outbox(kind,ref);");
db.exec("INSERT OR IGNORE INTO contacts(phone,name,created,last_seen) SELECT phone,name,MIN(created),MAX(created) FROM reservations WHERE phone GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' GROUP BY phone");
function saveContact(phone,name,now){db.prepare('INSERT INTO contacts(phone,name,created,last_seen) VALUES(?,?,?,?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen').run(phone,name,now,now);}
const BROADCAST_FOOTER='\n\nSi ya no quieres recibir avisos, responde BAJA.';
// Messages wait in the outbox and go out one at a time: expiry notices first, announcements every 8 to 16 seconds so the number is not flagged as spam.
function queueMessage(phone,text,kind,ref=null,batch=null){if(!process.env.WAHA_URL||db.prepare('SELECT opted_out FROM contacts WHERE phone=?').get(phone)?.opted_out)return false;
if(ref&&db.prepare('SELECT 1 FROM outbox WHERE kind=? AND ref=?').get(kind,ref))return false;
db.prepare('INSERT INTO outbox(phone,text,kind,ref,batch,created) VALUES(?,?,?,?,?,?)').run(phone,text,kind,ref,batch,Date.now());return true;}
function expiredText(r){const width=Math.max(3,String((r.ticket_count||1)-1).length),all=JSON.parse(r.numbers).map(n=>String(n).padStart(width,'0')),shown=all.length>40?`${all.slice(0,40).join(', ')} y ${all.length-40} más`:all.join(', ');
const site=origin.replace(/^https?:\/\//,''),contact=paymentInfo()?.whatsapp,first=String(r.name||'').trim().split(/\s+/)[0];
return [`Hola${first?`, ${first}`:''}. ⏰ Tu apartado en Peso Ganador venció porque no recibimos tu pago a tiempo.`,'',r.prize&&`Rifa: ${r.prize}`,`Boletos liberados: ${shown}`,'',r.raffle_status==='active'?`Esos boletos ya están disponibles otra vez. Si todavía los quieres, entra a ${site} y vuelve a apartarlos (mientras nadie más los tome).`:'Esos boletos quedaron disponibles de nuevo.','',contact?`¿Ya habías pagado? Escríbenos al ${contact} con tu comprobante y lo revisamos.`:'¿Ya habías pagado? Responde a este mensaje con tu comprobante y lo revisamos.'].filter(line=>line!==null&&line!==undefined&&line!==false).join('\n');}
let outboxBusy=false,outboxNext=0;
async function drainOutbox(){if(outboxBusy||!process.env.WAHA_URL||Date.now()<outboxNext)return;
const row=db.prepare("SELECT id,phone,text,kind FROM outbox WHERE status='queued' ORDER BY CASE kind WHEN 'expired' THEN 0 ELSE 1 END,id LIMIT 1").get();if(!row)return;
outboxBusy=true;const mark=(status,error=null)=>db.prepare('UPDATE outbox SET status=?,sent=?,error=? WHERE id=?').run(status,Date.now(),error,row.id);
try{if(db.prepare('SELECT opted_out FROM contacts WHERE phone=?').get(row.phone)?.opted_out)mark('skipped');else{await sendWhatsApp(row.phone,row.text);mark('sent');}}
catch(error){mark('failed',String(error.message||'error').slice(0,200));}
finally{outboxBusy=false;outboxNext=Date.now()+(row.kind==='broadcast'?randomInt(8000,16001):3000);}}
setInterval(()=>{drainOutbox().catch(error=>console.error('outbox_failed',error.message));},2000).unref();
function broadcastStatus(){return db.prepare("SELECT batch,MIN(created) AS created,COUNT(*) AS total,SUM(status='queued') AS queued,SUM(status='sent') AS sent,SUM(status='failed') AS failed,SUM(status IN ('skipped','cancelled')) AS skipped FROM outbox WHERE kind='broadcast' GROUP BY batch ORDER BY created DESC LIMIT 1").get()||null;}
// «BAJA» stops announcements and «ALTA» brings them back; anything else in a private chat is ignored.
// Automatic answer for people who write from an ad («¡Hola! Quiero más información»). The text and the trigger words are edited in Panel → Ajustes.
const AUTO_REPLY_DEFAULT={enabled:true,keywords:'información, informes, info, precio, costo',text:`🍀 *EL PESO GANADOR* 🍀
¡Hola! Gracias por escribirnos. Aquí tienes toda la información de nuestra rifa:

💸 *PREMIO MAYOR: $50,000 MXN*
🎁 *+ 4 BONOS de $2,500 MXN cada uno*

🎟️ *Precio por boleto: $1.60 MXN*
Puedes apartar los boletos que quieras: entre más tengas, más oportunidades de ganar.

🎯 *¿Cómo se eligen los ganadores?*
Usamos los resultados oficiales de los sorteos de Pronósticos. Gana el boleto que coincida con los *últimos 5 dígitos* del resultado de cada sorteo:
• *Premio mayor ($50,000)* → Tris Clásico
• *Bono 1 ($2,500)* → Melate
• *Bono 2 ($2,500)* → Revancha
• *Bono 3 ($2,500)* → Revanchita
• *Bono 4 ($2,500)* → Chispazo

⚠️ *IMPORTANTE*
1. Para ganar los bonos necesitas comprar *más de 100 boletos*, seguir nuestra página de Facebook y unirte a nuestro canal de WhatsApp.
2. Los premios no son válidos si se desprecian boletos.

📺 *Transmisión EN VIVO*
Anunciaremos a los ganadores en vivo por nuestra página de Facebook ➡️ *EL PESO GANADOR* ⬅️ el *29 de noviembre a las 8:30 pm* 🍀

🛒 *¿Cómo apartar tus boletos?*
1. Entra a pesoganador.com
2. Elige tus números y apártalos con tu nombre y teléfono.
3. Paga y envía tu comprobante desde la misma página antes de que venza tu apartado.

📲 ¡Aparta tus números hoy mismo y no te quedes fuera!`,followEnabled:true,followHours:2,followText:`¡Hola! 👋 Hace un rato te compartimos la información de la rifa de *El Peso Ganador* 🍀

¿Te quedó alguna duda o necesitas ayuda para apartar tus boletos? Responde a este mensaje y con gusto te ayudamos. También puedes apartarlos directo en pesoganador.com

📢 Únete a nuestro canal de WhatsApp *El Peso Ganador* para enterarte de nuevas rifas, resultados y transmisiones en vivo:
https://whatsapp.com/channel/0029VbEdGGJEFeXhw2C8xJ2z`};
function autoReplyConfig(){const row=db.prepare("SELECT value FROM settings WHERE key='auto_reply'").get();return row?{...AUTO_REPLY_DEFAULT,...JSON.parse(row.value)}:AUTO_REPLY_DEFAULT;}
const plainText=text=>text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function wantsInfo(text,keywords){if(typeof text!=='string'||!text.trim()||text.length>400)return false;const said=` ${plainText(text)} `;return String(keywords||'').split(',').map(plainText).filter(Boolean).some(word=>said.includes(` ${word} `));}
db.exec('CREATE TABLE IF NOT EXISTS auto_replies(chat TEXT PRIMARY KEY,last INTEGER NOT NULL)');
for(const column of ['last_in','last_out','followup'])if(!hasColumn('auto_replies',column))db.exec(`ALTER TABLE auto_replies ADD COLUMN ${column} INTEGER`);
const AUTO_REPLY_GAP=12*3600000;
// Follow-up: a chat that got the info text and then stayed silent (no message from them, no manual answer from us, no tickets reserved)
// receives followText once, followHours after the info. Chats older than a day are left alone.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));let followRunning=false;
async function sendFollowUps(){if(followRunning||!process.env.WAHA_URL)return;const config=autoReplyConfig();if(!config.followEnabled||!config.followText)return;followRunning=true;
try{const now=Date.now(),due=now-config.followHours*3600000;
const rows=db.prepare('SELECT chat,last FROM auto_replies WHERE followup IS NULL AND last<=? AND last>=? AND COALESCE(last_in,0)<last AND COALESCE(last_out,0)<last ORDER BY last LIMIT 20').all(due,now-86400000);
for(const row of rows){const phone=row.chat.split('@')[0].replace(/\D/g,'').slice(-10),isPhone=/@(c\.us|s\.whatsapp\.net)$/.test(row.chat);
const skip=isPhone&&(db.prepare('SELECT 1 FROM contacts WHERE phone=? AND opted_out=1').get(phone)||db.prepare('SELECT 1 FROM reservations WHERE phone=? AND created>=? LIMIT 1').get(phone,row.last));
// Marked before sending, so a failure or a restart never sends it twice.
const marked=db.prepare('UPDATE auto_replies SET followup=? WHERE chat=? AND followup IS NULL').run(skip?-1:now,row.chat).changes;if(!marked||skip)continue;
try{await wahaText(row.chat,config.followText);audit('whatsapp_follow_up');}catch(error){console.error('whatsapp_follow_up_failed',error.message);}await sleep(4000);}}
finally{followRunning=false;}}
setInterval(()=>{sendFollowUps().catch(error=>console.error('follow_up_failed',error.message));},60000).unref();
function optWord(text){if(typeof text!=='string'||text.length>20)return null;const word=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/[.!¡]+/g,'');return {baja:'out',stop:'out',alto:'out',alta:'in'}[word]||null;}
// Static files and prize photos carry an ETag: browsers reuse their copy (304) until the content changes.
// Images may be reused for a week without asking; pages, styles and scripts are revalidated on every visit.
const staticCache=new Map(),etagOf=body=>`"${createHash('sha1').update(body).digest('base64url')}"`;
function staticFile(name){let entry=staticCache.get(name);if(!entry){const body=readFileSync(new URL(`public/${name}`,import.meta.url));entry={body,etag:etagOf(body)};staticCache.set(name,entry);}return entry;}
function sendCached(req,res,body,etag,type,maxAge){res.setHeader('Content-Type',type);res.setHeader('ETag',etag);res.setHeader('Cache-Control',maxAge?`public, max-age=${maxAge}`:'no-cache');if(req.headers['if-none-match']===etag){res.writeHead(304);return res.end();}res.setHeader('Content-Length',body.length);return res.end(req.method==='HEAD'?undefined:body);}
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
function expire(){const now=Date.now();
// Each buyer whose hold runs out gets one WhatsApp saying the tickets are free again (queued, sent at a steady pace).
const ending=db.prepare("SELECT r.id,r.name,r.phone,r.numbers,f.prize,f.ticket_count,f.status AS raffle_status FROM reservations r LEFT JOIN raffles f ON f.id=r.raffle WHERE r.status='pending' AND r.expires < ?").all(now);
db.prepare("DELETE FROM raffle_tickets WHERE reservation IN (SELECT id FROM reservations WHERE status='pending' AND expires < ?)").run(now);db.prepare("DELETE FROM tickets WHERE reservation IN (SELECT id FROM reservations WHERE status='pending' AND expires < ?)").run(now);db.prepare("UPDATE reservations SET status='expired' WHERE status='pending' AND expires < ?").run(now);
for(const r of ending)if(r.phone)queueMessage(r.phone,expiredText(r),'expired',r.id);}
function problem(status,message){return Object.assign(Error(message),{status});}
async function body(req,maxBytes=8192){
if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw problem(415,'Se requiere application/json');
if(Number(req.headers['content-length'])>maxBytes)throw problem(413,'Solicitud demasiado grande');
const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw problem(413,'Solicitud demasiado grande');chunks.push(chunk);}
let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw problem(400,'JSON inválido');}
if(!value||typeof value!=='object'||Array.isArray(value))throw problem(400,'Se requiere un objeto JSON');return value;
}
// JPEG start-of-frame markers (baseline, progressive, lossless and arithmetic variants) that carry the image size.
const JPEG_FRAMES=new Set([192,193,194,195,197,198,199,201,202,203,205,206,207]);
function rafflePhoto(photo,{maxBytes=1048576,maxSide=4096,label='foto'}={}){
if(photo==null)return {bytes:null,type:null};
const sizeError=`Usa una ${label} JPG o PNG de máximo ${maxBytes/1048576} MB.`;
if(!photo||typeof photo!=='object'||!['image/png','image/jpeg'].includes(photo.type)||typeof photo.base64!=='string'||photo.base64.length>Math.ceil(maxBytes/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(photo.base64))throw problem(400,sizeError);
let bytes=Buffer.from(photo.base64,'base64'),width=0,height=0;
if(bytes.length<45||bytes.length>maxBytes||bytes.toString('base64')!==photo.base64)throw problem(400,sizeError);
if(photo.type==='image/png'){
if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND')throw problem(400,`La ${label} PNG no es válida.`);
width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
}else{
if(bytes[0]!==255||bytes[1]!==216)throw problem(400,`La ${label} JPG no es válida.`);
// Phones often append data after the image (motion photos, maker trailers). The image ends at the first end marker
// after the scan data; whatever follows is dropped instead of rejecting the photo.
let offset=2,end=-1;
while(offset+4<bytes.length){if(bytes[offset]!==255)break;while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===217)break;if(marker===1||marker>=208&&marker<=215)continue;const size=bytes.readUInt16BE(offset);if(size<2||offset+size>bytes.length)break;
if(JPEG_FRAMES.has(marker)&&size>=8&&!width){height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);}
if(marker===218){for(let i=offset+size;i+1<bytes.length;i++)if(bytes[i]===255&&bytes[i+1]===217){end=i+2;break;}break;}
offset+=size;}
if(end<0)throw problem(400,`La ${label} JPG no es válida.`);
if(end<bytes.length)bytes=Buffer.from(bytes.subarray(0,end));
}
if(!width||!height||width>maxSide||height>maxSide)throw problem(400,`La ${label} debe medir como máximo ${maxSide} × ${maxSide} píxeles.`);
return {bytes,type:photo.type};
}
const RECEIPT_MAX=5242880;
// Prize photos: the panel already shrinks them to 2000 px JPEG; the server still accepts up to 5 MB and 8000 px.
const PRIZE_PHOTO={maxBytes:5242880,maxSide:8000},PRIZE_BODY=Math.ceil(PRIZE_PHOTO.maxBytes/3)*4+16384;
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
if(info.whatsapp&&!/^\d{10,15}$/.test(info.whatsapp))throw problem(400,'El WhatsApp debe tener de 10 a 15 dígitos.');if(!Number.isInteger(info.holdHours)||info.holdHours<1||info.holdHours>72)throw problem(400,'El tiempo para pagar debe ser de 1 a 72 horas.');
return info;
}
const cookieName=production?'__Host-session':'session';
function token(req){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);}
function admin(req){const now=Date.now(),s=sessions.get(token(req));if(!s||s.expires<=now||s.last+900000<=now)return false;s.last=now;return true;}
function cookie(value,age){return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${production||origin.startsWith('https:')?'; Secure':''}`;}
function audit(event,id=null){db.prepare('INSERT INTO audit(event,reservation,created) VALUES(?,?,?)').run(event,id,Date.now());}
// Behind Traefik (TRUST_PROXY=1) the last X-Forwarded-For entry is the one the proxy added; earlier entries come from the client.
function clientIp(req){if(process.env.TRUST_PROXY==='1'){const chain=String(req.headers['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean);if(chain.length)return chain[chain.length-1];}return req.socket.remoteAddress||'unknown';}
// Visit counter for the public page, shown only in the panel. Devices where the admin signed in carry an owner cookie and are never counted.
// A visitor counts once per day through a salted hash of IP and browser: no IP is stored, and the daily hashes are kept 31 days.
db.exec('CREATE TABLE IF NOT EXISTS visit_days(day TEXT PRIMARY KEY,views INTEGER NOT NULL DEFAULT 0,visitors INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS visitors(day TEXT NOT NULL,visitor TEXT NOT NULL,PRIMARY KEY(day,visitor));');
const visitSalt=(()=>{const row=db.prepare("SELECT value FROM settings WHERE key='visit_salt'").get();if(row)return row.value;const salt=randomBytes(16).toString('hex');db.prepare("INSERT INTO settings VALUES('visit_salt',?)").run(salt);return salt;})();
const OWNER_COOKIE='pg_owner',BOT_AGENT=/bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|headless|lighthouse/i;
const mxDay=(ms=Date.now())=>new Date(ms).toLocaleDateString('en-CA',{timeZone:'America/Mexico_City'});
function ownerDevice(req){if((req.headers.cookie||'').split(';').some(x=>x.trim()===`${OWNER_COOKIE}=1`))return true;const s=sessions.get(token(req));return !!s&&s.expires>Date.now();}
function countVisit(req){
const agent=String(req.headers['user-agent']||'');if(!agent||BOT_AGENT.test(agent)||ownerDevice(req)||/prefetch|prerender/i.test(String(req.headers['sec-purpose']||req.headers.purpose||'')))return;
const day=mxDay(),visitor=createHash('sha256').update(`${visitSalt}|${clientIp(req)}|${agent}`).digest('base64url').slice(0,22);
const fresh=db.prepare('INSERT OR IGNORE INTO visitors VALUES(?,?)').run(day,visitor).changes;
db.prepare('INSERT INTO visit_days(day,views,visitors) VALUES(?,1,?) ON CONFLICT(day) DO UPDATE SET views=views+1,visitors=visitors+excluded.visitors').run(day,fresh);}
function visitStats(){
const since=days=>mxDay(Date.now()-(days-1)*86400000),views=from=>db.prepare('SELECT COALESCE(SUM(views),0) AS n FROM visit_days WHERE day>=?').get(from).n,people=from=>db.prepare('SELECT COUNT(DISTINCT visitor) AS n FROM visitors WHERE day>=?').get(from).n;
const range=from=>({views:views(from),visitors:people(from)});
// Last 14 days for the panel chart, oldest first; days without visits come back as zero.
const stored=new Map(db.prepare('SELECT day,views,visitors FROM visit_days WHERE day>=?').all(since(14)).map(row=>[row.day,row])),days=[];
for(let i=13;i>=0;i--){const day=mxDay(Date.now()-i*86400000),row=stored.get(day);days.push({day,views:row?.views||0,visitors:row?.visitors||0});}
return {today:range(since(1)),week:range(since(7)),month:range(since(30)),total:{views:views('0000-00-00')},days};}
// Money and tickets of the raffles on sale (or closed with the draw still ahead), for the panel overview.
function salesSummary(){const totals={paid:0,review:0,unpaid:0};
const raffles=reportRaffles().map(raffle=>{const s=raffleSales(raffle);totals.paid+=s.paid.cents;totals.review+=s.review.cents;totals.unpaid+=s.unpaid.cents;
return {id:raffle.id,prize:raffle.prize,status:raffle.status,ticket_count:raffle.ticket_count,goal:raffle.goal,ends_at:raffle.ends_at,draw_at:raffle.draw_at,paid:s.paid.count,review:s.review.count,unpaid:s.unpaid.count,paid_cents:s.paid.cents};});
return {totals,raffles,reviews:db.prepare("SELECT COUNT(*) AS n FROM payment_submissions WHERE status='pending'").get().n};}
setInterval(()=>db.prepare('DELETE FROM visitors WHERE day<?').run(mxDay(Date.now()-31*86400000)),3600000).unref();
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
// WAHA calls this server to server, without a browser Origin, so it is checked by its shared secret before the Origin rule.
if(path==='/api/waha/webhook'&&req.method==='POST'){
if(!adminGroup||!webhookSecret||!process.env.WAHA_URL)return send(res,404,{error:'No encontrado'});
if(!validSecret(req.headers['x-peso-secret']))return send(res,401,{error:'No autorizado'});
const b=await body(req,2097152),m=b.payload;
// A buyer answering BAJA / ALTA in a private chat turns the announcements off or on for that phone.
if(['message','message.any'].includes(b.event)&&m&&typeof m==='object'&&!m.fromMe&&typeof m.from==='string'&&/@(c\.us|s\.whatsapp\.net)$/.test(m.from)){const word=optWord(m.body),phone=m.from.split('@')[0].replace(/\D/g,'').slice(-10),id=String(m.id||''),now=Date.now();
for(const [key,until] of answered)if(until<=now)answered.delete(key);
if(word&&phone.length===10&&!(id&&answered.has(id))&&db.prepare('SELECT 1 FROM contacts WHERE phone=?').get(phone)){if(id)answered.set(id,now+600000);let allowed=true;try{limit('waha_optout',60,60000);}catch{allowed=false;}
if(allowed){db.prepare('UPDATE contacts SET opted_out=? WHERE phone=?').run(word==='out'?1:0,phone);audit(word==='out'?'contact_opted_out':'contact_opted_in');
wahaText(m.from,word==='out'?'Listo, ya no te enviaremos avisos de Peso Ganador. Si cambias de opinión, responde ALTA.':'¡Listo! Volverás a recibir avisos de nuevas rifas y sorteos de Peso Ganador. 🍀').catch(error=>console.error('whatsapp_optout_reply_failed',error.message));}}}
// After the info text, any message from that person, or one written by hand from our phone, means the conversation is alive: no follow-up.
if(['message','message.any'].includes(b.event)&&m&&typeof m==='object'){const chat=m.fromMe?m.to:m.from;if(typeof chat==='string'&&/@(c\.us|s\.whatsapp\.net|lid)$/.test(chat)){const at=Number(m.timestamp)>1e9?Number(m.timestamp)*1000:Date.now();
if(m.fromMe){const config=autoReplyConfig(),text=String(m.body||'').trim();if(text&&text!==String(config.text).trim()&&text!==String(config.followText).trim())db.prepare('UPDATE auto_replies SET last_out=MAX(COALESCE(last_out,0),?) WHERE chat=?').run(at,chat);}
else db.prepare('UPDATE auto_replies SET last_in=MAX(COALESCE(last_in,0),?) WHERE chat=?').run(at,chat);}}
// Someone asking for information in a private chat (usually from an ad) gets the info text, at most once every 12 hours per chat.
if(['message','message.any'].includes(b.event)&&m&&typeof m==='object'&&!m.fromMe&&typeof m.from==='string'&&/@(c\.us|s\.whatsapp\.net|lid)$/.test(m.from)&&!optWord(m.body)){const config=autoReplyConfig(),id=String(m.id||''),now=Date.now();
if(config.enabled&&config.text&&wantsInfo(m.body,config.keywords)&&!(id&&answered.has(id))){if(id)answered.set(id,now+600000);const last=db.prepare('SELECT last FROM auto_replies WHERE chat=?').get(m.from)?.last||0;let allowed=now-last>=AUTO_REPLY_GAP;if(allowed)try{limit('waha_autoreply',120,60000);}catch{allowed=false;}
if(allowed){db.prepare('INSERT INTO auto_replies(chat,last) VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET last=excluded.last,last_in=NULL,last_out=NULL,followup=NULL').run(m.from,now);
// A Mexican phone that asks for information joins the contacts (without replacing a buyer's name), so it also receives the announcements; BAJA removes it.
const phone=m.from.split('@')[0].replace(/\D/g,'');if(/@(c\.us|s\.whatsapp\.net)$/.test(m.from)&&/^521?\d{10}$/.test(phone)){const name=String(m._data?.notifyName||m.notifyName||'Interesado por anuncio').slice(0,100);db.prepare('INSERT OR IGNORE INTO contacts(phone,name,created,last_seen) VALUES(?,?,?,?)').run(phone.slice(-10),name,now,now);}
wahaText(m.from,config.text).then(()=>audit('whatsapp_auto_reply')).catch(error=>console.error('whatsapp_auto_reply_failed',error.message));}}}
if(['message','message.any'].includes(b.event)&&m&&typeof m==='object'&&m.from===adminGroup){const command=botCommand(m.body),id=String(m.id||'');
// WAHA may deliver one message twice (retries, or both message events); each id is answered once.
const now=Date.now();for(const [key,until] of answered)if(until<=now)answered.delete(key);
if(command&&!(id&&answered.has(id))){if(id)answered.set(id,now+600000);let allowed=true;try{limit('waha_bot',30,60000);}catch{allowed=false;}
if(allowed){expire();answerAdmin(command).then(()=>audit('whatsapp_bot_'+command)).catch(error=>console.error('whatsapp_bot_failed',error.message));}}}
return send(res,200,{ok:true});}
if(req.method==='POST'){
if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'Origen no autorizado'});
}
if(req.method==='POST'||path.startsWith('/api/admin/'))expire();
if(path==='/api/raffle'&&req.method==='GET'){const wanted=new URL(req.url,'http://localhost').searchParams.get('id'),raffles=activeRaffles(),raffle=(wanted&&activeRaffle(wanted))||activeRaffle();if(!raffle)return send(res,200,{raffles,raffle:null,open:false,message:closedMessage(null),taken:''});return send(res,200,{raffles,raffle,open:salesOpen(raffle),message:salesOpen(raffle)?null:closedMessage(raffle),holdHours:holdMs()/3600000,taken:takenBitmap(raffle)});}
if(path==='/api/payment-info'&&req.method==='GET')return send(res,200,paymentInfo());
const publicPhoto=path.match(/^\/api\/raffles\/([a-f0-9]{24})\/photo$/);
if(publicPhoto&&['GET','HEAD'].includes(req.method)){const row=db.prepare("SELECT photo,photo_type FROM raffles WHERE id=? AND status IN ('active','closed')").get(publicPhoto[1]);if(!row?.photo)return send(res,404,{error:'Foto no disponible'});const photo=Buffer.from(row.photo);return sendCached(req,res,photo,etagOf(photo),row.photo_type,0);}
if(path==='/api/payments/submit'&&req.method==='POST'){
limits(req,'payment_submit',300,10);const b=await body(req,Math.ceil(RECEIPT_MAX/3)*4+4096);
if(typeof b.phone!=='string'||!/^\d{10}$/.test(b.phone)||typeof b.tracking!=='string'||b.tracking.length>100)return send(res,400,{error:'Revisa tu teléfono y la clave de rastreo.'});
// Each phone has at most one pending reservation per raffle: the phone plus the raffle identify what is being paid.
if(b.raffle!=null&&(typeof b.raffle!=='string'||!/^[a-f0-9]{24}$/.test(b.raffle)))return send(res,400,{error:'Elige la rifa que estás pagando.'});
const pending=db.prepare("SELECT r.id,r.raffle,r.amount_cents,f.prize FROM reservations r LEFT JOIN raffles f ON f.id=r.raffle WHERE r.phone=? AND r.status='pending' AND r.expires>=? ORDER BY r.created DESC").all(b.phone,Date.now()).filter(r=>b.raffle==null||r.raffle===b.raffle);
if(pending.length>1)return send(res,409,{error:'Tienes boletos pendientes en varias rifas. Elige cuál estás pagando.',choices:pending.map(r=>({raffle:r.raffle,prize:r.prize,amount_cents:r.amount_cents}))});
const row=pending[0];
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
const raffle=activeRaffle(b.raffle);if(!salesOpen(raffle))return send(res,409,{error:closedMessage(raffle)});
if(!Number.isInteger(b.quantity)||b.quantity<1||b.quantity>raffle.ticket_count)return send(res,400,{error:`Escribe una cantidad de 1 a ${raffle.ticket_count.toLocaleString('es-MX')} boletos.`});
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
const rows=db.prepare(`SELECT r.id,r.raffle,r.numbers,r.status,r.created,r.expires,r.amount_cents,f.prize,f.ticket_count,f.draw_at FROM reservations r LEFT JOIN raffles f ON f.id=r.raffle WHERE r.${{name:'name_key',phone:'phone',email:'email'}[b.method]}=? ORDER BY r.created DESC LIMIT 20`).all(value);
if(!rows.length)return send(res,404,{error:'No encontramos boletos con ese dato. Revisa que esté escrito igual que cuando apartaste.'});
const lastPayment=db.prepare('SELECT status,reason FROM payment_submissions WHERE reservation=? ORDER BY created DESC,id DESC LIMIT 1');
return send(res,200,{results:rows.map(row=>({raffle:row.raffle,numbers:JSON.parse(row.numbers),status:row.status,created:row.created,expires:row.expires,amount_cents:row.amount_cents,prize:row.prize,ticket_count:row.ticket_count,draw_at:row.draw_at,payment:lastPayment.get(row.id)||null}))});
}
if(path==='/api/reservations'&&req.method==='POST'){
limits(req,'reservations',600,20);
const b=await body(req,RESERVATION_BODY);if(!Array.isArray(b.numbers)||b.numbers.length>MAX_TICKETS)return send(res,400,{error:'Selecciona al menos un boleto.'});const nums=[...new Set(b.numbers)];
const raffle=activeRaffle(b.raffle);if(!salesOpen(raffle))return send(res,409,{error:closedMessage(raffle)});
if(typeof b.name!=='string'||b.name.trim().length<3||b.name.length>100||typeof b.phone!=='string'||!/^\d{10}$/.test(b.phone)||!nums.length||nums.some(n=>!Number.isInteger(n)||n<0||n>=raffle.ticket_count))return send(res,400,{error:'Revisa nombre, teléfono y boletos.'});
const email=b.email==null||b.email===''?null:typeof b.email==='string'?b.email.trim().toLowerCase():b.email;
if(email!==null&&!validEmail(email))return send(res,400,{error:'Revisa el correo electrónico.'});
const now=Date.now();let current,numbers,amount,expires;db.exec('BEGIN IMMEDIATE');
try{
// New tickets join the phone's pending reservation, so each phone pays a single total per raffle.
current=db.prepare("SELECT id,numbers,expires FROM reservations WHERE phone=? AND raffle=? AND status='pending' ORDER BY created DESC LIMIT 1").get(b.phone,raffle.id);
if(current&&db.prepare("SELECT 1 FROM payment_submissions WHERE reservation=? AND status='pending'").get(current.id)){db.exec('ROLLBACK');return send(res,409,{error:'Tienes un comprobante en revisión. Espera la confirmación de tu pago para apartar más boletos.'});}
const previous=current?JSON.parse(current.numbers):[];
numbers=[...previous,...nums];amount=numbers.length*raffle.price_cents;expires=Math.max(current?.expires||0,now+holdMs());const id=current?.id||randomBytes(12).toString('hex');
if(current)db.prepare('UPDATE reservations SET numbers=?,amount_cents=?,expires=?,email=COALESCE(email,?) WHERE id=?').run(JSON.stringify(numbers),amount,expires,email,id);
else db.prepare('INSERT INTO reservations(id,name,phone,numbers,status,created,expires,email,raffle,amount_cents,name_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,b.name.trim(),b.phone,JSON.stringify(numbers),'pending',now,expires,email,raffle.id,amount,normalizeName(b.name));
for(const n of nums)db.prepare('INSERT INTO raffle_tickets VALUES(?,?,?)').run(raffle.id,n,id);saveContact(b.phone,b.name.trim(),now);db.exec('COMMIT');}catch{db.exec('ROLLBACK');return send(res,409,{error:'Algún boleto acaba de ser apartado. Actualiza tu selección.'});}
return send(res,201,{numbers,added:nums.length,amount_cents:amount,expires,message:numbers.length>nums.length?'¡Agregamos los boletos a tu apartado! Paga el nuevo total antes de que venza y envía tu comprobante con tu teléfono.':'¡Boletos apartados! Realiza tu pago antes de que venza el apartado y envía tu comprobante con tu teléfono.'});
}
if(path==='/api/login'&&req.method==='POST'){
if(!credentials.exists())return send(res,503,{error:'Administrador pendiente de configurar en el servidor.'});
limit('login',5,900000);const now=Date.now();
const b=await body(req);if(!credentials.verify(b.password))return send(res,401,{error:'Credenciales incorrectas'});
// Rotate only the session used by this browser; keep other devices signed in.
sessions.delete(token(req));for(const [key,s] of sessions)if(s.expires<=now||s.last+900000<=now)sessions.delete(key);
if(sessions.size>=20)return send(res,429,{error:'Se alcanzó el límite de sesiones. Cierra alguna o espera a que expire.'});
const sessionToken=randomBytes(32).toString('hex');sessions.set(sessionToken,{expires:now+3600000,last:now});audit('login');
// The owner cookie outlives the session and logout, so this device stays out of the visit counter for two years.
res.setHeader('Set-Cookie',[cookie(sessionToken,3600),`${OWNER_COOKIE}=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=63072000${production||origin.startsWith('https:')?'; Secure':''}`]);return send(res,200,{ok:true});
}
if(path.startsWith('/api/admin/')){
if(!admin(req))return send(res,401,{error:'Inicia sesión'});
if(path==='/api/admin/password'&&req.method==='POST'){limit('change_password',5,900000);const b=await body(req);if(!credentials.verify(b.currentPassword))return send(res,401,{error:'La contraseña actual no coincide.'});if(typeof b.newPassword!=='string'||b.newPassword.length<5||b.newPassword.length>200)return send(res,400,{error:'La contraseña debe tener entre 5 y 200 caracteres.'});credentials.save(b.newPassword);const current=token(req);for(const key of sessions.keys())if(key!==current)sessions.delete(key);audit('password_changed');return send(res,200,{ok:true});}
if(path==='/api/admin/auto-reply'&&req.method==='GET'){const config=autoReplyConfig(),sent=db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='whatsapp_auto_reply' AND created>=?").get(Date.now()-7*86400000).n;const followWeek=db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='whatsapp_follow_up' AND created>=?").get(Date.now()-7*86400000).n;return send(res,200,{...config,whatsapp:Boolean(process.env.WAHA_URL&&adminGroup&&webhookSecret),sentWeek:sent,followWeek});}
if(path==='/api/admin/auto-reply'&&req.method==='POST'){const b=await body(req);const text=typeof b.text==='string'?b.text.replace(/\r\n/g,'\n').trim():'',keywords=typeof b.keywords==='string'?b.keywords.trim():'';
if(text.length<20||text.length>3000)return send(res,400,{error:'El mensaje debe tener entre 20 y 3,000 caracteres.'});if(!keywords.split(',').map(plainText).filter(Boolean).length||keywords.length>300)return send(res,400,{error:'Escribe al menos una palabra clave (separadas por comas).'});
const followText=typeof b.followText==='string'?b.followText.replace(/\r\n/g,'\n').trim():'',followHours=Number(b.followHours);
if(followText.length<20||followText.length>3000)return send(res,400,{error:'El mensaje de seguimiento debe tener entre 20 y 3,000 caracteres.'});if(!Number.isInteger(followHours)||followHours<1||followHours>20)return send(res,400,{error:'El seguimiento se envía entre 1 y 20 horas después.'});
const config={enabled:b.enabled===true,keywords,text,followEnabled:b.followEnabled===true,followHours,followText};db.prepare("INSERT INTO settings VALUES('auto_reply',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));audit('auto_reply_changed');return send(res,200,config);}
if(path==='/api/admin/payment-settings'&&req.method==='GET')return send(res,200,paymentInfo());
if(path==='/api/admin/visits'&&req.method==='GET')return send(res,200,visitStats());
if(path==='/api/admin/summary'&&req.method==='GET'){expire();return send(res,200,salesSummary());}
if(path==='/api/admin/contacts'&&req.method==='GET'){const contacts=db.prepare("SELECT c.phone,c.name,c.created,c.last_seen,c.opted_out,(SELECT COUNT(*) FROM reservations r WHERE r.phone=c.phone AND r.status='paid') AS purchases FROM contacts c ORDER BY c.last_seen DESC LIMIT 5000").all();
const since=Date.now()-86400000,expired=db.prepare("SELECT COUNT(*) AS total,SUM(status='sent') AS sent,SUM(status='failed') AS failed FROM outbox WHERE kind='expired' AND created>=?").get(since);
return send(res,200,{contacts,total:db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,active:db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE opted_out=0').get().n,whatsapp:!!process.env.WAHA_URL,broadcast:broadcastStatus(),expired,footer:BROADCAST_FOOTER.trim()});}
if(path==='/api/admin/contacts/opt'&&req.method==='POST'){const b=await body(req);if(typeof b.phone!=='string'||!/^\d{10}$/.test(b.phone)||typeof b.out!=='boolean')return send(res,400,{error:'Contacto no válido.'});
if(!db.prepare('UPDATE contacts SET opted_out=? WHERE phone=?').run(b.out?1:0,b.phone).changes)return send(res,404,{error:'Ese contacto no existe.'});audit(b.out?'contact_opted_out_admin':'contact_opted_in_admin');return send(res,200,{ok:true});}
if(path==='/api/admin/broadcast'&&req.method==='POST'){const b=await body(req,16384),text=typeof b.text==='string'?b.text.trim():'';
if(!process.env.WAHA_URL)return send(res,409,{error:'WhatsApp (WAHA) no está conectado en el servidor.'});
if(text.length<10||text.length>1500)return send(res,400,{error:'Escribe un mensaje de 10 a 1,500 caracteres.'});
if(db.prepare("SELECT 1 FROM outbox WHERE kind='broadcast' AND status='queued' LIMIT 1").get())return send(res,409,{error:'Todavía se está enviando un aviso. Espera a que termine o cancélalo.'});
const batch=randomBytes(8).toString('hex'),phones=db.prepare('SELECT phone FROM contacts WHERE opted_out=0 ORDER BY last_seen DESC').all();if(!phones.length)return send(res,409,{error:'Aún no tienes contactos para avisar.'});
db.exec('BEGIN IMMEDIATE');try{for(const {phone} of phones)queueMessage(phone,text+BROADCAST_FOOTER,'broadcast',null,batch);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
audit('broadcast_queued');return send(res,201,{queued:phones.length,status:broadcastStatus()});}
if(path==='/api/admin/broadcast/cancel'&&req.method==='POST'){const n=db.prepare("UPDATE outbox SET status='cancelled' WHERE kind='broadcast' AND status='queued'").run().changes;audit('broadcast_cancelled');return send(res,200,{cancelled:n,status:broadcastStatus()});}
if(path==='/api/admin/payment-settings'&&req.method==='POST'){const info=paymentSettings(await body(req));db.prepare("INSERT INTO settings VALUES('payment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(info));audit('payment_settings_changed');return send(res,200,info);}
if(path==='/api/admin/raffles/dates'&&req.method==='POST'){const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id))return send(res,400,{error:'Rifa inválida'});const dates=raffleDates(b);const result=db.prepare('UPDATE raffles SET starts_at=?,ends_at=?,draw_at=? WHERE id=?').run(...dates,b.id);if(!result.changes)return send(res,404,{error:'Rifa no disponible'});audit('raffle_dates_changed',b.id);return send(res,200,{ok:true});}
if(path==='/api/admin/raffles/status'&&req.method==='POST'){
const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id)||!['draft','active','closed'].includes(b.status))return send(res,400,{error:'Revisa la rifa y el estado.'});
db.exec('BEGIN IMMEDIATE');try{
const raffle=db.prepare('SELECT id,status,starts_at,ends_at,draw_at FROM raffles WHERE id=?').get(b.id);
const fail=(status,error)=>{db.exec('ROLLBACK');return send(res,status,{error});};
if(!raffle)return fail(404,'Rifa no disponible');
if(b.status==='active'&&(!raffle.starts_at||!raffle.ends_at||!raffle.draw_at))return fail(400,'Guarda inicio, cierre y fecha del sorteo antes de poner la rifa en venta.');
if(b.status==='draft'&&db.prepare('SELECT 1 FROM reservations WHERE raffle=? LIMIT 1').get(b.id))return fail(409,'Esta rifa ya tiene apartados. Usa «Cerrar ventas» en lugar de regresarla a borrador.');
db.prepare('UPDATE raffles SET status=? WHERE id=?').run(b.status,b.id);audit('raffle_'+b.status,b.id);db.exec('COMMIT');return send(res,200,{ok:true});
}catch(error){db.exec('ROLLBACK');throw error;}}
if(path==='/api/admin/payments'&&req.method==='GET')return send(res,200,db.prepare('SELECT p.id,p.reservation,p.tracking,p.receipt_type,p.status,p.reason,p.created,p.reviewed,r.name,r.phone,r.numbers,r.amount_cents,r.status AS reservation_status,r.expires,f.prize,f.ticket_count FROM payment_submissions p JOIN reservations r ON r.id=p.reservation LEFT JOIN raffles f ON f.id=r.raffle ORDER BY p.created DESC,p.id DESC LIMIT 100').all());
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
if(path==='/api/admin/raffles/update'&&req.method==='POST'){
const b=await body(req,PRIZE_BODY);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id))return send(res,400,{error:'Rifa inválida'});
const fields=raffleFields(b),dates=raffleDates(b),photo=b.photo===undefined?undefined:rafflePhoto(b.photo,PRIZE_PHOTO);
db.exec('BEGIN IMMEDIATE');try{const raffle=db.prepare('SELECT price_cents FROM raffles WHERE id=?').get(b.id);const fail=(status,error)=>{db.exec('ROLLBACK');return send(res,status,{error});};
if(!raffle)return fail(404,'Rifa no disponible');
// Once tickets are held or sold, their price is fixed and no sold number may fall outside the raffle.
if(db.prepare("SELECT 1 FROM reservations WHERE raffle=? AND status IN ('pending','paid') LIMIT 1").get(b.id)&&fields.cents!==raffle.price_cents)return fail(409,'No se puede cambiar el precio: esta rifa ya tiene boletos apartados o vendidos.');
const highest=db.prepare('SELECT MAX(number) AS n FROM raffle_tickets WHERE raffle=?').get(b.id).n;if(highest!=null&&fields.ticketCount<=highest)return fail(409,`No puedes bajar a ${fields.ticketCount} boletos: el número ${highest} ya está apartado o vendido.`);
db.prepare('UPDATE raffles SET prize=?,description=?,price_cents=?,ticket_count=?,goal_percent=?,starts_at=?,ends_at=?,draw_at=? WHERE id=?').run(fields.prize,fields.description,fields.cents,fields.ticketCount,fields.goal,...dates,b.id);
if(photo!==undefined)db.prepare('UPDATE raffles SET photo=?,photo_type=? WHERE id=?').run(photo.bytes,photo.type,b.id);
audit('raffle_edited',b.id);db.exec('COMMIT');return send(res,200,{ok:true});}catch(error){db.exec('ROLLBACK');throw error;}}
if(path==='/api/admin/raffles/delete'&&req.method==='POST'){
const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id))return send(res,400,{error:'Rifa inválida'});
db.exec('BEGIN IMMEDIATE');try{if(db.prepare("SELECT 1 FROM reservations WHERE raffle=? AND status IN ('pending','paid') LIMIT 1").get(b.id)){db.exec('ROLLBACK');return send(res,409,{error:'Esta rifa ya tiene boletos apartados o vendidos; no se puede borrar. Usa «Cerrar ventas» o «Reprogramar».'});}
db.prepare('DELETE FROM raffle_tickets WHERE raffle=?').run(b.id);const removed=db.prepare('DELETE FROM raffles WHERE id=?').run(b.id).changes;if(!removed){db.exec('ROLLBACK');return send(res,404,{error:'Rifa no disponible'});}audit('raffle_deleted',b.id);db.exec('COMMIT');return send(res,200,{ok:true});}catch(error){db.exec('ROLLBACK');throw error;}}
if(path==='/api/admin/raffles/reschedule'&&req.method==='POST'){
const b=await body(req);if(typeof b.id!=='string'||!/^[a-f0-9]{24}$/.test(b.id))return send(res,400,{error:'Rifa inválida'});
const endsAt=mxDate(b.endsAt),drawAt=mxDate(b.drawAt);if(!Number.isFinite(endsAt)||!Number.isFinite(drawAt))return send(res,400,{error:'Indica el nuevo cierre y el nuevo sorteo en hora del centro de México.'});
if(endsAt<=Date.now()||drawAt<endsAt)return send(res,400,{error:'El nuevo cierre debe ser en el futuro y el sorteo igual o posterior al cierre.'});
db.exec('BEGIN IMMEDIATE');try{const raffle=db.prepare('SELECT status,ticket_count,starts_at,COALESCE(goal_percent,80) AS goal FROM raffles WHERE id=?').get(b.id);const fail=(status,error)=>{db.exec('ROLLBACK');return send(res,status,{error});};
if(!raffle)return fail(404,'Rifa no disponible');if(raffle.starts_at>=endsAt)return fail(400,'El nuevo cierre debe ser posterior al inicio de la rifa.');
const sold=db.prepare("SELECT COUNT(*) AS n FROM raffle_tickets t JOIN reservations r ON r.id=t.reservation WHERE t.raffle=? AND r.status='paid'").get(b.id).n;
if(sold*100>=raffle.goal*raffle.ticket_count)return fail(409,`Esta rifa ya alcanzó su meta del ${raffle.goal}%; no necesita reprogramarse.`);
// A closed raffle goes back on sale with its new dates.
const reopen=raffle.status==='closed';
db.prepare('UPDATE raffles SET ends_at=?,draw_at=?,rescheduled=COALESCE(rescheduled,0)+1,status=? WHERE id=?').run(endsAt,drawAt,reopen?'active':raffle.status,b.id);audit('raffle_rescheduled',b.id);db.exec('COMMIT');
return send(res,200,{ok:true,status:reopen?'active':raffle.status,message:reopen?'Rifa reprogramada y de nuevo en venta.':'Rifa reprogramada.'});}catch(error){db.exec('ROLLBACK');throw error;}}
if(path==='/api/admin/raffles'&&req.method==='GET')return send(res,200,db.prepare("SELECT f.id,f.prize,f.description,f.price_cents,f.ticket_count,f.status,f.created,f.starts_at,f.ends_at,f.draw_at,COALESCE(f.goal_percent,80) AS goal_percent,COALESCE(f.rescheduled,0) AS rescheduled,f.photo IS NOT NULL AS has_photo,(SELECT COUNT(*) FROM raffle_tickets t JOIN reservations r ON r.id=t.reservation WHERE t.raffle=f.id AND r.status='paid') AS sold,(SELECT COUNT(*) FROM raffle_tickets t JOIN reservations r ON r.id=t.reservation WHERE t.raffle=f.id AND r.status='pending') AS held FROM raffles f ORDER BY f.created DESC,f.id DESC LIMIT 100").all());
if(path==='/api/admin/raffles'&&req.method==='POST'){
limit('create_raffle',10,60000);const b=await body(req,PRIZE_BODY);
const fields=raffleFields(b),dates=raffleDates(b),photo=rafflePhoto(b.photo,PRIZE_PHOTO),id=randomBytes(12).toString('hex');db.exec('BEGIN IMMEDIATE');try{db.prepare("INSERT INTO raffles(id,prize,description,price_cents,ticket_count,status,photo,photo_type,created,starts_at,ends_at,draw_at,goal_percent) VALUES(?,?,?,?,?,'draft',?,?,?,?,?,?,?)").run(id,fields.prize,fields.description,fields.cents,fields.ticketCount,photo.bytes,photo.type,Date.now(),...dates,fields.goal);audit('raffle_created',id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return send(res,201,{id,status:'draft',message:'Rifa guardada como borrador. Pulsa «Poner en venta» cuando quieras publicarla.'});
}
const photoMatch=path.match(/^\/api\/admin\/raffles\/([a-f0-9]{24})\/photo$/);
if(photoMatch&&['GET','HEAD'].includes(req.method)){const row=db.prepare('SELECT photo,photo_type FROM raffles WHERE id=?').get(photoMatch[1]);if(!row?.photo)return send(res,404,{error:'Foto no disponible'});res.setHeader('Content-Type',row.photo_type);res.setHeader('Content-Length',row.photo.length);res.setHeader('Content-Disposition','inline');return res.end(req.method==='HEAD'?undefined:Buffer.from(row.photo));}
if(path==='/api/admin/logout'&&req.method==='POST'){sessions.delete(token(req));audit('logout');res.setHeader('Set-Cookie',cookie('',0));return send(res,200,{ok:true});}
// Free some or all tickets of a pending reservation (e.g. a customer reserved more than they wanted). Paid reservations are never touched.
if(path==='/api/admin/reservations/release'&&req.method==='POST'){const b=await body(req);if(typeof b.id!=='string'||!Array.isArray(b.numbers)||!b.numbers.length||b.numbers.length>MAX_TICKETS||b.numbers.some(n=>!Number.isInteger(n)))return send(res,400,{error:'Elige los boletos que quieres liberar.'});
db.exec('BEGIN IMMEDIATE');try{const r=db.prepare('SELECT r.id,r.raffle,r.numbers,r.status,f.price_cents FROM reservations r LEFT JOIN raffles f ON f.id=r.raffle WHERE r.id=?').get(b.id);
if(!r||r.status!=='pending'){db.exec('ROLLBACK');return send(res,409,{error:'Solo se pueden liberar boletos de apartados pendientes de pago.'});}
const current=JSON.parse(r.numbers),release=new Set(b.numbers);if([...release].some(n=>!current.includes(n))){db.exec('ROLLBACK');return send(res,409,{error:'Algún boleto ya no pertenece a este apartado. Pulsa Actualizar.'});}
const keep=current.filter(n=>!release.has(n));for(const n of release){db.prepare('DELETE FROM raffle_tickets WHERE raffle=? AND number=? AND reservation=?').run(r.raffle,n,r.id);db.prepare('DELETE FROM tickets WHERE number=? AND reservation=?').run(n,r.id);}
if(keep.length)db.prepare('UPDATE reservations SET numbers=?,amount_cents=? WHERE id=?').run(JSON.stringify(keep),keep.length*(r.price_cents||0),r.id);else db.prepare("UPDATE reservations SET status='cancelled' WHERE id=?").run(r.id);
audit(keep.length?'tickets_released':'reservation_cancelled',r.id);db.exec('COMMIT');return send(res,200,{released:release.size,kept:keep.length,amount_cents:keep.length*(r.price_cents||0)});}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}}
if(path==='/api/admin/reservations'&&req.method==='GET')return send(res,200,db.prepare("SELECT r.*,f.prize,f.ticket_count,EXISTS(SELECT 1 FROM payment_submissions p WHERE p.reservation=r.id AND p.status='pending') AS payment_review FROM reservations r LEFT JOIN raffles f ON f.id=r.raffle ORDER BY r.created DESC LIMIT 500").all());
if(path==='/api/admin/confirm'&&req.method==='POST')return send(res,410,{error:'Revisa el comprobante y registra el motivo desde Pagos por revisar.'});
}
const files={'/':'index.html','/CFAD':'admin.html','/CFAD/':'admin.html','/app.js':'app.js','/theme.js':'theme.js','/admin.js':'admin.js','/style.css':'style.css','/admin.css':'admin.css','/logo.png':'logo.png','/logo-small.png':'logo-small.png','/favicon.ico':'favicon.ico','/favicon-32.png':'favicon-32.png','/favicon-192.png':'favicon-192.png','/apple-touch-icon.png':'apple-touch-icon.png',
// Self-hosted fonts (Anton for titles and numbers, Poppins for text): no third-party requests and the CSP stays 'self'.
'/fonts/anton-400.woff2':'fonts/anton-400.woff2','/fonts/poppins-400.woff2':'fonts/poppins-400.woff2','/fonts/poppins-600.woff2':'fonts/poppins-600.woff2','/fonts/poppins-700.woff2':'fonts/poppins-700.woff2'};
if(req.method==='GET'&&path==='/'){try{countVisit(req);}catch(error){console.error('visit_count_failed',error.message);}}
if(['GET','HEAD'].includes(req.method)&&Object.hasOwn(files,path)){const {body:file,etag}=staticFile(files[path]),image=/\.(png|ico|woff2)$/.test(path);return sendCached(req,res,file,etag,path.endsWith('.png')?'image/png':path.endsWith('.ico')?'image/x-icon':path.endsWith('.woff2')?'font/woff2':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8',image?604800:0);}
send(res,404,{error:'No encontrado'});
}catch(error){if(error.retry)res.setHeader('Retry-After',String(error.retry));if(!error.status)console.error('request_failed');send(res,error.status||500,{error:error.status?error.message:'Error interno'});}
});
server.maxRequestsPerSocket=100;
server.keepAliveTimeout=5000;
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`Peso Ganador: puerto ${process.env.PORT||3000}`));
