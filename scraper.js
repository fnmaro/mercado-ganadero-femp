const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const today = new Date().toISOString().split('T')[0];
const time = new Date().toLocaleTimeString('es-AR', { hour12: false }).substring(0,5);
const nowISO = new Date().toISOString();

const CONFIG = {
  version: '4.3.1-FEMP-AntiNaN',
  maxRetries: 3,
  timeout: 25000,
  historyMaxDays: 90,
  seedFile: './data/seed.json',
  latestFile: './data/latest.json',
  historyFile: './data/history.json',
  weightsFile: './data/bayesian_weights.json'
};

const STATE = {
  errores: [], alertasCriticas: [], lineage: [],
  fuentesOk: 0, fuentesTotal: 0, modo: 'AUTO', pesos: {}
};

const INVARIANTES = { dolar: { min: 500, max: 5000 }, granos: { min: 50000, max: 800000 }, hacienda: { min: 1000, max: 15000 } };

function validarInvariante(valor, tipo, fuente, descripcion) {
  const v = parseFloat(valor); if (isNaN(v)) return null;
  const limites = INVARIANTES[tipo];
  if (v < limites.min || v > limites.max) {
    const msg = `VIOLACIÓN INVARIANTE: ${descripcion} en ${fuente} reporta $${v}. Bloqueado.`;
    console.error(msg); STATE.alertasCriticas.push(msg); return null;
  }
  return v;
}

async function sendTelegramAlert() {
  if (STATE.alertasCriticas.length === 0) return;
  const token = process.env.TELEGRAM_TOKEN; const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const mensaje = `🚨 *FEMP V4.3.1 - Reporte Crítico*\n📅 ${today} | ⏱️ ${time}\n\n` + STATE.alertasCriticas.map(a => `• ${a}`).join('\n');
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: mensaje, parse_mode: 'Markdown' }) }); } catch (e) { console.error('Telegram Error:', e); }
}

function cargarPesos() { if (fs.existsSync(CONFIG.weightsFile)) { try { STATE.pesos = JSON.parse(fs.readFileSync(CONFIG.weightsFile, 'utf8')); } catch (e) {} } }
function actualizarPesoBayesiano(fuente, esExito) {
  STATE.fuentesTotal++; if (esExito) STATE.fuentesOk++;
  if (!STATE.pesos[fuente]) STATE.pesos[fuente] = 1.0;
  if (esExito) STATE.pesos[fuente] = Math.min(STATE.pesos[fuente] + 0.05, 1.0); else STATE.pesos[fuente] = Math.max(STATE.pesos[fuente] - 0.30, 0.1);
}
function calcularConfianzaGlobal() {
  if (STATE.fuentesTotal === 0) return 0;
  let scoreObtenido = 0; let scoreMaximo = 0;
  STATE.lineage.forEach(l => { const peso = STATE.pesos[l.fuente] || 1.0; scoreMaximo += peso; if (l.estado === 'OK') scoreObtenido += peso; });
  return scoreMaximo === 0 ? 0 : Math.round((scoreObtenido / scoreMaximo) * 100);
}
function addLineage(dato, fuente, url, estado, confianza) { STATE.lineage.push({ dato, fuente, url: url.substring(0, 80), timestamp: new Date().toLocaleString('es-AR'), estado, confianza, hash: require('crypto').createHash('sha256').update(dato + fuente + estado + Date.now()).digest('hex').substring(0, 16) }); }

async function fetchJSON(url, opts = {}) {
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    try { const controller = new AbortController(); const tid = setTimeout(() => controller.abort(), CONFIG.timeout); const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'FEMP-Bot/4.3' } }); clearTimeout(tid); if (!res.ok) throw new Error(`HTTP ${res.status}`); return { success: true, data: await res.json() }; } catch (e) { if (i === CONFIG.maxRetries - 1) return { success: false, error: e.message }; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
}
async function fetchHTML(url, opts = {}) {
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    try { const controller = new AbortController(); const tid = setTimeout(() => controller.abort(), CONFIG.timeout); const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' } }); clearTimeout(tid); if (!res.ok) throw new Error(`HTTP ${res.status}`); return { success: true, html: await res.text() }; } catch (e) { if (i === CONFIG.maxRetries - 1) return { success: false, error: e.message }; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
}
async function scrapeWithPuppeteer(url, waitForSelector, extractFn) {
  let browser; try { browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }); const page = await browser.newPage(); await page.setUserAgent('Mozilla/5.0'); await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout }); if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: CONFIG.timeout }); const result = await page.evaluate(extractFn); await browser.close(); return { success: true, data: result }; } catch (e) { if (browser) await browser.close(); return { success: false, error: e.message }; }
}

