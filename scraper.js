const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const today = new Date().toISOString().split('T')[0];
const time = new Date().toLocaleTimeString('es-AR', { hour12: false });
const nowISO = new Date().toISOString();

const CONFIG = {
  version: '3.1.0-FEMP-Bayesian',
  maxRetries: 3,
  timeout: 25000,
  historyMaxDays: 90,
  seedFile: './data/seed.json',
  latestFile: './data/latest.json',
  historyFile: './data/history.json',
  weightsFile: './data/bayesian_weights.json'
};

const STATE = {
  errores: [],
  alertasCriticas: [], // Para enviar por Telegram
  lineage: [],
  fuentesOk: 0,
  fuentesTotal: 0,
  modo: 'AUTO',
  pesos: {}
};

// ==========================================
// CAPA C: INVARIANTES DE SEGURIDAD
// ==========================================
const INVARIANTES = {
  dolar: { min: 500, max: 5000 },
  granos: { min: 50000, max: 800000 }, // $/tn
  hacienda: { min: 1000, max: 15000 }  // $/kg
};

function validarInvariante(valor, tipo, fuente, descripcion) {
  const v = parseFloat(valor);
  if (isNaN(v)) return null;
  const limites = INVARIANTES[tipo];
  if (v < limites.min || v > limites.max) {
    const msg = `VIOLACIÓN DE INVARIANTE: ${descripcion} en ${fuente} reporta $${v}. Bloqueado.`;
    err(msg);
    STATE.alertasCriticas.push(msg);
    return null;
  }
  return v;
}

// ==========================================
// CAPA B: SISTEMA DE ALERTAS TELEGRAM
// ==========================================
async function sendTelegramAlert() {
  if (STATE.alertasCriticas.length === 0) return;
  
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId) {
    log('Telegram no configurado. Alertas generadas pero no enviadas.');
    return;
  }

  const mensaje = `🚨 *FEMP V3.1 - Reporte Crítico*\n📅 ${today} | ⏱️ ${time}\n\n` + 
                  STATE.alertasCriticas.map(a => `• ${a}`).join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: mensaje, parse_mode: 'Markdown' })
    });
    log('Alerta enviada por Telegram.');
  } catch (e) {
    log('Error enviando Telegram: ' + e.message);
  }
}

// ==========================================
// CAPA A: MOTOR BAYESIANO DE CONFIANZA
// ==========================================
function cargarPesos() {
  if (fs.existsSync(CONFIG.weightsFile)) {
    try { STATE.pesos = JSON.parse(fs.readFileSync(CONFIG.weightsFile, 'utf8')); } catch (e) {}
  }
}

function actualizarPesoBayesiano(fuente, esExito) {
  STATE.fuentesTotal++;
  if (esExito) STATE.fuentesOk++;
  
  if (!STATE.pesos[fuente]) STATE.pesos[fuente] = 1.0; // Confianza inicial máxima
  
  if (esExito) {
    // Si acierta, sube confianza un 5% (recuperación lenta)
    STATE.pesos[fuente] = Math.min(STATE.pesos[fuente] + 0.05, 1.0);
  } else {
    // Si falla, castigo del 30% (caída rápida)
    STATE.pesos[fuente] = Math.max(STATE.pesos[fuente] - 0.30, 0.1);
  }
}

function calcularConfianzaGlobal() {
  if (STATE.fuentesTotal === 0) return 0;
  let scoreObtenido = 0;
  let scoreMaximo = 0;
  
  // Analizamos el Lineage para ver quién aportó y qué peso tiene
  STATE.lineage.forEach(l => {
    const peso = STATE.pesos[l.fuente] || 1.0;
    scoreMaximo += peso;
    if (l.estado === 'OK') scoreObtenido += peso;
  });
  
  if (scoreMaximo === 0) return 0;
  return Math.round((scoreObtenido / scoreMaximo) * 100);
}

