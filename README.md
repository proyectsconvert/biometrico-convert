# ConvertIA Biométrico

> **Plataforma Empresarial de Control de Asistencia, Liquidación Horaria y Procesamiento Biométrico Multi-empresa.**

ConvertIA Biométrico es una solución integral diseñada para capturar, limpiar, procesar y consolidar millones de registros de dispositivos biométricos de manera automática. Convierte marcaciones crudas en información precisa de asistencia, tiempos laborados, recargos y novedades de nómina bajo la legislación laboral colombiana.

---

## 🌟 Características Principales

### 1. ⚡ Procesamiento Masivo y en Segundo Plano
* **Carga por lotes sin bloqueo:** Sube múltiples archivos CSV simultáneamente con soporte para cientos de miles de registros por archivo.
* **Dock de fondo:** Cierra el modal o continúa navegando en la plataforma mientras la carga avanza en segundo plano.
* **Reprocesamiento desde almacenamiento:** Posibilidad de procesar archivos que ya residen en el almacenamiento sin volverlos a subir.
* **Desduplicación inteligente:** Filtrado automático de lecturas repetidas en ventanas de tiempo configurables.

### 2. 🕒 Regla Universal de Jornada y Cálculo Horario
* **Regla Universal:** Para cada empleado y día, la **primera marcación es la Entrada** y la **última marcación es la Salida**, sin importar qué puerta o dispositivo registró el evento.
* **Estados claros:**
  * **Completa:** Cuando el empleado cuenta con entrada y salida registradas.
  * **Incompleta:** Cuando el empleado tiene una sola marcación registrada (sin entrada o sin salida).
* **Cálculo automático de recargos (Ley de Colombia):**
  * Horas ordinarias.
  * Horas extra diurnas y nocturnas.
  * Recargo nocturno (con ventana configurable).
  * Dominicales y festivos automatizados mediante el calendario nacional oficial (Ley Emiliani).
  * Tolerancia de tardanzas configurable por turno.

### 3. 🏢 Arquitectura Multi-empresa (Multi-Tenant)
* Aislamiento seguro de datos entre empresas.
* Roles con permisos granulares (**Super Administrador**, **Administrador**, **Nómina**, **Asesor / Empleado**).
* Visibilidad global o restringida por empresa asignada.

### 4. 📊 Módulos del Sistema
* **Panel de Control (Dashboard):** Métricas clave en tiempo real, porcentajes de puntualidad, asistencias completas, ausencias y gráficos de tendencia.
* **Control Diario de Asistencia:** Vista detallada de entradas, salidas y tiempos calculados por empleado con exportación a Excel y CSV.
* **Resultados Biométricos:** Explorador consolidado día por día con visor detallado de cada movimiento del empleado.
* **Reportes y Consolidado:** Generación de reportes ejecutivos para liquidación de nómina.
* **Conciliación de Novedades:** Registro y cruce de incapacidades, permisos remunerados, licencias y ausencias justificadas.
* **Empleados y Empleadores:** Directorio completo de personal, asignación de campañas, centros de costo y personal reportable.
* **Turnos y Jornadas:** Definición de horarios laborales, tolerancias, tiempo de almuerzo/descanso y turnos rotativos.
* **Dispositivos Biométricos:** Catálogo de terminales biométricos, puertas y ubicaciones.
* **Auditoría:** Registro inmutable de eventos del sistema, inicios de sesión y modificaciones de datos.

---

## 🛠️ Pila Tecnológica

| Componente | Tecnología |
|---|---|
| **Framework Fullstack** | [TanStack Start](https://tanstack.com/start) con Server Functions |
| **Enrutamiento** | [TanStack Router](https://tanstack.com/router) |
| **Gestión de Estado y Caché** | [TanStack Query](https://tanstack.com/query) v5 |
| **Interfaz de Usuario** | [React 19](https://react.dev/), [Tailwind CSS v4](https://tailwindcss.com/), [Radix UI](https://www.radix-ui.com/), [Lucide React](https://lucide.dev/) |
| **Gráficos & Visualización** | [Recharts](https://recharts.org/) |
| **Base de Datos & Backend** | [PostgreSQL 17](https://www.postgresql.org/) en Supabase Self-Hosted con RLS y PL/pgSQL |
| **Almacenamiento** | Supabase Storage (Bucket privado `biometrico`) |
| **Exportación de Datos** | SheetJS ([xlsx](https://sheetjs.com/)) |

---

## 🚀 Inicio Rápido

### Requisitos Previos
* **Node.js:** Versión 22 o superior (LTS recomendada).
* **Gestor de paquetes:** npm, pnpm o bun.

### Instalación

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/proyectsconvert/biometrico-convert.git
   cd biometrico-convert
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```

3. **Variables de entorno:**
   Crea o verifica tu archivo `.env`:
   ```env
   SUPABASE_URL=https://supabase-biometrico.testbot.click
   SUPABASE_PUBLISHABLE_KEY=tu_clave_publicable
   SERVICE_ROLE_KEY=tu_clave_service_role
   ```

4. **Ejecutar en desarrollo:**
   ```bash
   npm run dev
   ```
   La aplicación estará disponible en `http://localhost:3000`.

5. **Compilar para producción:**
   ```bash
   npm run build
   ```

---

## 🌐 Despliegue en Producción

El proyecto está configurado para ejecutarse bajo **PM2** en servidores Linux con Node.js 22+:

```bash
# Compilar bundle de producción
npm run build

# Iniciar o reiniciar servicio PM2
pm2 restart biometrico --interpreter /root/.nvm/versions/node/v22.23.2/bin/node --update-env
pm2 save
```

---

## 🔒 Seguridad y Privacidad
* Autenticación basada en sesiones JWT seguras.
* Políticas estrictas de Row Level Security (RLS) en cada tabla de la base de datos.
* Almacenamiento seguro de contraseñas mediante hashing bcrypt/Argon2.
* Trazabilidad completa con auditoría de acciones sensibles.

---

© ConvertIA. Todos los derechos reservados.
