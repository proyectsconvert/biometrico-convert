/**
 * Versión de la plataforma (versionado semántico: MAYOR.MENOR.PARCHE).
 * - MAYOR: cambios que obligan a migrar datos o cambian la forma de trabajar.
 * - MENOR: funciones nuevas.
 * - PARCHE: correcciones.
 * Al publicar: subir VERSION, agregar la entrada arriba en HISTORIAL y el mismo número en package.json.
 */
export const VERSION = "1.4.0";

export type EntradaVersion = {
  version: string;
  fecha: string;
  titulo: string;
  cambios: string[];
};

export const HISTORIAL: EntradaVersion[] = [
  {
    version: "1.4.0",
    fecha: "2026-10-08",
    titulo: "Registro de turnos y versiones",
    cambios: [
      "Botón flotante para iniciar y finalizar turno (todos los roles excepto Super Administrador, Administrador y Nómina), con equipo, red y ubicación.",
      "Registro de turnos: tiempo conectado frente a tiempo en la empresa y alarmas al cruzar con el biométrico (inicio antes de la huella, fin después de la salida, sin huella, sin cierre).",
      "Asignación de campañas al editar un usuario.",
      "Supervisión y coordinación ven en «Resumen por persona» el cruce con el biométrico (diferencias y detalle por día) que sustenta cada observación.",
      "Conciliación de novedades: solo se comparan las horas reportadas; marcar de más en el biométrico ya no pide revisión.",
      "Versión visible en el menú con su historial de cambios.",
    ],
  },
  {
    version: "1.3.1",
    fecha: "2026-10-06",
    titulo: "Reproceso sin cortes",
    cambios: [
      "El reproceso espera a la base tras un corte de conexión y parte los tramos largos en vez de encimar reintentos.",
      "Cierre archivo por archivo y errores del proxy resumidos en una línea.",
    ],
  },
  {
    version: "1.3.0",
    fecha: "2026-10-05",
    titulo: "Reproceso en segundo plano",
    cambios: [
      "«Reprocesar todo» corre en el servidor: se puede cerrar el navegador, se reintenta solo y se reanuda tras un reinicio.",
      "Cada archivo se compara con su CSV original y se repara si le faltan filas.",
    ],
  },
  {
    version: "1.2.0",
    fecha: "2026-10-05",
    titulo: "Turnos, trazabilidad y seguridad",
    cambios: [
      "Turnos rotativos por campaña, malla diaria con plantilla de Excel y solicitudes de ajuste de empleados.",
      "Notificaciones por rol, comentarios con documentos y fotos, historial de cambios y edición en bloque.",
      "Acceso a cada módulo controlado también por enlace directo.",
    ],
  },
  {
    version: "1.1.0",
    fecha: "2026-09-26",
    titulo: "Filtros y plantillas",
    cambios: [
      "Filtros por campaña, personas y búsqueda libre en los paneles.",
      "Carga de plantillas más rápida y eliminación de usuarios restringida al Super Administrador.",
    ],
  },
  {
    version: "1.0.0",
    fecha: "2026-09-26",
    titulo: "Primera versión",
    cambios: [
      "Control de asistencia con procesamiento masivo del biométrico, cálculo de jornadas y recargos (Colombia), novedades y conciliación de nómina.",
    ],
  },
];
