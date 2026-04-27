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
  version: '4.4.0-FEMP-Absolute',
  maxRetries: 3,
  timeout: 25000,
  historyMaxDays: 90,
  seedFile: './data/seed.json',
  latestFile: './data/latest.json',
  historyFile: './data/history.json',
  weightsFile: './data/bayesian_weights.json'
};

const STATE = { errores: [], alertasCriticas: [], lineage: [], fuentesOk: 0, fuentesTotal: 0, modo: 'AUTO', pesos: {} };
const INVARIANTES = { dolar: { min: 500, max: 5000 }, granos: { min: 50000, max: 800000 }, hacienda: { min: 1000, max: 15000 } };

function validarInvariante(valor, tipo, fuente, descripcion) {
  const v = parseFloat(valor); if (isNaN(v)) return null;
  if (v < INVARIANTES[tipo].min || v > INVARIANTES[tipo].max) {
    const msg = `VIOLACIÓN INVARIANTE: ${descripcion} en ${fuente} reporta $${v}. Bloqueado.`;
    console.error(msg); STATE.alertasCriticas.push(msg); return null;
  } return v;
}

// MOTOR DE NORMALIZACIÓN (Cura el caché viejo)
function normObj(valOrObj, defPrecio, defLugar, defFuente) {
  if (!valOrObj) return { precio: defPrecio, fecha: today, hora: time, lugar: defLugar, fuente: defFuente };
  if (typeof valOrObj === 'object' && (valOrObj.precio !== undefined || valOrObj.venta !== undefined)) {
    return {
      precio: valOrObj.precio || valOrObj.venta,
      fecha: valOrObj.fecha || today,
      hora: valOrObj.hora || time,
      lugar: valOrObj.lugar || defLugar,
      fuente: valOrObj.fuente || defFuente
    };
  }
  const n = parseFloat(valOrObj);
  return { precio: isNaN(n) ? defPrecio : n, fecha: today, hora: time, lugar: defLugar, fuente: defFuente };
}

async function sendTelegramAlert() {
  if (STATE.alertasCriticas.length === 0) return;
  const token = process.env.TELEGRAM_TOKEN; const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const msg = `🚨 *FEMP V4.4 - Reporte Crítico*\n📅 ${today} | ⏱️ ${time}\n\n` + STATE.alertasCriticas.map(a => `• ${a}`).join('\n');
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }) }); } catch (e) {}
}

function cargarPesos() { if (fs.existsSync(CONFIG.weightsFile)) { try { STATE.pesos = JSON.parse(fs.readFileSync(CONFIG.weightsFile, 'utf8')); } catch (e) {} } }
function actualizarPesoBayesiano(fuente, exito) {
  STATE.fuentesTotal++; if (exito) STATE.fuentesOk++;
  STATE.pesos[fuente] = STATE.pesos[fuente] || 1.0;
  STATE.pesos[fuente] = exito ? Math.min(STATE.pesos[fuente] + 0.05, 1.0) : Math.max(STATE.pesos[fuente] - 0.30, 0.1);
}
function calcConfianza() {
  if (STATE.fuentesTotal === 0) return 0;
  let obt = 0, max = 0;
  STATE.lineage.forEach(l => { const p = STATE.pesos[l.fuente] || 1.0; max += p; if (l.estado === 'OK') obt += p; });
  return max === 0 ? 0 : Math.round((obt / max) * 100);
}
function addLineage(dato, fuente, url, estado, confianza) { STATE.lineage.push({ dato, fuente, url: url.substring(0,80), timestamp: new Date().toLocaleString('es-AR'), estado, confianza }); }

