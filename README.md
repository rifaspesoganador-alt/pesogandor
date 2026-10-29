# Peso Ganador

Sitio de rifas con interfaz pública `/` y administración `/CFAD`. Node.js 24, servidor HTTP y SQLite persistente en `data/peso.db`, sin dependencias externas. PowerShell inicia el servicio local con `./Start-PesoGanador.ps1`.

Configure `ADMIN_PASSWORD` antes del primer arranque para crear el acceso administrativo. Después, la contraseña protegida se conserva en SQLite y se cambia desde el panel. No guarde contraseñas en Git. `PORT` es opcional (3000 por defecto). Para producción, configure `PUBLIC_ORIGIN=https://pesoganador.com` y un proxy HTTPS que reenvíe al servicio. Fuera de Docker el servicio solo escucha en 127.0.0.1 (`HOST` permite cambiarlo).

Las letras del sitio (Anton para titulares y números, Poppins para el texto) están en `public/fonts`; ambas tienen licencia libre SIL Open Font License y se sirven desde el propio servidor.

## Cómo poner a la venta una rifa

1. Entra a `/CFAD` y, en **Datos de pago**, guarda banco, titular y al menos una CLABE, cuenta o tarjeta. También puedes indicar WhatsApp, instrucciones y cuántas horas tiene la gente para pagar (1 a 72; 24 por defecto). El sitio muestra en rojo que el concepto debe llevar nombre o celular. Sin estos datos el sitio no vende boletos.
2. Pulsa **Nueva rifa**: premio, descripción, precio, cantidad de boletos (máximo 100,000; el sitio los muestra en páginas de 1,000 con buscador de número), fechas de inicio, cierre y sorteo (hora del centro de México) y foto opcional. Se guarda como borrador.
3. Pulsa **Poner en venta**. Puede haber varias rifas en venta al mismo tiempo: el sitio las muestra como pestañas («Elige tu rifa») y cada una tiene sus propios boletos, numeración y precio. Los boletos se pueden apartar entre el inicio y el cierre de cada rifa. **Cerrar ventas** detiene nuevos apartados y conserva los existentes.

## Editar, borrar y reprogramar

Cada rifa tiene una meta de venta (80% de los boletos pagados por defecto, editable). En el panel, **Editar** corrige premio, descripción, precio, cantidad, meta, fechas y foto (agregar, cambiar o quitar). Si ya hay boletos apartados o vendidos, el precio queda fijo y la cantidad no puede bajar por debajo del número más alto ocupado. **Borrar** solo está disponible mientras la rifa no tenga boletos apartados ni vendidos. **Reprogramar** aparece mientras no se alcance la meta: pide un nuevo cierre y una nueva fecha de sorteo, conserva todos los boletos, vuelve a poner en venta una rifa cerrada y el sitio muestra «Fecha reprogramada».

## Flujo del participante

Elige los boletos que quiera (o escribe cuántos en la maquinita de la suerte), registra nombre, teléfono y correo opcional y ve el total a pagar. No hay folios: el teléfono identifica el apartado de cada rifa. Si vuelve a apartar en la misma rifa con el mismo teléfono, los boletos se suman a su apartado pendiente; si tiene apartados pendientes en varias rifas, al enviar el comprobante elige cuál está pagando; mientras tenga un comprobante en revisión no puede apartar más. Paga a la cuenta publicada y envía el comprobante (JPG, PNG o PDF, máximo 5 MB) con su teléfono y clave de rastreo o referencia. Mientras el comprobante está en revisión, los boletos quedan apartados 48 horas. En «Mis boletos» busca por nombre, teléfono o correo y ve todos sus apartados (números, estado y total, sin datos personales).

## Validación de pagos

En **Pagos por revisar** aparece cada comprobante con el monto esperado. Confirma en tu banca en línea que el depósito llegó antes de aprobar: una imagen se puede falsificar. Aprobar marca los boletos como pagados; rechazar exige un motivo visible para el participante y le devuelve su tiempo normal para pagar. No existe validación bancaria automática (CEP/SPEI).

## WhatsApp con WAHA

Al aprobar un pago, la página manda un WhatsApp al participante con sus boletos, el total, la fecha del sorteo y el enlace a «Mis boletos». Usa WAHA (WhatsApp HTTP API). En el `.env` del servidor configure:

- `WAHA_URL`: dirección de WAHA, por ejemplo `https://waha.midominio.com` (o `http://waha:3000` si está en la misma red de Docker).
- `WAHA_API_KEY`: la clave de API de WAHA (`WHATSAPP_API_KEY` en WAHA), si la tiene activada.
- `WAHA_SESSION`: nombre de la sesión conectada en WAHA (`default` si no se indica).

Antes de enviar, la página pregunta a WAHA el chat correcto del número (en México puede ser 52 o 521 + 10 dígitos). Si WhatsApp o WAHA fallan, el pago queda aprobado igualmente; el resultado se registra en la auditoría (`whatsapp_sent` o `whatsapp_failed`) y en `docker compose logs web`.

## Aviso opcional a n8n

Si además configura `N8N_WEBHOOK_URL`, al aprobar un pago el servidor envía un POST JSON a `N8N_WEBHOOK_URL` con `event` (`payment_approved`), `name`, `phone`, `whatsapp` (52 + 10 dígitos), `numbers`, `amount`, `prize`, `draw_at` y `lookup_url`. Si existe `N8N_WEBHOOK_SECRET`, se envía en el encabezado `X-Peso-Secret` para que n8n rechace llamadas ajenas. Si n8n falla, el pago queda aprobado de todos modos y el error aparece en `docker compose logs web`. Configure ambas variables en el `.env` del servidor.

## Límites anti-abuso

Cada visitante (por IP, tomada del encabezado que agrega Traefik con `TRUST_PROXY=1`) puede hacer por minuto: 20 apartados, 20 consultas, 10 comprobantes y 60 sorteos de la maquinita. Además hay un tope general por minuto para todo el sitio: 600 apartados, 600 consultas, 300 comprobantes y 1,200 sorteos. No hay tope de boletos por persona: cada quien aparta los que quiera (la maquinita acepta cualquier cantidad disponible) y lo que aparte de nuevo con el mismo teléfono se suma a su apartado pendiente.

## Despliegue en VPS

`compose.yaml` conecta la aplicación a la red externa `n8n_default` del Traefik existente, con entrypoint `websecure` y emisor `mytlschallenge`. `www` redirige al dominio principal.

En el servidor (`/docker/peso-ganador`): `git pull --ff-only` y `docker compose up -d --build`. La primera vez cree un archivo `.env` privado con `ADMIN_PASSWORD`. La base de datos vive en el volumen `peso-ganador_peso_data`. Nunca use `docker compose down -v`: borra todos los datos. Configure respaldos antes de operar.

Al arrancar, la base se actualiza sola: las rifas que estaban «visibles en demostración» vuelven a borrador. Para borrar los apartados y comprobantes de prueba de la versión anterior (no toca rifas, datos de pago ni la contraseña):

```bash
docker compose exec -T web node borrar-datos-demo.mjs
```

## Contraseña perdida

En `/docker/peso-ganador`, sin dejar la clave en el historial:

```bash
read -rsp 'Nueva contraseña (5 a 200 caracteres): ' nueva
printf '\n'
printf '%s' "$nueva" | docker compose exec -T web node reset-admin-password.mjs
unset nueva
docker compose restart web
```
