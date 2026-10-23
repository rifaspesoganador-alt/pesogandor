import {DatabaseSync} from 'node:sqlite';
import {credentialStore} from './credentials.mjs';
process.umask(0o077);
try{
  let input='';
  for await(const chunk of process.stdin){input+=chunk;if(input.length>202)throw Error('Contraseña demasiado larga.');}
  const db=new DatabaseSync('data/peso.db');
  credentialStore(db).save(input.replace(/\r?\n$/,''));
  db.close();
  console.log('Contraseña guardada. Reinicia únicamente el servicio web para cerrar sesiones anteriores.');
}catch{console.error('No se cambió la contraseña. Usa entre 5 y 200 caracteres.');process.exitCode=1;}
