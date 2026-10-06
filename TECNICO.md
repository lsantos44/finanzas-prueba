# Detalle técnico

Worker de Cloudflare. Tres responsabilidades: almacenamiento (D1), Enable Banking (AIS) y proxy de IA compatible con OpenAI.

## Configuración

| Nombre | Tipo | Obligatorio | Para qué |
|---|---|---|---|
| `DB` | Binding D1 | Para sincronizar | Base de datos del almacenamiento |
| `PROXY_TOKEN` | Secret | Sí | Autoriza las llamadas; también deriva la clave de almacenamiento |
| `ALLOW_ORIGIN` | Text | Sí | Orígenes permitidos (CORS). Admite lista separada por comas |
| `EB_APP_ID` | Text/Secret | Para el banco | Application ID de Enable Banking |
| `EB_PRIVATE_KEY` | Secret | Para el banco | Contenido del `.pem`, con las líneas BEGIN/END |
| `UPSTREAM_KEY` | Secret | Para el proxy de IA | Clave del proveedor |
| `UPSTREAM_BASE` | Text | No | Endpoint del proveedor (por defecto OpenRouter) |

`wrangler.toml` declara la base D1, de modo que el botón de despliegue la crea y la vincula sin pasar por el panel.

## Rutas

### Almacenamiento

| Ruta | Método | Devuelve |
|---|---|---|
| `/store` | GET | `{payload, version, updatedAt}` o `{empty:true, version:0}` |
| `/store` | PUT | `{ok, version, updatedAt}`; `409 {conflict:true, version}` si `baseVersion` no coincide |
| `/store/history` | GET | `{versions:[{version, updatedAt, bytes}]}` |
| `/store/history?version=N` | GET | `{payload, version, updatedAt}` |
| `/store/status` | GET | Qué configuración ve el Worker. Solo booleanos, sin secretos |

El cuerpo del PUT es `{baseVersion, payload}`. La escritura solo se acepta si `baseVersion` coincide con la versión actual: evita que un dispositivo con datos viejos pise lo que otro acaba de guardar. Se conservan las 10 últimas versiones. Máximo 4 MB por copia.

La clave de almacenamiento es `SHA-256("finz:" + PROXY_TOKEN)` truncado a 16 bytes. Dos tokens distintos sobre el mismo Worker no comparten datos.

Las tablas se crean con `CREATE TABLE IF NOT EXISTS` en cada petición: desplegar no exige migraciones.

### Enable Banking

`/bank/aspsps`, `/bank/aspsp`, `/bank/auth`, `/bank/callback`, `/bank/accounts`, `/bank/transactions`, `/bank/balance`, `/bank/revoke`, `/bank/ping`.

Notas que cuesta caro redescubrir:

- El consentimiento se pide por el máximo que admita el banco, hasta 90 días, leyendo `maximum_consent_validity` de su ficha.
- `psu_type` se toma de los `psu_types` del banco. Un `personal` sobre cuentas de empresa deja firmar el consentimiento y luego falla **toda** petición de datos con `ASPSP_ERROR`.
- Los `uid` de cuenta son **por sesión**: cambian al renovar el permiso. Para identificar una cuenta entre sesiones hay que usar el IBAN.
- `date_to` nunca puede ir en el futuro: algunos bancos responden `400` genérico.
- El histórico se trocea en ventanas de 90 días, con reintento a 30 si el banco rechaza la más reciente.
- Un `4xx` en la primera ventana es conexión rota, no «no hay más histórico»: se propaga en vez de devolver una lista vacía con `200`.
- Los parámetros de `/bank/auth` se pueden forzar para diagnosticar: `?days=`, `?psu=`, `?auth_method=`, `?access=full`, `?state=uuid`, `?debug=1`.

### Proxy de IA

Cualquier otra ruta con `POST` se reenvía a `UPSTREAM_BASE` añadiendo `UPSTREAM_KEY`. Pensado para ocultar la clave y sortear CORS. Si vas a compartir tu Worker, considera que quien lo use gastará tu clave: la app permite que cada persona ponga la suya.

## Desarrollo

```bash
npm install -g wrangler
wrangler login
wrangler dev          # local
wrangler deploy       # publicar
wrangler secret put PROXY_TOKEN
```
