// Borra los apartados y comprobantes creados con la versión de demostración (los que no pertenecen a ninguna rifa).
// No toca rifas, apartados de rifas reales, datos de pago ni la contraseña administrativa.
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('data/peso.db');
db.exec('BEGIN IMMEDIATE');
try{
  const hasRaffle=db.prepare('PRAGMA table_info(reservations)').all().some(column=>column.name==='raffle');
  const where=hasRaffle?'raffle IS NULL':'1';
  const receipts=db.prepare(`DELETE FROM payment_submissions WHERE reservation IN (SELECT id FROM reservations WHERE ${where})`).run().changes;
  const reservations=db.prepare(`DELETE FROM reservations WHERE ${where}`).run().changes;
  db.exec('DELETE FROM tickets');
  db.exec('COMMIT');
  console.log(`Listo: se borraron ${reservations} apartados y ${receipts} comprobantes de demostración.`);
}catch(error){db.exec('ROLLBACK');console.error('No se borró nada:',error.message);process.exitCode=1;}
db.close();
