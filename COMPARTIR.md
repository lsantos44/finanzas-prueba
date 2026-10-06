# Cómo compartir la app

Nota para quien mantiene el proyecto, no para quien lo instala.

## Lo que compartes y lo que no

**Compartes la aplicación.** Es una web; le pasas el enlace y ya está.

**No compartes tu backend.** Cada persona monta el suyo si quiere sincronizar entre dispositivos o conectar su banco. Es intencionado:

- Tu `PROXY_TOKEN` da acceso a tus datos. No se da a nadie.
- Tu clave de IA la pagarías tú para todos.
- Y tu aplicación de Enable Banking está registrada **para tus cuentas**. Que otra persona conecte su banco a través de ella te convierte en intermediario de sus datos financieros: fuera de las condiciones de uso personal y con obligaciones de protección de datos que recaen en ti.

## Los dos enlaces

| Enlace | Para quién |
|---|---|
| `https://finanzaspersonaleslsg.netlify.app` | Todo el mundo. Es la app |
| `https://github.com/lsantos44/Finanzas` | Solo quien quiera sincronizar o conectar el banco |

Mensaje tipo:

> Te paso una app para llevar las finanzas de casa: **[enlace de la app]**
>
> Puedes usarla sin instalar nada: descargas el Excel o el CSV de tu banco y lo arrastras. Los datos se quedan en tu navegador, no los ve nadie.
>
> Si luego quieres que se sincronice entre el móvil y el ordenador, o que los movimientos se bajen solos del banco, aquí está la guía: **[enlace del repositorio]**. Son unos 20 minutos y es gratis, pero no hace falta para empezar.

El orden importa: primero que vean si les sirve, después el montaje. Al revés, abandonan.

## Qué pasa cuando actualizas

**La app** es un único despliegue tuyo en Netlify. Al subir una versión nueva, todos la reciben al recargar. Ventaja: arreglas algo y les llega. Responsabilidad: si rompes algo, también.

**El Worker** lo tiene cada uno. Si cambias el del repositorio, quien lo instaló por el camino A (GitHub) lo recibe al actualizar su copia; quien usó el camino B tiene que volver a copiar y pegar. Avisa cuando un cambio sea importante.

## Antes de invitar a nadie

- Haz tú la instalación completa desde cero siguiendo el README, con una cuenta distinta. Es la única forma de saber que la guía funciona.
- Haz las seis capturas (`docs/img/LEEME.md`).
- Comprueba que el `ALLOW_ORIGIN` que pones en la guía es el dominio real de la app.

## Si alguien se atasca

Pídele la salida de **Ajustes → Probar backend**. Dice qué ve su Worker: si falta la base de datos, si el token no coincide, si Enable Banking responde. Es más rápido que cualquier descripción que te haga por teléfono.