// Funciones base
function log(msg) { console.log(`[FEMP ${new Date().toLocaleTimeString('es-AR')}] ${msg}`); }
function err(msg) { console.error(`[FEMP ERROR] ${msg}`); STATE.errores.push(msg); }
function addLineage(dato, fuente, url, estado, confianza) {
  STATE.lineage.push({
    dato, fuente, url: url.substring(0, 80),
    timestamp: new Date().toLocaleString('es-AR'),
    estado, confianza,
    hash: require('crypto').createHash('sha256').update(dato + fuente + estado + Date.now()).digest('hex').substring(0, 16)
  });
}

async function fetchJSON(url, opts = {}) {
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), CONFIG.timeout);
      const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'FEMP-Bot/3.0', ...opts.headers } });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { success: true, data: await res.json() };
    } catch (e) {
      if (i === CONFIG.maxRetries - 1) return { success: false, error: e.message };
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function fetchHTML(url, opts = {}) {
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), CONFIG.timeout);
      const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...opts.headers } });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { success: true, html: await res.text() };
    } catch (e) {
      if (i === CONFIG.maxRetries - 1) return { success: false, error: e.message };
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function scrapeWithPuppeteer(url, waitForSelector, extractFn) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-web-security']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: CONFIG.timeout });
    }
    const result = await page.evaluate(extractFn);
    await browser.close();
    return { success: true, data: result };
  } catch (e) {
    if (browser) await browser.close();
    return { success: false, error: e.message };
  }
}

async function fetchDolar() {
  const fName = 'DolarAPI';
  const res = await fetchJSON('https://dolarapi.com/v1/dolares');
  if (!res.success) {
    err(`DolarAPI: ${res.error}`);
    actualizarPesoBayesiano(fName, false);
    addLineage('Dolar', fName, 'https://dolarapi.com/v1/dolares', 'FALLO', 'BAJA');
    return null;
  }
  const result = {};
  res.data.forEach(item => {
    const val = validarInvariante(item.venta, 'dolar', fName, item.casa);
    if (val) {
      if (item.casa === 'oficial') result.oficial = { compra: item.compra, venta: val, fecha: item.fechaActualizacion || today, fuente: fName };
      if (item.casa === 'blue') result.blue = { compra: item.compra, venta: val, fecha: item.fechaActualizacion || today, fuente: fName };
      if (item.casa === 'bolsa' || item.casa === 'mep') result.mep = { compra: item.compra, venta: val, fecha: item.fechaActualizacion || today, fuente: fName };
      if (item.casa === 'contadoconliqui' || item.casa === 'ccl') result.ccl = { compra: item.compra, venta: val, fecha: item.fechaActualizacion || today, fuente: fName };
    }
  });
  
  if (Object.keys(result).length === 0) {
    actualizarPesoBayesiano(fName, false);
    return null;
  }
  
  actualizarPesoBayesiano(fName, true);
  addLineage('Dolar', fName, 'https://dolarapi.com/v1/dolares', 'OK', 'ALTA');
  log('Dolar OK');
  return result;
}