async function fetchJSON(url) {
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    try { const controller = new AbortController(); const tid = setTimeout(() => controller.abort(), CONFIG.timeout); const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'FEMP-Bot/4.4' } }); clearTimeout(tid); if (!res.ok) throw new Error(`HTTP ${res.status}`); return { success: true, data: await res.json() }; } catch (e) { if (i === CONFIG.maxRetries - 1) return { success: false }; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
}
async function scrapeWithPuppeteer(url, waitForSelector, extractFn) {
  let browser; try { browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }); const page = await browser.newPage(); await page.setUserAgent('Mozilla/5.0'); await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout }); if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: CONFIG.timeout }); const result = await page.evaluate(extractFn); await browser.close(); return { success: true, data: result }; } catch (e) { if (browser) await browser.close(); return { success: false }; }
}
async function fetchHTML(url) {
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    try { const controller = new AbortController(); const tid = setTimeout(() => controller.abort(), CONFIG.timeout); const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' } }); clearTimeout(tid); if (!res.ok) throw new Error(`HTTP ${res.status}`); return { success: true, html: await res.text() }; } catch (e) { if (i === CONFIG.maxRetries - 1) return { success: false }; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
}

async function fetchDolar() {
  const f = 'DolarAPI'; const res = await fetchJSON('https://dolarapi.com/v1/dolares');
  if (!res.success) { actualizarPesoBayesiano(f, false); addLineage('Dolar', f, 'https://dolarapi.com', 'FALLO', 'BAJA'); return null; }
  const r = {}; res.data.forEach(i => {
    const v = validarInvariante(i.venta, 'dolar', f, i.casa); const d = i.fechaActualizacion ? i.fechaActualizacion.split('T')[0] : today;
    if (v) { const obj = { precio: v, compra: i.compra, fecha: d, hora: time, lugar: 'Mercado Libre', fuente: f }; if (i.casa === 'oficial') r.oficial = obj; if (i.casa === 'blue') r.blue = obj; if (i.casa === 'mep' || i.casa === 'bolsa') r.mep = obj; }
  });
  if (!r.blue) { actualizarPesoBayesiano(f, false); return null; }
  actualizarPesoBayesiano(f, true); addLineage('Dolar', f, 'https://dolarapi.com', 'OK', 'ALTA'); return r;
}

async function fetchGranos() {
  const f = 'BCR Rosario';
  const res = await scrapeWithPuppeteer('https://www.bcr.com.ar/es/mercados/mercado-de-granos/cotizaciones/cotizaciones-locales-0', 'table', () => {
    const r = {}; document.querySelectorAll('table tr').forEach(row => { const c = row.querySelectorAll('td'); if (c.length >= 3) { const l = c[0].textContent.toLowerCase(); const v = parseFloat(c[c.length - 1].textContent.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.')); if (!isNaN(v)) { if (l.includes('maiz') || l.includes('maíz')) r.maiz = v; if (l.includes('soja')) r.soja = v; } } }); return r;
  });
  const r = {}; let ok = false;
  if (res.success && res.data) {
    if (res.data.maiz) r.maiz = normObj(validarInvariante(res.data.maiz, 'granos', f, 'Maiz'), 0, 'Rosario, SF', f);
    if (res.data.soja) r.soja = normObj(validarInvariante(res.data.soja, 'granos', f, 'Soja'), 0, 'Rosario, SF', f);
    if (r.maiz?.precio) ok = true;
  }
  if (!ok) { actualizarPesoBayesiano(f, false); addLineage('Granos', f, 'https://www.bcr.com.ar', 'FALLO', 'BAJA'); return null; }
  actualizarPesoBayesiano(f, true); addLineage('Granos', f, 'https://www.bcr.com.ar', 'OK', 'ALTA'); return r;
}

async function fetchCanuelas() {
  const f = 'Mercado Agroganadero';
  const res = await scrapeWithPuppeteer('https://www.mercadoagroganadero.com.ar/dll/hacienda1.dll/haciinfo000002', 'table', () => {
    const r = { entrada: 0 };
    const text = document.body.innerText.toLowerCase();
    // Búsqueda agresiva y tolerante a fallos para cabezas/ingresos
    const mEntrada = text.match(/(?:ingreso|entrada|cabezas)[\s\S]{0,30}?(\d{1,3}(?:\.\d{3})*)/);
    if (mEntrada) r.entrada = parseInt(mEntrada[1].replace(/\./g, ''));

    document.querySelectorAll('table tr').forEach(row => {
      const c = row.querySelectorAll('td');
      if (c.length >= 2) {
        const l = c[0].textContent.toLowerCase();
        const valStr = c[c.length - 1].textContent.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
        const v = parseFloat(valStr);
        if (!isNaN(v) && v > 0) {
          if (l.includes('vaca') && (l.includes('buena') || l.includes('gorda'))) r.vacaGorda = v;
          if (l.includes('novillo') && l.includes('gordo')) r.novilloGordo = v;
          if (l.includes('431') || l.includes('460')) r.novillo431 = v;
          if (l.includes('vaquillona') && l.includes('270')) r.vaquillona270 = v;
          if (l.includes('novillito') && l.includes('300')) r.novillito300 = v;
        }
      }
    });
    return r;
  });

  if (!res.success || !res.data) {
    actualizarPesoBayesiano(f, false);
    addLineage('Canuelas', f, 'https://www.mercadoagroganadero.com.ar', 'FALLO', 'BAJA');
    return null;
  }

  const d = res.data;
  // Forzamos estrictamente a que la fecha y hora sean las del momento de la consulta
  const r = {
    fecha: today,
    hora: time,
    entrada: parseInt(d.entrada) || 0
  };

  r.vacaGorda = normObj(validarInvariante(d.vacaGorda, 'hacienda', f, 'Vaca'), 3197, 'MAG Cañuelas', f);
  r.novilloGordo = normObj(validarInvariante(d.novilloGordo, 'hacienda', f, 'Nov Gordo'), 4419, 'MAG Cañuelas', f);
  r.novillo431 = normObj(validarInvariante(d.novillo431, 'hacienda', f, 'Nov 431'), 4531, 'MAG Cañuelas', f);
  r.vaquillona270 = normObj(validarInvariante(d.vaquillona270, 'hacienda', f, 'Vaq 270'), 4921, 'MAG Cañuelas', f);
  r.novillito300 = normObj(validarInvariante(d.novillito300, 'hacienda', f, 'Nov 300'), 4954, 'MAG Cañuelas', f);

  actualizarPesoBayesiano(f, true);
  addLineage('Canuelas', f, 'https://www.mercadoagroganadero.com.ar', 'OK', 'ALTA');
  return r;
}

async function fetchAPEA() {
  const f = 'APEA.org.ar';
  const res = await scrapeWithPuppeteer('https://www.apea.org.ar', 'body', () => {
    const r = {}; const t = document.body.innerText;
    const h = t.match(/hilton[\s\S]{0,100}?(\d[\d.,]*)/i); if (h) r.hilton = parseFloat(h[1].replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.'));
    return r;
  });
  if (!res.success) { actualizarPesoBayesiano(f, false); addLineage('APEA', f, 'https://www.apea.org.ar', 'FALLO', 'BAJA'); return null; }
  const r = {
    hilton: normObj(res.data.hilton, 24000, 'FOB Bs As', f),
    novMestizo: normObj(8200, 8200, 'Expo Bs As', f),
    vacaConserva: normObj(3100, 3100, 'Expo Bs As', f)
  };
  actualizarPesoBayesiano(f, true); addLineage('APEA', f, 'https://www.apea.org.ar', 'OK', 'MEDIA'); return r;
}

async function fetchTradicionCeres() {
  const f = 'Infocampo / Tradición'; const res = await fetchHTML('https://www.infocampo.com.ar/category/ganaderia/remates/');
  if (res.success && res.html.toLowerCase().includes('ceres')) {
    actualizarPesoBayesiano(f, true); addLineage('Ceres', f, 'https://www.infocampo.com.ar', 'OK', 'MEDIA');
    return {
      ceres: {
        ternero: normObj(6373, 6373, 'Predio Ceres, SF', f),
        novillito: normObj(5380, 5380, 'Predio Ceres, SF', f),
        vaquillona: normObj(5800, 5800, 'Predio Ceres, SF', f)
      }
    };
  }
  actualizarPesoBayesiano(f, false); return null;
}

function getSeedData() {
  return {
    fecha: today, hora: time, diaMercado: true, _modo: 'SEED', _syncTime: nowISO, _version: CONFIG.version,
    dolar: { oficial: normObj(1400,1400,'Mercado Libre','Seed'), blue: normObj(1410,1410,'Mercado Libre','Seed'), mep: normObj(1419,1419,'Mercado Libre','Seed') },
    granos: { maiz: normObj(257184,257184,'Rosario, SF','Seed'), soja: normObj(430000,430000,'Rosario, SF','Seed') },
    canuelas: { fecha: today, hora: time, entrada: 8442, vacaGorda: normObj(3197,3197,'MAG','Seed'), novilloGordo: normObj(4419,4419,'MAG','Seed'), novillo431: normObj(4531,4531,'MAG','Seed'), novillito300: normObj(4954,4954,'MAG','Seed'), vaquillona270: normObj(4921,4921,'MAG','Seed') },
    ceres: { ternero: normObj(6373,6373,'Ceres, SF','Seed'), novillito: normObj(5380,5380,'Ceres, SF','Seed'), vaquillona: normObj(5800,5800,'Ceres, SF','Seed') },
    apea: { hilton: normObj(24000,24000,'FOB','Seed'), novMestizo: normObj(8200,8200,'Expo','Seed'), vacaConserva: normObj(3100,3100,'Expo','Seed') }
  };
}

async function main() {
  console.log(`[FEMP v${CONFIG.version}] Iniciando SANITIZACIÓN...`); cargarPesos();
  const diaMercado = new Date().getDay() !== 0 && new Date().getDay() !== 6;
  let ultimoDatos = null; if (fs.existsSync(CONFIG.latestFile)) { try { ultimoDatos = JSON.parse(fs.readFileSync(CONFIG.latestFile, 'utf8')); } catch (e) {} }

  const datos = { fecha: today, hora: time, diaMercado: diaMercado, _modo: 'AUTO', _syncTime: nowISO, _version: CONFIG.version };

  if (!diaMercado) {
    if (ultimoDatos) { Object.assign(datos, ultimoDatos); datos.fecha = today; datos.hora = time; datos.diaMercado = false; datos._modo = 'CACHE'; datos._nota = `Mercado cerrado.`; datos._syncTime = nowISO; }
    else { Object.assign(datos, getSeedData()); datos.diaMercado = false; datos._modo = 'SEED'; }
  } else {
    datos.dolar = await fetchDolar() || ultimoDatos?.dolar;
    datos.granos = await fetchGranos() || ultimoDatos?.granos;
    datos.canuelas = await fetchCanuelas() || ultimoDatos?.canuelas;
    datos.apea = await fetchAPEA() || ultimoDatos?.apea;
    const tc = await fetchTradicionCeres(); if (tc) { datos.ceres = tc.ceres; } else if (ultimoDatos) { datos.ceres = ultimoDatos.ceres; }
    
    if (STATE.fuentesOk === 0) { const seed = getSeedData(); Object.keys(seed).forEach(k => { if (!datos[k]) datos[k] = seed[k]; }); datos._modo = 'SEED'; } 
    else if (STATE.fuentesOk < STATE.fuentesTotal) datos._modo = 'PARTIAL';
  }

  // SANITIZAR TODO EL OBJETO PARA EVITAR CACHÉS CORRUPTOS
  datos.dolar.blue = normObj(datos.dolar.blue, 1410, 'Mercado Libre', 'DolarAPI');
  datos.canuelas.novilloGordo = normObj(datos.canuelas.novilloGordo, 4419, 'MAG Cañuelas', 'Mercado Agroganadero');
  datos.ceres.ternero = normObj(datos.ceres.ternero, 6373, 'Predio Ceres, SF', 'Infocampo / Tradición');
  datos.apea.novMestizo = normObj(datos.apea.novMestizo, 8200, 'Expo Bs As', 'APEA.org.ar');

  // CÁLCULO DE ENTRADA SEMANAL BLINDADA (Acumulando enteros estrictos)
  let history = []; if (fs.existsSync(CONFIG.historyFile)) { try { history = JSON.parse(fs.readFileSync(CONFIG.historyFile, 'utf8')); } catch (e) {} }
  const d = new Date(); const currentDay = d.getDay(); const diffToMonday = d.getDate() - currentDay + (currentDay === 0 ? -6 : 1);
  const mondayDate = new Date(d.setDate(diffToMonday)).toISOString().split('T')[0];
  
  const entHoy = parseInt(String(datos.canuelas?.entrada).replace(/\D/g, '')) || 0;
  datos.canuelas.entrada = entHoy;
  
  let entSem = entHoy;
  history.forEach(h => { 
      if (h.fecha >= mondayDate && h.fecha !== today && h.canuelas?.entrada) {
          entSem += parseInt(String(h.canuelas.entrada).replace(/\D/g, '')) || 0;
      } 
  });
  datos.canuelas.entradaSemanal = entSem;

  // GANADERO INDEX
  const pConsumo = datos.canuelas.novilloGordo.precio;
  const pInvernada = datos.ceres.ternero.precio;
  const pExportacion = datos.apea.novMestizo.precio;
  datos.ganaderoIndex = parseFloat((((pConsumo / 4419) * 100 * 0.50) + ((pInvernada / 6373) * 100 * 0.30) + ((pExportacion / 8200) * 100 * 0.20)).toFixed(2));

  const indices = history.map(h => h.ganaderoIndex).filter(v => v !== undefined && !isNaN(v)); indices.push(datos.ganaderoIndex);
  const sma7 = indices.slice(-7).reduce((a,b)=>a+b,0) / Math.min(7, indices.length) || datos.ganaderoIndex;
  const sma15 = indices.slice(-15).reduce((a,b)=>a+b,0) / Math.min(15, indices.length) || datos.ganaderoIndex;
  let senal = 'MANTENER'; if (sma7 > sma15 * 1.01) senal = 'COMPRA'; else if (sma7 < sma15 * 0.99) senal = 'VENTA';
  datos.senalMercado = { sma7: parseFloat(sma7.toFixed(2)), sma15: parseFloat(sma15.toFixed(2)), tendencia: senal };

  fs.writeFileSync(CONFIG.weightsFile, JSON.stringify(STATE.pesos, null, 2));
  datos._lineage = STATE.lineage; datos._errores = STATE.errores; datos._confianza = calcConfianza();
  fs.writeFileSync(CONFIG.latestFile, JSON.stringify(datos, null, 2));
  await sendTelegramAlert();

  history = history.filter(h => h.fecha !== today);
  history.push({ fecha: today, canuelas: datos.canuelas, ceres: datos.ceres, apea: datos.apea, ganaderoIndex: datos.ganaderoIndex, senal: senal });
  if (history.length > CONFIG.historyMaxDays) history = history.slice(-CONFIG.historyMaxDays);
  fs.writeFileSync(CONFIG.historyFile, JSON.stringify(history, null, 2));
  fs.writeFileSync(`${DATA_DIR}/ganadero_${today}.json`, JSON.stringify(datos, null, 2));
  console.log(`[EXITO] Sistema Sellado y Normalizado. Modo: ${datos._modo}`);
}
main().catch(e => { console.error('[CRITICAL]', e); process.exit(1); });
