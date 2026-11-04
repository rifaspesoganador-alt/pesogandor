// Borra una rifa cerrada o en borrador con todos sus apartados, boletos y comprobantes (por ejemplo, una rifa de pruebas).
// Uso: node borrar-rifa.mjs <id>             muestra qué se borraría, sin borrar nada.
//      node borrar-rifa.mjs <id> --confirmar  lo borra. No se puede deshacer.
// Nunca borra una rifa en venta. No toca otras rifas, datos de pago ni la contraseña administrativa.
import {DatabaseSync} from 'node:sqlite';
const [id,flag]=process.argv.slice(2);
if(!/^[a-f0-9]{24}$/.test(id||'')){console.error('Indica el id de la rifa (24 caracteres).');process.exit(1);}
const db=new DatabaseSync('data/peso.db');
const raffle=db.prepare('SELECT prize,status FROM raffles WHERE id=?').get(id);
if(!raffle){console.error('No existe una rifa con ese id. No se borró nada.');process.exit(1);}
if(raffle.status==='active'){console.error(`«${raffle.prize}» está en venta. Ciérrala en el panel antes de borrarla. No se borró nada.`);process.exit(1);}
const count=sql=>db.prepare(sql).get(id).n;
const reservations=count('SELECT COUNT(*) AS n FROM reservations WHERE raffle=?');
const paid=count("SELECT COUNT(*) AS n FROM reservations WHERE raffle=? AND status='paid'");
const receipts=count('SELECT COUNT(*) AS n FROM payment_submissions WHERE reservation IN (SELECT id FROM reservations WHERE raffle=?)');
const tickets=count('SELECT COUNT(*) AS n FROM raffle_tickets WHERE raffle=?');
console.log(`Rifa «${raffle.prize}» (${raffle.status}): ${reservations} apartados (${paid} pagados), ${tickets} boletos y ${receipts} comprobantes.`);
if(flag!=='--confirmar'){console.log('No se borró nada. Para borrarla, repite el comando agregando --confirmar al final.');process.exit(0);}
db.exec('BEGIN IMMEDIATE');
try{
  db.prepare('DELETE FROM payment_submissions WHERE reservation IN (SELECT id FROM reservations WHERE raffle=?)').run(id);
  db.prepare('DELETE FROM raffle_tickets WHERE raffle=?').run(id);
  db.prepare('DELETE FROM reservations WHERE raffle=?').run(id);
  db.prepare('DELETE FROM raffles WHERE id=?').run(id);
  db.prepare('INSERT INTO audit(event,reservation,created) VALUES(?,?,?)').run('raffle_purged',id,Date.now());
  db.exec('COMMIT');
  console.log('Listo: rifa borrada con todos sus apartados, boletos y comprobantes.');
}catch(error){db.exec('ROLLBACK');console.error('No se borró nada:',error.message);process.exitCode=1;}
db.close();