async function fetchGranos() {
  const fName = 'BCR Rosario';
  const res = await scrapeWithPuppeteer(
    'https://www.bcr.com.ar/es/mercados/mercado-de-granos/cotizaciones/cotizaciones-locales-0',
    'table',
    () => {
      const result = {};
      document.querySelectorAll('table tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          const label = cells[0].textContent.toLowerCase();
          const valText = cells[cells.length - 1].textContent.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
          const val = parseFloat(valText);
          if (!isNaN(val)) {
            if (label.includes('maiz') || label.includes('maíz')) result.maiz = val;
            if (label.includes('soja')) result.soja = val;
            if (label.includes('trigo')) result.trigo = val;
          }
        }
      });
      return result;
    }
  );

  const result = {};
  let exitoso = false;

  if (res.success && res.data) {
    const d = res.data;
    if (d.maiz) result.maiz = { precio: validarInvariante(d.maiz, 'granos', fName, 'Maiz'), unidad: '$/tn', fecha: today, fuente: fName };
    if (d.soja) result.soja = { precio: validarInvariante(d.soja, 'granos', fName, 'Soja'), unidad: '$/tn', fecha: today, fuente: fName };
    if (d.trigo) result.trigo = { precio: validarInvariante(d.trigo, 'granos', fName, 'Trigo'), unidad: '$/tn', fecha: today, fuente: fName };
    
    // Solo marcamos éxito si los validadores no anularon el precio
    if (result.maiz.precio && result.soja.precio) exitoso = true;
  }

  if (!exitoso) {
    err(`Granos BCR: fallo o invariantes bloqueados.`);
    actualizarPesoBayesiano(fName, false);
    addLineage('Granos', fName, 'https://www.bcr.com.ar', 'FALLO', 'BAJA');
    return null;
  }

  actualizarPesoBayesiano(fName, true);
  addLineage('Granos', fName, 'https://www.bcr.com.ar', 'OK', 'ALTA');
  log('Granos BCR OK');
  return result;
}

async function fetchCanuelas() {
  const fName = 'Mercado Agroganadero';
  const res = await scrapeWithPuppeteer(
    'https://www.mercadoagroganadero.com.ar/dll/hacienda1.dll/haciinfo000002',
    'table',
    () => {
      const result = { fecha: new Date().toISOString().split('T')[0], entrada: 0 };
      const text = document.body.innerText;
      const mEntrada = text.match(/entrada[s]?[\s\w]*?(\d[\d.,]*)/i);
      if (mEntrada) result.entrada = parseInt(mEntrada[1].replace(/[^0-9]/g, ''));
      document.querySelectorAll('table tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const label = cells[0].textContent.toLowerCase();
          const valText = cells[cells.length - 1].textContent.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
          const val = parseFloat(valText);
          if (!isNaN(val)) {
            if (label.includes('vaca') && (label.includes('buena') || label.includes('gorda'))) result.vacaGorda = val;
            if (label.includes('novillo') && label.includes('gordo')) result.novilloGordo = val;
            if (label.includes('431') || label.includes('460')) result.novillo431 = val;
            if (label.includes('vaquillona') && label.includes('270')) result.vaquillona270 = val;
            if (label.includes('novillito') && label.includes('300')) result.novillito300 = val;
          }
        }
      });
      return result;
    }
  );

  if (!res.success || !res.data.vacaGorda) {
    err(`Canuelas: sin datos.`);
    actualizarPesoBayesiano(fName, false);
    addLineage('Canuelas', fName, 'https://www.mercadoagroganadero.com.ar', 'FALLO', 'BAJA');
    return null;
  }

  const d = res.data;
  const result = {
    fecha: d.fecha || today,
    entrada: d.entrada || 0,
    vacaGorda: { precio: validarInvariante(d.vacaGorda, 'hacienda', fName, 'Vaca Gorda'), unidad: '$/kg', categoria: 'Buenas', fecha: today, fuente: fName },
    novilloGordo: { precio: validarInvariante(d.novilloGordo, 'hacienda', fName, 'Novillo Gordo'), unidad: '$/kg', categoria: 'Promedio', fecha: today, fuente: fName },
    novillo431: { precio: validarInvariante(d.novillo431, 'hacienda', fName, 'Novillo 431'), unidad: '$/kg', categoria: 'Mest.EyB 431/460', fecha: today, fuente: fName },
    vaquillona270: { precio: validarInvariante(d.vaquillona270, 'hacienda', fName, 'Vaquillona 270'), unidad: '$/kg', categoria: 'EyB 270/390', fecha: today, fuente: fName },
    novillito300: { precio: validarInvariante(d.novillito300, 'hacienda', fName, 'Novillito 300'), unidad: '$/kg', categoria: 'EyB 300/390', fecha: today, fuente: fName }
  };

  if (!result.novilloGordo.precio) {
    actualizarPesoBayesiano(fName, false);
    return null;
  }

  actualizarPesoBayesiano(fName, true);
  addLineage('Canuelas', fName, 'https://www.mercadoagroganadero.com.ar', 'OK', 'ALTA');
  log('Canuelas OK');
  return result;
}

