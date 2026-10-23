import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';

export function credentialStore(db,bootstrap){
  db.exec('CREATE TABLE IF NOT EXISTS admin_credentials(id INTEGER PRIMARY KEY CHECK(id=1),salt BLOB NOT NULL,hash BLOB NOT NULL,updated INTEGER NOT NULL)');
  function save(password){
    if(typeof password!=='string'||password.length<5||password.length>200)throw Error('La contraseña debe tener entre 5 y 200 caracteres.');
    const salt=randomBytes(32),hash=scryptSync(password,salt,64);
    db.prepare('INSERT INTO admin_credentials VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,updated=excluded.updated').run(salt,hash,Date.now());
  }
  if(!db.prepare('SELECT id FROM admin_credentials WHERE id=1').get()&&bootstrap)save(bootstrap);
  return {
    exists:()=>!!db.prepare('SELECT id FROM admin_credentials WHERE id=1').get(),
    verify(password){
      if(typeof password!=='string'||password.length>200)return false;
      const row=db.prepare('SELECT salt,hash FROM admin_credentials WHERE id=1').get();
      return !!row&&timingSafeEqual(Buffer.from(row.hash),scryptSync(password,Buffer.from(row.salt),64));
    },
    save
  };
}
