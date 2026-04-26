// ============================================================
// FEMP INVARIANTES v3.1 - Validación de datos críticos
// Principio #3: Sin Margen de Error Tolerable
// ============================================================

const INVARIANTES = {
  // Dólar: si el valor sale de este rango, es error crítico (fail-fast)
  dolar: {
    min: 500,
    max: 5000,
    accion: 'KILL_SWITCH',
    razon: 'Tipo de cambio fuera de rango físico posible'
  },

  // Granos: precios por tonelada
  granos: {
    maiz: { min: 50000, max: 600000 },
    soja: { min: 100000, max: 800000 },
    trigo: { min: 40000, max: 500000 },
    accion: 'DEGRADE_TO_CACHE',
    razon: 'Precio de granos imposible o manipulado'
  },

  // Hacienda: precios por kg
  hacienda: {
    vacaGorda: { min: 1000, max: 8000 },
    novilloGordo: { min: 1500, max: 10000 },
    ternero: { min: 3000, max: 15000 },
    accion: 'DEGRADE_TO_CACHE'
  },

  // Relaciones críticas: si la relación maiz/ternero es < 10 o > 100, algo está roto
  relaciones: {
    maizTernero: { min: 10, max: 100 },
    maizNovillo: { min: 20, max: 150 },
    accion: 'ALERTA_ROJA'
  },

  // Confianza mínima para operar
  confianza: {
    minOperativa: 60, // Bajo esto, modo solo-lectura
    minCritica: 30,   // Bajo esto, kill switch
    accion: 'ESCALAR'
  }
};

// Función de validación genérica
function validarInvariante(nombre, valor, rango) {
  if (valor === null || valor === undefined || isNaN(valor)) {
    return {
      valido: false,
      tipo: 'NULL_O_NAN',
      mensaje: `${nombre} es nulo, indefinido o no numérico`,
      accion: rango.accion || 'ALERTA'
    };
  }
  if (rango.min !== undefined && valor < rango.min) {
    return {
      valido: false,
      tipo: 'MIN',
      mensaje: `${nombre}=${valor} es menor al mínimo ${rango.min}`,
      accion: rango.accion || 'ALERTA'
    };
  }
  if (rango.max !== undefined && valor > rango.max) {
    return {
      valido: false,
      tipo: 'MAX',
      mensaje: `${nombre}=${valor} es mayor al máximo ${rango.max}`,
      accion: rango.accion || 'ALERTA'
    };
  }
  return { valido: true, tipo: 'OK', mensaje: `${nombre}=${valor} válido` };
}

// Exportar para Node.js (scraper.js)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { INVARIANTES, validarInvariante };
}
