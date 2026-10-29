# GitLab Tasks

Extensión de GNOME Shell para consultar las tareas abiertas que tienes asignadas en una instancia GitLab y recibir notificaciones cuando se te asigne una tarea o termine correctamente un deploy iniciado por ti.

## Requisitos

- GNOME Shell 45–49 o 51.
- Una instancia GitLab accesible por HTTPS.
- Un token de acceso personal con `read_api` para consultas. Para ejecutar jobs manuales o reintentar jobs fallidos desde la extensión, el token necesita el alcance `api`.

El alcance `api` permite modificar recursos de GitLab; úsalo solo si necesitas ejecutar estas acciones y protege el token. Se guarda en la configuración local de GNOME (dconf).

## Instalar desde el código fuente

```sh
mkdir -p ~/.local/share/gnome-shell/extensions/gitlab-tasks@jpupo91
cp -r metadata.json extension.js prefs.js schemas \
  ~/.local/share/gnome-shell/extensions/gitlab-tasks@jpupo91/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/gitlab-tasks@jpupo91/schemas
gnome-extensions enable gitlab-tasks@jpupo91
```

Abre Preferencias desde el menú de la extensión, indica la URL base de GitLab (por ejemplo, `https://gitlab.example.com`), pega el token y ajusta el intervalo. En Xorg puede ser necesario cerrar y volver a iniciar sesión para cargar una extensión recién instalada; en Wayland, reinicia la sesión.

Si actualizas manualmente los archivos de una extensión que ya estaba activa, cierra sesión y vuelve a entrar para que GNOME Shell cargue el código nuevo.

## Preparar el paquete para GNOME Extensions

Con `gnome-extensions` y `glib-compile-schemas` instalados, ejecuta:

```sh
make validate
make pack
```

El paquete instalable se crea en `dist/` con el UUID de la extensión. Antes de enviarlo, asegúrate de que `url` en `metadata.json` apunte al repositorio público del proyecto. Después, inicia sesión en [extensions.gnome.org](https://extensions.gnome.org/) y sube el archivo ZIP desde la página de carga de extensiones. El workflow de GitHub Actions también construye el paquete y lo conserva como artefacto.

## Funcionamiento

- Consulta tareas abiertas asignadas al usuario autenticado en GitLab.
- Muestra todas las tareas asignadas devueltas por GitLab en un panel con pestañas y desplazamiento, y hasta 10 deploys exitosos recientes iniciados por el usuario.
- Organiza tareas y deploys en pestañas para evitar que las listas largas queden recortadas en el menú de la barra superior.
- Permite ejecutar jobs manuales o reintentar jobs fallidos desde la pestaña de deploys, con confirmación y comprobación del estado del job antes de enviar la acción a GitLab.
- Permite filtrar las tareas por etiqueta o agruparlas por etiquetas dentro de la pestaña de tareas; las etiquetas muestran su texto, se pueden recorrer horizontalmente y conservan los colores configurados en GitLab.
- Agrupa los deploys por proyecto y permite expandir o colapsar cada proyecto; el estado se conserva al actualizar la lista.
- Muestra el detalle completo de cada tarea, incluidos sus metadatos y descripción con formato Markdown (énfasis, enlaces, listas, citas y bloques de código) en un diálogo desplazable, sin salir de GNOME Shell; también permite abrirla en GitLab.
- Permite abrir el deploy en GitLab desde su submenú.
- La primera consulta establece el estado inicial y no genera notificaciones retroactivas.

La lectura de deploys se realiza proyecto por proyecto y usa hasta los primeros 100 proyectos con membresía. El token y las respuestas de la API no se envían a ningún servicio distinto de la URL configurada.
