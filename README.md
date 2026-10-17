# Peso Ganador

Primera versión local, en modo demostración. Interfaz pública `/` y administración `/CFAD`. Node.js 24, servidor HTTP y SQLite persistente en `data/peso.db`, sin dependencias externas. PowerShell inicia el servicio con `./Start-PesoGanador.ps1`.

Configure `ADMIN_PASSWORD` en el entorno del proceso antes de arrancar para habilitar el acceso administrativo. No guarde contraseñas en Git. `PORT` es opcional (3000 por defecto). Para producción, configure `PUBLIC_ORIGIN=https://pesoganador.com` y un proxy HTTPS que reenvíe al servicio local. El servicio solo escucha en 127.0.0.1.

Los apartados duran una hora. La clave única de boleto y la transacción SQLite evitan doble apartado. CFAD permite revisar apartados y confirmar pago manualmente; esta versión no procesa cobros. Sesiones de una hora en memoria, cookies HttpOnly/SameSite y Secure bajo HTTPS, comprobación de origen, consultas parametrizadas, limitación de intentos de acceso y encabezados de seguridad.

## Antes de operar

Falta configurar sorteo real (premio, boletos, precio, fecha, bases), métodos de pago, aviso de privacidad y condiciones; completar gestión de sorteos, cancelaciones, auditoría, recuperación de acceso y MFA; configurar servidor, HTTPS, copias de seguridad y supervisión. La protección contra abuso de reservas requiere una solución adicional antes de abrir al público. Los datos personales están en SQLite: restrinja permisos y proteja disco y respaldos. No se incluyen datos ni credenciales en Git.

Repositorio: https://github.com/rifaspesoganador-alt/pesogandor. Se esperan archivos y videos del usuario para ajustar los flujos. Las reservas y precios actuales son ejemplos y la interfaz lo indica expresamente.

## Despliegue de demostración en VPS

`compose.yaml` conecta únicamente esta aplicación a la red externa `n8n_default` del Traefik existente. Usa el entrypoint `websecure` y el emisor `mytlschallenge`. No publica puertos del contenedor en el host. `www` redirige al dominio principal para conservar un único origen y sesión.

En una carpeta nueva del servidor, clone este repositorio, cree un archivo `.env` privado con `ADMIN_PASSWORD` y ejecute `docker compose up -d --build`. No comparta el archivo `.env`. El contenedor escucha en `0.0.0.0` dentro de Docker; fuera de Docker, el servidor mantiene `127.0.0.1` por defecto (`HOST` permite configurarlo).

La base de datos del servidor se crea en el volumen `peso-ganador_peso_data`; no se importa la base local. Para actualizar: `git pull --ff-only` y `docker compose up -d --build`. Nunca use `docker compose down -v` si necesita conservar los datos. Configure respaldos antes de operar con datos reales.

## Consulta de boletos

La sección «Mis boletos» usa POST `/api/tickets/lookup`. Requiere el folio aleatorio de 24 caracteres y una coincidencia exacta de teléfono, correo o nombre completo (sin distinguir mayúsculas ni espacios repetidos). Solo devuelve ese apartado: números, estado y fechas, sin datos personales. No ofrece búsqueda pública de clientes ni todos los apartados asociados a un contacto. Los intentos se limitan globalmente a 30 por minuto.

El correo es opcional al reservar y se incorpora con una migración aditiva de SQLite al arrancar; no borra registros previos. Los apartados anteriores se consultan por nombre o teléfono. El folio es confidencial: quien conoce el folio y un dato coincidente puede consultar el apartado. La recuperación sin folio queda a cargo de administración; no se implementa envío de códigos por SMS o correo. La consulta conserva la etiqueta de demostración y distingue pagado, pendiente y vencido.
