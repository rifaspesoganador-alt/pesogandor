# Peso Ganador

Primera versión local, en modo demostración. Interfaz pública `/` y administración `/CFAD`. Node.js 24, servidor HTTP y SQLite persistente en `data/peso.db`, sin dependencias externas. PowerShell inicia el servicio con `./Start-PesoGanador.ps1`.

Configure `ADMIN_PASSWORD` en el entorno del proceso antes de arrancar para habilitar el acceso administrativo. No guarde contraseñas en Git. `PORT` es opcional (3000 por defecto). Para producción, configure `PUBLIC_ORIGIN=https://pesoganador.com` y un proxy HTTPS que reenvíe al servicio local. El servicio solo escucha en 127.0.0.1.

Los apartados duran una hora. La clave única de boleto y la transacción SQLite evitan doble apartado. CFAD permite revisar apartados y confirmar pago manualmente; esta versión no procesa cobros. Sesiones de una hora en memoria, cookies HttpOnly/SameSite y Secure bajo HTTPS, comprobación de origen, consultas parametrizadas, limitación de intentos de acceso y encabezados de seguridad.

## Antes de operar

Falta configurar sorteo real (premio, boletos, precio, fecha, bases), métodos de pago, aviso de privacidad y condiciones; completar gestión de sorteos, cancelaciones, auditoría, recuperación de acceso y MFA; configurar servidor, HTTPS, copias de seguridad y supervisión. La protección contra abuso de reservas requiere una solución adicional antes de abrir al público. Los datos personales están en SQLite: restrinja permisos y proteja disco y respaldos. No se incluyen datos ni credenciales en Git.

El Git remoto no está configurado. No se ha publicado ni conectado el dominio. Se esperan archivos y videos del usuario para ajustar los flujos. Las reservas y precios actuales son ejemplos y la interfaz lo indica expresamente.
