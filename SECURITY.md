# Seguridad y alcance

Esta aplicación sigue siendo una demostración. No hay una auditoría independiente ni garantía de seguridad absoluta.

## Controles implementados

- Precio, disponibilidad, validación, exclusividad y confirmación de pagos se resuelven en el backend. El navegador no decide qué boletos están pagados.
- SQLite se conserva en un volumen privado, sin rutas HTTP para descargarlo. Consultas parametrizadas y transacciones para reservas y confirmaciones.
- En producción se exige contraseña de al menos 5 caracteres y origen HTTPS. Cookies `__Host-`, Secure, HttpOnly y SameSite Strict, una sesión administrativa activa, expiración absoluta de una hora e inactividad de 15 minutos, cierre de sesión y revocación al reiniciar.
- Origen exacto para POST, JSON obligatorio, límite de 8 KiB, validación estructural, CSP, HSTS y protección contra marcos.
- Límites globales persistentes: cinco accesos cada 15 minutos, treinta intentos de reserva por minuto y diez boletos pendientes por teléfono. No se confía en cabeceras IP aportadas por el cliente. Los límites globales pueden bloquear temporalmente al administrador bajo ataque; no sustituyen protección de borde ni CAPTCHA.
- Auditoría local de accesos exitosos, cierres de sesión y confirmaciones, sin contraseñas ni cookies. El administrador del VPS puede modificar esa auditoría; no es un registro inmutable.
- Docker usa usuario sin privilegios, raíz de solo lectura, sin capacidades Linux, sin publicación de puertos al host y con límites de memoria, CPU y procesos. Solo el volumen de datos permite escritura.

## Trabajo pendiente antes de operación real

- MFA o acceso administrativo mediante VPN/proxy de identidad, CAPTCHA/verificación de teléfono y mitigación de ataques distribuidos. Un teléfono escrito no demuestra su propiedad.
- Revisar firewall, SSH, actualizaciones del host, Docker, Traefik y n8n. La red Docker compartida permite conectividad entre servicios; planificar aislamiento adicional sin interrumpir n8n.
- Respaldos cifrados y prueba de restauración. No copiar únicamente un `.db` activo en WAL: usar una copia consistente con la API de respaldo de SQLite o detener esta aplicación durante la copia del volumen completo.
- Monitorización, alertas, política de retención y eliminación de datos personales, condiciones y configuración del sorteo real.
- Escaneo de imagen/dependencias y evaluación independiente antes de recibir pagos o datos reales. No se realizaron pruebas de carga ni ataques sobre el VPS compartido.

## Actualizar el despliegue

En `/docker/peso-ganador`, ejecutar `git pull --ff-only`, `docker compose config --quiet`, `docker compose up -d --build` y `docker compose ps`. Solo se actualiza el proyecto Compose `peso-ganador`. Nunca usar `down -v` si necesita conservar datos. Los cambios no están activos en el VPS hasta reconstruir el contenedor allí.

