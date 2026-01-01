# 🖥️ ScreensWeb Agent (Electron)

Aplicación de escritorio para Windows instalada en PCs de salones.  
Se conecta a la **plataforma central** de ScreensWeb mediante WebSockets y muestra contenido en una o varias pantallas físicas.


---

## 📋 Tabla de Contenidos

- [🧩 Descripción General](#-descripción-general)
- [✨ Características](#-características)
- [🏗 Arquitectura](#-arquitectura)
- [🛠 Tecnologías](#-tecnologías)
- [📦 Requisitos Previos](#-requisitos-previos)
- [📥 Instalación](#-instalación)
- [⚙ Configuración](#-configuración)
- [🚀 Modo Desarrollo](#-modo-desarrollo)
- [🏭 Build y Distribución](#-build-y-distribución)
- [🔄 Auto-Actualización (CI/CD)](#-auto-actualización-cicd)
- [🆔 Flujo de Vinculación Inicial](#-flujo-de-vinculación-inicial)
- [📁 Estructura del Proyecto](#-estructura-del-proyecto)
- [Troubleshooting](#-troubleshooting)

---

## 🧩 Descripción General

El agente es el componente instalado en los PCs de los salones. 
Sus funciones son:

- Conectarse al backend de ScreensWeb mediante **WebSockets seguros (WSS)**.
- Recibir comandos (mostrar URL, mostrar asset local, cerrar contenido, identificar pantalla, etc.).
- Detectar y gestionar múltiples pantallas.
- Mostrar contenido en modo kiosko.
- Mantener la conexión y reintentar reconexiones ante cortes.
- Auto-actualizarse desde GitHub Releases utilizando `electron-updater`.

---

## ✨ Características

- 🖥️ **Multi-monitor**: una ventana por pantalla física.
- 🔄 **Auto-actualización**: integración con CI/CD (tags + GitHub Actions + electron-updater).
- 📡 **Conexión en tiempo real**: WebSockets con reconexión automática.
- 🧱 **Modo kiosko**: pantalla completa, sin barras ni menús.
- 🆔 **Identificación predecible**: Asigna IDs simples ("1", "2", "3") ordenados de izquierda a derecha.
- 💾 **Soporte offline**: muestra archivos locales (assets) sincronizados desde la plataforma central.
- 🧠 **Persistencia de estado por posición**: Recuerda la URL asignada a cada monitor según su orden físico (pantalla 1, pantalla 2...).
- 🔐 **Validación de comandos**: los datos recibidos se validan con **Zod** antes de ser ejecutados.

---

## 🏗 Arquitectura

```txt
┌─────────────────────────────┐
│  Backend ScreensWeb         │
│  (API + Socket.IO Server)   │
└──────────────┬──────────────┘
               │ WebSocket (WSS)
┌──────────────▼──────────────┐
│     ScreensWeb Agent        │
│     (Electron App)          │
└──────────────┬──────────────┘
               │ Renderizado
┌──────────────▼──────────────┐
│    Monitores físicos        │
└─────────────────────────────┘
```

---

## 🛠 Tecnologías

- **Electron** (proceso principal + ventanas de render)
- **Node.js 18+**
- **Socket.IO Client**
- **electron-updater**
- **electron-builder**
- **Zod** (validación de mensajes/comandos)
- HTML / CSS / JS para las vistas (`provision`, `identify`, `display`, etc.)

---

## 📦 Requisitos Previos

- **Sistema operativo**: Windows 10 / 11
- **Node.js** 18+ (para desarrollo)
- **npm** 9+ (para desarrollo)

> Para el usuario final del salón solo importa el instalador `.exe`.

---

## 📥 Instalación

Clonar el repo e instalar dependencias:

```bash
cd screensWeb-agent
npm install
```

---

## ⚙ Configuración

El agente necesita saber la **URL del servidor central** (por ejemplo, `https://screensweb.midominio.com` o `http://localhost:3000` en entorno de pruebas).


```js

const SERVER_URL = process.env.SCREENS_SERVER_URL || "http://localhost:3000";
```

La URL tiene que apuntar a la instancia correcta del backend (entorno dev, pre, prod, etc.).

---

## 🚀 Modo Desarrollo

Para arrancar el agente en modo desarrollo:

```bash
npm start
```

Comportamiento esperado:

- Si es la **primera vez** y no hay `deviceId` configurado:
  - El agente arranca en **Modo Vinculación** y muestra un ID de máquina.
- Si ya está vinculado:
  - El agente arranca directamente en **Modo Normal** y se conecta al servidor.

---

## 🏭 Build y Distribución

Para generar el instalador de Windows:

```bash
npm run build
```

Esto creará la carpeta `dist/` con:

- Un instalador `.exe` (`ScreensWeb Agent Setup 1.0.0.exe`).
- Archivos de metadatos (`latest.yml`), usados por `electron-updater`.

Este `.exe` es el que se distribuye e instala en los PCs de los salones.

---

## 🔄 Auto-Actualización (CI/CD)

El agente utiliza `electron-updater` para descargar e instalar nuevas versiones automáticamente.

### 🔧 Flujo (desarrollador)

1. Realizar cambios en el código del agente.
2. Incrementar la versión en `package.json` (`1.0.1` a `1.0.2`).
3. Crear un tag de Git que coincida con la versión:

```bash
git tag v1.0.2
```

4. GitHub Actions:
   - Compila el agente.
   - Genera el instalador `.exe` y el `latest.yml`.
   - Publica una **Release** con ambos ficheros.

### 💻 Flujo (agente instalado en el salón)

1. El agente instalado (por ejemplo, `v1.0.1`) arranca en un PC de salón.
2. `electron-updater` consulta periódicamente las actualizaciones.
3. Detecta que existe la versión `v1.0.2`.
4. Descarga el nuevo instalador en segundo plano.
5. Lanza `quitAndInstall`:
   - Cierra la app.
   - Ejecuta el instalador en modo silencioso.
   - Reinicia el agente con la nueva versión `v1.0.2`.

Todo el proceso es en segundo plano.

---


## 📁 Estructura del Proyecto

```txt
screensWeb-agent/
├── .github/
│   └── workflows/
│       └── release-agent.yml          # Workflow CI/CD para actualización
├── build/                             # Iconos para el instalador
└── local-agent/
    ├── config/
    │   └── constants.js               # Configuración centralizada (URLs, timeouts, rutas)
    ├── handlers/
    │   ├── commands.js                # Handlers de comandos (show_url, close_screen, etc.)
    │   └── provisioning.js            # Flujo de vinculación inicial
    ├── services/
    │   ├── assets.js                  # Sincronización de activos locales
    │   ├── auth.js                    # Refresh de tokens JWT
    │   ├── device.js                  # Registro de dispositivo y reboot
    │   ├── gpu.js                     # Configuración de GPU y memoria
    │   ├── network.js                 # Monitoreo de conectividad
    │   ├── socket.js                  # Conexión WebSocket con handlers delegados
    │   ├── state.js                   # Persistencia de URLs y auto-refresh
    │   └── updater.js                 # Auto-actualización via electron-updater
    ├── utils/
    │   └── configManager.js           # Gestión de config.json
    ├── icons/                         # Iconos de la aplicación
    ├── main.js                        # Proceso principal (orquestador)
    ├── fallback.html                  # Página de fallback offline
    ├── identify.html                  # Ventana de identificación de pantalla
    ├── identify-preload.js            # Preload para identify.html
    ├── provision.html                 # Modo de vinculación inicial
    ├── preload.js                     # Preload general
    ├── package.json                   # Metadata y configuración Electron
    └── README.md
```

### Arquitectura Modular

| Capa | Descripción |
|------|-------------|
| **main.js** | Orquestador que inicializa servicios y coordina eventos |
| **services/** | Módulos independientes con responsabilidad única |
| **handlers/** | Ejecutores de comandos remotos y flujos de usuario |
| **config/** | Constantes, rutas y configuración centralizada |
| **utils/** | Utilidades reutilizables |

---

## Troubleshooting

### El agente no conecta al servidor

- Verificar la URL del servidor en la configuración del agente (`SERVER_URL`, `.env`, etc.).
- Comprobar que el backend está accesible desde la red del salón.
- Revisar si un firewall/antivirus está bloqueando la conexión.

### No aparecen pantallas / monitores

- Comprobar que Windows detecta todas las pantallas (Configuración de pantalla).
- Reiniciar el agente después de cambiar la configuración de monitores.
- **Nota**: Los IDs (1, 2, 3) se asignan de izquierda a derecha según la configuración de Windows. Alinea las pantallas en Windows para coincidir con la realidad.

### No se actualiza

- Confirmar que:
  - Existe una **Release** con el mismo `tag` que la versión del `package.json`.
  - El `latest.yml` está presente en la Release o en la URL configurada.
- Revisar logs del agente para ver errores de `electron-updater`.

### Se queda en modo vinculación

- Verificar que el `deviceId` se ha registrado correctamente en el panel web.
- Revisar si el backend está enviando el evento de éxito de provisión.
- Comprobar logs del backend para ver si se ha recibido el `deviceId`.

---