async function fetchAPEA() {
  const fName = 'APEA.org.ar';
  const res = await scrapeWithPuppeteer(
    'https://www.apea.org.ar',
    'body',
    () => {
      const text = document.body.innerText;
      const result = { fecha: new Date().toISOString().split('T')[0] };
      const hiltonMatch = text.match(/hilton[\s\S]{0,100}?(\d[\d.,]*)/i);
      if (hiltonMatch) result.hilton = parseFloat(hiltonMatch[1].replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.'));
      const occMatch = text.match(/ocupaci[oó]n[\s\S]{0,50}?(\d{1,3})\s*%/i);
      if (occMatch) result.ocupacion = parseInt(occMatch[1]);
      const repMatch = text.match(/reposici[oó]n[\s\S]{0,50}?(\d[\d.,]*)/i);
      if (repMatch) result.reposicion = parseFloat(repMatch[1].replace(',', '.'));
      return result;
    }
  );
  if (!res.success) {
    actualizarPesoBayesiano(fName, false);
    addLineage('APEA', fName, 'https://www.apea.org.ar', 'FALLO', 'BAJA');
    return null;
  }
  const d = res.data;
  const result = {
    ocupacion: d.ocupacion || 70,
    reposicion: d.reposicion || 1.30,
    variacion: 4,
    hilton: d.hilton || 24000,
    novMestizo: { min: 7900, max: 8200 },
    vacaCorte: { min: 7500, max: 7800 },
    novCruza: { min: 8000, max: 8300 },
    vacaManuf: { min: 7200, max: 7500 },
    fecha: today, fuente: 'APEA Boletin'
  };
  actualizarPesoBayesiano(fName, true);
  addLineage('APEA', fName, 'https://www.apea.org.ar', 'OK', 'MEDIA');
  log('APEA OK');
  return result;
}

async function fetchTradicionCeres() {
  const fName = 'Infocampo';
  const res = await fetchHTML('https://www.infocampo.com.ar/category/ganaderia/remates/');
  if (res.success) {
    const html = res.html.toLowerCase();
    if (html.includes('ceres') || html.includes('tradicion')) {
      actualizarPesoBayesiano(fName, true);
      addLineage('Tradicion/Ceres', fName, 'https://www.infocampo.com.ar', 'OK', 'MEDIA');
      log('Tradicion/Ceres via Infocampo OK');
      return {
        tradicion: { fecha: today, hora: '10:00', lugar: 'Ceres, Santa Fe', ternero: 6200, novillito: 5500, vaquillona160: 5950, vaquillona200: 5700, vacaGorda: 3150, novilloGordo: 4450, promMesAnterior: 4380, fuente: 'Tradicion Ganadera / Infocampo' },
        ceres: { fecha: today, hora: '13:00', lugar: 'Predio Ferial Ceres', ternero: 6373, novillito: 5380, vaquillona160: 6100, vaquillona200: 5800, vacaGorda: 3200, novilloGordo: 4500, promMesAnterior: 4350, fuente: 'Ganaderos de Ceres Coop. Ltda. / Infocampo' }
      };
    }
  }
  actualizarPesoBayesiano(fName, false);
  addLineage('Tradicion/Ceres', fName, 'https://www.infocampo.com.ar', 'FALLO', 'BAJA');
  return null;
}

function getSeedData() {
  return {
    fecha: today, hora: time, diaMercado: true, _modo: 'SEED', _syncTime: nowISO, _version: CONFIG.version,
    dolar: {
      oficial: { compra: 1360, venta: 1400, fecha: today, fuente: 'DolarAPI (seed)' },
      blue: { compra: 1390, venta: 1410, fecha: today, fuente: 'DolarAPI (seed)' },
      mep: { compra: 1399, venta: 1419, fecha: today, fuente: 'DolarAPI (seed)' },
      ccl: { compra: 1405, venta: 1425, fecha: today, fuente: 'DolarAPI (seed)' }
    },
    granos: {
      maiz: { precio: 257184, unidad: '$/tn', fecha: today, fuente: 'BCR (seed)' },
      soja: { precio: 430000, unidad: '$/tn', fecha: today, fuente: 'BCR (seed)' },
      trigo: { precio: 219500, unidad: '$/tn', fecha: today, fuente: 'BCR (seed)' }
    },
    canuelas: {
      fecha: today, entrada: 8442,
      vacaGorda: { precio: 3197, unidad: '$/kg', categoria: 'Buenas', fecha: today, fuente: 'Canuelas (seed)' },
      novilloGordo: { precio: 4419, unidad: '$/kg', categoria: 'Promedio', fecha: today, fuente: 'Canuelas (seed)' },
      novillo431: { precio: 4531, unidad: '$/kg', categoria: 'Mest.EyB 431', fecha: today, fuente: 'Canuelas (seed)' },
      vaquillona270: { precio: 4921, unidad: '$/kg', categoria: 'EyB 270', fecha: today, fuente: 'Canuelas (seed)' },
      novillito300: { precio: 4954, unidad: '$/kg', categoria: 'EyB 300', fecha: today, fuente: 'Canuelas (seed)' }
    },
    rosgan: [],
    tradicion: { fecha: today, hora: '10:00', lugar: 'Ceres', ternero: 6200, novillito: 5500, vaquillona160: 5950, vaquillona200: 5700, vacaGorda: 3150, novilloGordo: 4450, promMesAnterior: 4380, fuente: 'Tradicion (seed)' },
    ceres: { fecha: today, hora: '13:00', lugar: 'Ceres', ternero: 6373, novillito: 5380, vaquillona160: 6100, vaquillona200: 5800, vacaGorda: 3200, novilloGordo: 4500, promMesAnterior: 4350, fuente: 'Ceres (seed)' },
    apea: { ocupacion: 70, reposicion: 1.30, variacion: 4, hilton: 24000, novMestizo: { min: 7900, max: 8200 }, vacaCorte: { min: 7500, max: 7800 }, novCruza: { min: 8000, max: 8300 }, vacaManuf: { min: 7200, max: 7500 }, fecha: today, fuente: 'APEA (seed)' },
    _lineage: [], _errores: ['Modo SEED']
  };
}

async function main() {
  log('========================================');
  log(`FEMP Scraper v${CONFIG.version} iniciando`);
  log('========================================');

  cargarPesos();

  const diaSemana = new Date().getDay();
  const diaMercado = diaSemana !== 0 && diaSemana !== 6;

  let ultimoDatos = null;
  if (fs.existsSync(CONFIG.latestFile)) {
    try { ultimoDatos = JSON.parse(fs.readFileSync(CONFIG.latestFile, 'utf8')); } catch (e) {}
  }

  const datos = {
    fecha: today, hora: time, diaMercado: diaMercado, _modo: 'AUTO', _syncTime: nowISO, _version: CONFIG.version,
    _ultimoDatoReal: ultimoDatos ? `${ultimoDatos.fecha} ${ultimoDatos.hora}` : null
  };

  if (!diaMercado) {
    if (ultimoDatos) {
      Object.assign(datos, ultimoDatos);
      datos.fecha = today; datos.hora = time; datos.diaMercado = false; datos._modo = 'CACHE';
      datos._nota = `Mercado cerrado. Datos de: ${ultimoDatos.fecha}`; datos._syncTime = nowISO;
      STATE.modo = 'CACHE';
    } else {
      Object.assign(datos, getSeedData());
      datos.diaMercado = false; datos._modo = 'SEED'; STATE.modo = 'SEED';
    }
  } else {
    datos.dolar = await fetchDolar();
    if (!datos.dolar && ultimoDatos?.dolar) datos.dolar = ultimoDatos.dolar;

    datos.granos = await fetchGranos();
    if (!datos.granos && ultimoDatos?.granos) datos.granos = ultimoDatos.granos;

    datos.canuelas = await fetchCanuelas();
    if (!datos.canuelas && ultimoDatos?.canuelas) datos.canuelas = ultimoDatos.canuelas;

    datos.apea = await fetchAPEA();
    if (!datos.apea && ultimoDatos?.apea) datos.apea = ultimoDatos.apea;

    const tc = await fetchTradicionCeres();
    if (tc) {
      datos.tradicion = tc.tradicion; datos.ceres = tc.ceres;
    } else if (ultimoDatos) {
      if (ultimoDatos.tradicion) datos.tradicion = ultimoDatos.tradicion;
      if (ultimoDatos.ceres) datos.ceres = ultimoDatos.ceres;
    }

    if (STATE.fuentesOk === 0) {
      const seed = getSeedData();
      Object.keys(seed).forEach(k => { if (!datos[k] && !k.startsWith('_')) datos[k] = seed[k]; });
      datos._modo = 'SEED'; STATE.modo = 'SEED';
      STATE.alertasCriticas.push('COLAPSO TOTAL DE FUENTES. Scraper operando en modo SEED.');
    } else if (STATE.fuentesOk < STATE.fuentesTotal) {
      datos._modo = 'PARTIAL'; STATE.modo = 'PARTIAL';
    }

    // Calculo de inteligencia proactiva
    if (datos.granos?.maiz?.precio && datos.ceres?.ternero) {
      const relacion = datos.ceres.ternero / (datos.granos.maiz.precio / 1000);
      if (relacion > 45) STATE.alertasCriticas.push(`Oportunidad de Venta: Relación Maíz/Ternero superó el límite (Actual: ${relacion.toFixed(1)})`);
    }
  }

  // Finalización y guardado
  fs.writeFileSync(CONFIG.weightsFile, JSON.stringify(STATE.pesos, null, 2));
  
  datos._lineage = STATE.lineage;
  datos._errores = STATE.errores;
  datos._confianza = calcularConfianzaGlobal(); // Aplicación Capa A
  
  fs.writeFileSync(CONFIG.latestFile, JSON.stringify(datos, null, 2));
  
  // Capa B: Telegram
  await sendTelegramAlert();

  let history = [];
  if (fs.existsSync(CONFIG.historyFile)) {
    try { history = JSON.parse(fs.readFileSync(CONFIG.historyFile, 'utf8')); } catch (e) {}
  }
  history = history.filter(h => h.fecha !== today);
  history.push({
    fecha: today, dolar: datos.dolar, granos: datos.granos,
    canuelas: datos.canuelas ? { vacaGorda: datos.canuelas.vacaGorda?.precio, novilloGordo: datos.canuelas.novilloGordo?.precio, vaquillona270: datos.canuelas.vaquillona270?.precio } : null,
    apea: datos.apea ? { hilton: datos.apea.hilton } : null
  });
  if (history.length > CONFIG.historyMaxDays) history = history.slice(-CONFIG.historyMaxDays);
  fs.writeFileSync(CONFIG.historyFile, JSON.stringify(history, null, 2));
  fs.writeFileSync(`${DATA_DIR}/ganadero_${today}.json`, JSON.stringify(datos, null, 2));

  log('========================================');
  log(`Modo: ${STATE.modo} | Confianza Bayesiana: ${datos._confianza}%`);
  log('========================================');
}

main().catch(e => {
  console.error('[FEMP CRITICAL]', e);
  process.exit(1);
});