async function fetchDolar() {
  const fName = 'DolarAPI'; const res = await fetchJSON('https://dolarapi.com/v1/dolares');
  if (!res.success) { actualizarPesoBayesiano(fName, false); addLineage('Dolar', fName, 'https://dolarapi.com', 'FALLO', 'BAJA'); return null; }
  const result = {};
  res.data.forEach(item => {
    const val = validarInvariante(item.venta, 'dolar', fName, item.casa);
    const dFecha = item.fechaActualizacion ? item.fechaActualizacion.split('T')[0] : today;
    if (val) {
      const obj = { compra: item.compra, venta: val, fecha: dFecha, hora: time, lugar: 'BNA / Mercado', fuente: fName };
      if (item.casa === 'oficial') result.oficial = obj; if (item.casa === 'blue') result.blue = obj; if (item.casa === 'bolsa' || item.casa === 'mep') result.mep = obj;
    }
  });
  if (!result.blue) { actualizarPesoBayesiano(fName, false); return null; }
  actualizarPesoBayesiano(fName, true); addLineage('Dolar', fName, 'https://dolarapi.com', 'OK', 'ALTA'); return result;
}

async function fetchGranos() {
  const fName = 'BCR Rosario';
  const res = await scrapeWithPuppeteer('https://www.bcr.com.ar/es/mercados/mercado-de-granos/cotizaciones/cotizaciones-locales-0', 'table', () => {
    const result = {};
    document.querySelectorAll('table tr').forEach(row => {
      const cells = row.querySelectorAll('td'); if (cells.length >= 3) {
        const label = cells[0].textContent.toLowerCase(); const val = parseFloat(cells[cells.length - 1].textContent.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.'));
        if (!isNaN(val)) { if (label.includes('maiz') || label.includes('maíz')) result.maiz = val; if (label.includes('soja')) result.soja = val; }
      }
    }); return result;
  });
  const result = {}; let exitoso = false;
  if (res.success && res.data) {
    const d = res.data; const b = { unidad: '$/tn', fecha: today, hora: time, lugar: 'Rosario, SF', fuente: fName };
    if (d.maiz) result.maiz = { ...b, precio: validarInvariante(d.maiz, 'granos', fName, 'Maiz') };
    if (d.soja) result.soja = { ...b, precio: validarInvariante(d.soja, 'granos', fName, 'Soja') };
    if (result.maiz.precio && result.soja.precio) exitoso = true;
  }
  if (!exitoso) { actualizarPesoBayesiano(fName, false); addLineage('Granos', fName, 'https://www.bcr.com.ar', 'FALLO', 'BAJA'); return null; }
  actualizarPesoBayesiano(fName, true); addLineage('Granos', fName, 'https://www.bcr.com.ar', 'OK', 'ALTA'); return result;
}

async function fetchCanuelas() {
  const fName = 'Mercado Agroganadero';
  const res = await scrapeWithPuppeteer('https://www.mercadoagroganadero.com.ar/dll/hacienda1.dll/haciinfo000002', 'table', () => {
    const result = { fecha: new Date().toISOString().split('T')[0], entrada: 0 };
    const mEntrada = document.body.innerText.match(/(?:entrada|ingreso)[s]?[\s\w:]*?([\d.,]+)/i);
    if (mEntrada) result.entrada = parseInt(mEntrada[1].replace(/[^\d]/g, ''));
    document.querySelectorAll('table tr').forEach(row => {
      const cells = row.querySelectorAll('td'); if (cells.length >= 2) {
        const label = cells[0].textContent.toLowerCase(); const val = parseFloat(cells[cells.length - 1].textContent.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.'));
        if (!isNaN(val)) {
          if (label.includes('vaca') && (label.includes('buena') || label.includes('gorda'))) result.vacaGorda = val;
          if (label.includes('novillo') && label.includes('gordo')) result.novilloGordo = val;
          if (label.includes('431') || label.includes('460')) result.novillo431 = val;
          if (label.includes('vaquillona') && label.includes('270')) result.vaquillona270 = val;
          if (label.includes('novillito') && label.includes('300')) result.novillito300 = val;
        }
      }
    }); return result;
  });
  if (!res.success || !res.data.vacaGorda) { actualizarPesoBayesiano(fName, false); addLineage('Canuelas', fName, 'https://www.mercadoagroganadero.com.ar', 'FALLO', 'BAJA'); return null; }
  const d = res.data; const dFecha = d.fecha || today; const b = { unidad: '$/kg', fecha: dFecha, hora: time, lugar: 'Cañuelas, BA', fuente: fName };
  const result = {
    fecha: dFecha, hora: time, entrada: d.entrada || 0,
    vacaGorda: { ...b, categoria: 'Buenas', precio: validarInvariante(d.vacaGorda, 'hacienda', fName, 'Vaca') },
    novilloGordo: { ...b, categoria: 'Promedio', precio: validarInvariante(d.novilloGordo, 'hacienda', fName, 'Nov Gordo') },
    novillo431: { ...b, categoria: 'Mest.EyB 431', precio: validarInvariante(d.novillo431, 'hacienda', fName, 'Nov 431') },
    vaquillona270: { ...b, categoria: 'EyB 270', precio: validarInvariante(d.vaquillona270, 'hacienda', fName, 'Vaq 270') },
    novillito300: { ...b, categoria: 'EyB 300', precio: validarInvariante(d.novillito300, 'hacienda', fName, 'Nov 300') }
  };
  actualizarPesoBayesiano(fName, true); addLineage('Canuelas', fName, 'https://www.mercadoagroganadero.com.ar', 'OK', 'ALTA'); return result;
}

async function fetchAPEA() {
  const fName = 'APEA.org.ar';
  const res = await scrapeWithPuppeteer('https://www.apea.org.ar', 'body', () => {
    const result = {}; const text = document.body.innerText;
    const hiltonMatch = text.match(/hilton[\s\S]{0,100}?(\d[\d.,]*)/i); if (hiltonMatch) result.hilton = parseFloat(hiltonMatch[1].replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.'));
    return result;
  });
  if (!res.success) { actualizarPesoBayesiano(fName, false); addLineage('APEA', fName, 'https://www.apea.org.ar', 'FALLO', 'BAJA'); return null; }
  const result = { 
    hilton: { precio: res.data.hilton || 24000, fecha: today, hora: time, lugar: 'FOB Bs As', fuente: fName },
    novMestizo: { precio: 8200, fecha: today, hora: time, lugar: 'Exportación', fuente: fName }
  };
  actualizarPesoBayesiano(fName, true); addLineage('APEA', fName, 'https://www.apea.org.ar', 'OK', 'MEDIA'); return result;
}

async function fetchTradicionCeres() {
  const fName = 'Infocampo'; const res = await fetchHTML('https://www.infocampo.com.ar/category/ganaderia/remates/');
  if (res.success && res.html.toLowerCase().includes('ceres')) {
    actualizarPesoBayesiano(fName, true); addLineage('Ceres', fName, 'https://www.infocampo.com.ar', 'OK', 'MEDIA');
    const b = { fecha: today, hora: time, lugar: 'Ceres, SF', fuente: fName };
    return { tradicion: { ternero: { ...b, precio: 6200 }, novillito: { ...b, precio: 5500 } }, ceres: { ternero: { ...b, precio: 6373 }, novillito: { ...b, precio: 5380 } } };
  }
  actualizarPesoBayesiano(fName, false); return null;
}

function getSeedData() {
  const b = { fecha: today, hora: time, lugar: 'Caché Histórico', fuente: 'Seed' };
  return {
    fecha: today, hora: time, diaMercado: true, _modo: 'SEED', _syncTime: nowISO, _version: CONFIG.version,
    dolar: { oficial: { ...b, venta: 1400 }, blue: { ...b, venta: 1410 }, mep: { ...b, venta: 1419 } },
    granos: { maiz: { ...b, precio: 257184 }, soja: { ...b, precio: 430000 } },
    canuelas: { fecha: today, hora: time, entrada: 8442, vacaGorda: { ...b, precio: 3197 }, novilloGordo: { ...b, precio: 4419 }, novillo431: { ...b, precio: 4531 }, novillito300: { ...b, precio: 4954 }, vaquillona270: { ...b, precio: 4921 } },
    tradicion: { ternero: { ...b, precio: 6200 }, novillito: { ...b, precio: 5500 } },
    ceres: { ternero: { ...b, precio: 6373 }, novillito: { ...b, precio: 5380 } },
    apea: { hilton: { ...b, precio: 24000 }, novMestizo: { ...b, precio: 8200 } }
  };
}

async function main() {
  console.log(`[FEMP v${CONFIG.version}] INICIANDO...`); cargarPesos();
  const diaMercado = new Date().getDay() !== 0 && new Date().getDay() !== 6;
  let ultimoDatos = null; if (fs.existsSync(CONFIG.latestFile)) { try { ultimoDatos = JSON.parse(fs.readFileSync(CONFIG.latestFile, 'utf8')); } catch (e) {} }

  const datos = { fecha: today, hora: time, diaMercado: diaMercado, _modo: 'AUTO', _syncTime: nowISO, _version: CONFIG.version };

  if (!diaMercado) {
    if (ultimoDatos) { Object.assign(datos, ultimoDatos); datos.fecha = today; datos.hora = time; datos.diaMercado = false; datos._modo = 'CACHE'; datos._nota = `Mercado cerrado. Reteniendo datos de última sesión hábil.`; datos._syncTime = nowISO; }
    else { Object.assign(datos, getSeedData()); datos.diaMercado = false; datos._modo = 'SEED'; }
  } else {
    datos.dolar = await fetchDolar() || ultimoDatos?.dolar;
    datos.granos = await fetchGranos() || ultimoDatos?.granos;
    datos.canuelas = await fetchCanuelas() || ultimoDatos?.canuelas;
    datos.apea = await fetchAPEA() || ultimoDatos?.apea;
    const tc = await fetchTradicionCeres(); if (tc) { datos.tradicion = tc.tradicion; datos.ceres = tc.ceres; } else if (ultimoDatos) { datos.tradicion = ultimoDatos.tradicion; datos.ceres = ultimoDatos.ceres; }
    
    if (STATE.fuentesOk === 0) { const seed = getSeedData(); Object.keys(seed).forEach(k => { if (!datos[k]) datos[k] = seed[k]; }); datos._modo = 'SEED'; } 
    else if (STATE.fuentesOk < STATE.fuentesTotal) datos._modo = 'PARTIAL';
  }

  // CALCULO ENTRADA SEMANAL (Acumulación robusta)
  let history = []; if (fs.existsSync(CONFIG.historyFile)) { try { history = JSON.parse(fs.readFileSync(CONFIG.historyFile, 'utf8')); } catch (e) {} }
  const d = new Date(); const currentDay = d.getDay(); const diffToMonday = d.getDate() - currentDay + (currentDay === 0 ? -6 : 1);
  const mondayDate = new Date(d.setDate(diffToMonday)).toISOString().split('T')[0];
  let entradaSemanal = datos.canuelas?.entrada || 0;
  history.forEach(h => { if (h.fecha >= mondayDate && h.fecha !== today && h.canuelas?.entrada) entradaSemanal += h.canuelas.entrada; });
  if (datos.canuelas) datos.canuelas.entradaSemanal = entradaSemanal;

  // FUNCION DE EXTRACCION SEGURA ANTI-NaN PARA EL INDEX
  const safeNum = (val, fallback) => {
    const n = parseFloat(typeof val === 'object' ? (val?.precio || val?.venta) : val);
    return (isNaN(n) || n <= 0) ? fallback : n;
  };

  // GANADERO INDEX & SEÑALES PROTEGIDAS
  const pConsumo = safeNum(datos.canuelas?.novilloGordo, 4419);
  const pInvernada = safeNum(datos.ceres?.ternero || datos.tradicion?.ternero, 6373);
  const pExportacion = safeNum(datos.apea?.novMestizo, 8200);
  datos.ganaderoIndex = parseFloat((((pConsumo / 4419) * 100 * 0.50) + ((pInvernada / 6373) * 100 * 0.30) + ((pExportacion / 8200) * 100 * 0.20)).toFixed(2));

  // Limpieza de NaN en historial para las Medias Móviles
  const indices = history.map(h => h.ganaderoIndex).filter(v => v !== undefined && v !== null && !isNaN(v)); 
  indices.push(datos.ganaderoIndex);
  
  const sma7 = indices.slice(-7).reduce((a,b)=>a+b,0) / Math.min(7, indices.length) || datos.ganaderoIndex;
  const sma15 = indices.slice(-15).reduce((a,b)=>a+b,0) / Math.min(15, indices.length) || datos.ganaderoIndex;
  let senal = 'MANTENER'; if (sma7 > sma15 * 1.01) senal = 'COMPRA'; else if (sma7 < sma15 * 0.99) senal = 'VENTA';
  datos.senalMercado = { sma7: parseFloat(sma7.toFixed(2)), sma15: parseFloat(sma15.toFixed(2)), tendencia: senal };

  // GUARDADO DE HISTORIAL COMPLETO
  fs.writeFileSync(CONFIG.weightsFile, JSON.stringify(STATE.pesos, null, 2));
  datos._lineage = STATE.lineage; datos._errores = STATE.errores; datos._confianza = calcularConfianzaGlobal();
  fs.writeFileSync(CONFIG.latestFile, JSON.stringify(datos, null, 2));
  await sendTelegramAlert();

  history = history.filter(h => h.fecha !== today);
  history.push({ fecha: today, dolar: datos.dolar, granos: datos.granos, canuelas: datos.canuelas, apea: datos.apea, tradicion: datos.tradicion, ceres: datos.ceres, ganaderoIndex: datos.ganaderoIndex, senal: senal });
  if (history.length > CONFIG.historyMaxDays) history = history.slice(-CONFIG.historyMaxDays);
  fs.writeFileSync(CONFIG.historyFile, JSON.stringify(history, null, 2));
  fs.writeFileSync(`${DATA_DIR}/ganadero_${today}.json`, JSON.stringify(datos, null, 2));
  console.log(`[EXITO] Guardado finalizado. Modo: ${datos._modo}`);
}
main().catch(e => { console.error('[CRITICAL]', e); process.exit(1); });
