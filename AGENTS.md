# ConvertIA Biométrico — Guía del Proyecto y Reglas de Desarrollo

Plataforma empresarial de control de asistencia, procesamiento masivo de datos biométricos, cálculo automático de jornadas y liquidación de novedades laborales.

---

## 🏗️ Arquitectura Técnica

- **Frontend & Fullstack Framework:** TanStack Start (SSR), TanStack Router, TanStack Query, React 19, Tailwind CSS v4, Lucide React, Radix UI.
- **Base de Datos & Backend:** PostgreSQL en Supabase Self-Hosted (`https://supabase-biometrico.testbot.click`), con Row Level Security (RLS) multitenant y funciones almacenadas PL/pgSQL.
- **Almacenamiento:** Supabase Storage (Bucket `biometrico`) para archivos CSV de entrada y reportes exportados.
- **Entorno de Producción:** Servidor Linux alojado con Node.js 22 LTS bajo PM2 (`biometrico`) y exposición segura mediante túnel Cloudflare.

---

## 📌 Reglas de Negocio Esenciales

1. **Regla Universal de Marcaciones:**
   - Para cualquier empleado en un día determinado:
     - La **primera hora registrada** es la **Entrada** (`min(event_at)`).
     - La **última hora registrada** es la **Salida** (`max(event_at)`).
   - **Ningún dispositivo ni puerta se excluye:** Todas las autenticaciones exitosas con documento válido cuentan como asistencia (`is_attendance = true`), independientemente de si la puerta se llama entrada, salida, baño o torniquete.
   - Si un empleado tiene 1 solo movimiento en el día, el estado es **`incompleta`** (Entrada registrada, Salida en blanco).
   - Si un empleado tiene 2 o más movimientos, el estado es **`completa`**.

2. **Cálculo de Tiempos y Jornada Laboral (Colombia):**
   - Recargos nocturnos (ventana nocturna configurable, defecto 21:00 - 06:00).
   - Horas ordinarias y horas extras diurnas/nocturnas.
   - Recargo dominical y festivo automático con integración de festivos nacionales de Colombia (Ley Emiliani).
   - Tolerancia de entrada configurable por turno/empresa.

3. **Multitenant y Alcance de Datos:**
   - La plataforma maneja múltiples empresas (`tenants`).
   - Los roles `super_admin`, `admin` y `nomina` tienen visibilidad global o por empresa asignada.
   - La seguridad de acceso a datos se valida a nivel de API con RLS y middleware de sesión.

---

## 🚀 Despliegue y Mantenimiento

- **Servidor:** PM2 en `sshdevserv.testbot.click` ejecutando `/srv/projects/biometrico/proyecto`.
- **Intérprete Node:** `/root/.nvm/versions/node/v22.23.2/bin/node` (Node.js 22+).
- **Compilación:** `npm run build` genera el bundle optimizado en `.output/`.
