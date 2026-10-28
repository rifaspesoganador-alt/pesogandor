# Peso Ganador

Sitio de rifas con interfaz pública `/` y administración `/CFAD`. Node.js 24, servidor HTTP y SQLite persistente en `data/peso.db`, sin dependencias externas. PowerShell inicia el servicio local con `./Start-PesoGanador.ps1`.

Configure `ADMIN_PASSWORD` antes del primer arranque para crear el acceso administrativo. Después, la contraseña protegida se conserva en SQLite y se cambia desde el panel. No guarde contraseñas en Git. `PORT` es opcional (3000 por defecto). Para producción, configure `PUBLIC_ORIGIN=https://pesoganador.com` y un proxy HTTPS que reenvíe al servicio. Fuera de Docker el servicio solo escucha en 127.0.0.1 (`HOST` permite cambiarlo).

## Cómo poner a la venta una rifa

1. Entra a `/CFAD` y, en **Datos de pago**, guarda banco, titular y al menos una CLABE, cuenta o tarjeta. También puedes indicar WhatsApp, instrucciones y cuántas horas tiene la gente para pagar (1 a 72). Sin estos datos el sitio no vende boletos.
2. Pulsa **Nueva rifa**: premio, descripción, precio, cantidad de boletos (máximo 10,000), fechas de inicio, cierre y sorteo (hora del centro de México) y foto opcional. Se guarda como borrador.
3. Pulsa **Poner en venta**. Solo puede haber una rifa en venta; los boletos se pueden apartar entre el inicio y el cierre. **Cerrar ventas** detiene nuevos apartados y conserva los existentes.

## Flujo del participante

Elige hasta 10 boletos (o usa la maquinita de la suerte), registra nombre, teléfono y correo opcional y recibe un folio con el total a pagar. Paga a la cuenta publicada y envía el comprobante (JPG, PNG o PDF, máximo 5 MB) con su folio, teléfono y clave de rastreo o referencia. Mientras el comprobante está en revisión, los boletos quedan apartados 48 horas. En «Mis boletos» consulta el estado con su folio y teléfono, correo o nombre.

## Validación de pagos

En **Pagos por revisar** aparece cada comprobante con el monto esperado. Confirma en tu banca en línea que el depósito llegó antes de aprobar: una imagen se puede falsificar. Aprobar marca los boletos como pagados; rechazar exige un motivo visible para el participante y le devuelve su tiempo normal para pagar. No existe validación bancaria automática (CEP/SPEI).

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
