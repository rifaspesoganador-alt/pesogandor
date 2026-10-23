# Peso Ganador

Primera versión local, en modo demostración. Interfaz pública `/` y administración `/CFAD`. Node.js 24, servidor HTTP y SQLite persistente en `data/peso.db`, sin dependencias externas. PowerShell inicia el servicio con `./Start-PesoGanador.ps1`.

Configure `ADMIN_PASSWORD` antes del primer arranque para crear el acceso administrativo. Después, la contraseña protegida se conserva en SQLite y se cambia desde el panel. No guarde contraseñas en Git. `PORT` es opcional (3000 por defecto). Para producción, configure `PUBLIC_ORIGIN=https://pesoganador.com` y un proxy HTTPS que reenvíe al servicio local. El servicio solo escucha en 127.0.0.1.

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

## Nueva rifa en administración

CFAD permite crear borradores con premio, descripción, precio por boleto en MXN, cantidad de boletos y foto opcional JPG/PNG (máximo 1 MB, dimensiones máximas 4096 × 4096). Los importes se guardan como centavos enteros. Datos e imagen quedan en la tabla `raffles` de la misma SQLite persistente y las rutas de borradores y fotos requieren sesión administrativa. La migración agrega una tabla; no modifica los apartados previos.

Guardar un borrador no publica ni cambia el sorteo de demostración. La publicación/activación y edición de estas nuevas rifas no forman parte de esta alta; requieren un flujo posterior que vincule boletos, reservas y reglas al sorteo correspondiente.

## Comprobantes de prueba y revisión manual

El formulario público solicita folio, teléfono registrado, clave de rastreo y comprobante JPG/PNG de prueba (máximo 1 MB). Solo acepta apartados pendientes vigentes y una solicitud pendiente por apartado; la referencia normalizada no puede reutilizarse. El archivo se guarda en SQLite y solo se descarga con sesión administrativa. No se muestran claves ni archivos en la consulta pública del folio.

La bandeja «Pagos por revisar» permite aprobar o rechazar con motivo obligatorio, visible al participante. La aprobación y el cambio de estado son transaccionales, se auditan y rechazan apartados vencidos. Enviar evidencia no extiende el apartado ni comprueba una transferencia. La antigua ruta de confirmación sin evidencia devuelve 410. No existe consulta bancaria o validación de CEP automática. Se conserva el modo demostración y se solicitan imágenes sin datos bancarios reales.

## Visibilidad y sesiones (23 de octubre)

Los borradores admiten «Mostrar en demostración» y «Ocultar del sitio». La vitrina pública `/api/raffles` solo muestra rifas `published_demo`, con fotos públicas únicamente mientras estén visibles. No activa ventas ni vincula sus boletos al selector de prueba existente. La creación sigue siendo privada por defecto.

Cada navegador conserva su propia sesión. Iniciar sesión en otro equipo ya no revoca las anteriores. Se admiten hasta 20 sesiones, con los mismos tiempos de expiración y límite de intentos. La variable `ADMIN_PASSWORD` solo inicializa el acceso si todavía no existe una credencial en SQLite. Después, los cambios de contraseña del panel persisten en el volumen y no son reemplazados por valores antiguos de `.env`.

## Fechas y contraseña persistente

Las rifas nuevas requieren inicio, cierre y sorteo. Se muestran en administración y en las vistas previas públicas en hora de Ciudad de México. Debe cumplirse inicio < cierre <= sorteo. La migración agrega columnas sin eliminar registros; las rifas anteriores muestran «Por definir» y permiten completar sus fechas desde el panel. Estas fechas son informativas en la demostración: no activan cobros ni cambian los boletos de prueba.

Las credenciales administrativas se guardan con scrypt y sal aleatoria en `admin_credentials`, dentro de la SQLite persistente. La variable de entorno solo se usa para el primer acceso. «Tu contraseña» en CFAD solicita clave actual y confirmación de la nueva; al cambiarla se cierran las otras sesiones. Reiniciar el servicio cierra sesiones pero conserva la clave. Los respaldos de SQLite contienen hashes y datos privados y deben protegerse.

Si se perdió la clave, un administrador del VPS puede ejecutar lo siguiente en `/docker/peso-ganador`, una vez desplegada esta versión. No incluye claves en historial ni imprime su valor:

```bash
read -rsp 'Nueva contraseña (5 a 200 caracteres): ' nueva
printf '\n'
printf '%s' "$nueva" | docker compose exec -T web node reset-admin-password.mjs
unset nueva
docker compose restart web
```

Este reinicio solo afecta a Peso Ganador. La herramienta modifica el hash en SQLite; no modifica `.env` ni requiere subir secretos a GitHub.
