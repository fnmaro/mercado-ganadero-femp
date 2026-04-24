# 🐄 MERCADO GANADERO FEMP v3.0

**100% AUTOMÁTICO | Framework de Exigencia Máxima Práctica**

---

## 📋 ¿Qué es esto?

Dashboard crítico de mercado ganadero argentino que se actualiza **automáticamente todos los días hábiles a las 9:00 AM (hora Argentina)**.

---

## 🚀 Instalación en 5 minutos

### Paso 1: Crear repositorio en GitHub
1. Andá a [github.com/new](https://github.com/new)
2. Nombre: `mercado-ganadero-femp`
3. **Público** (GitHub Pages gratis solo en público)
4. Crear repositorio

### Paso 2: Subir estos archivos (todos a la RAÍZ del repo)

Subí **todos** estos archivos arrastrándolos a GitHub web:

```
mercado-ganadero-femp/
├── .github/
│   └── workflows/
│       └── update-data.yml
├── data/
│   ├── latest.json
│   ├── history.json
│   └── seed.json
├── index.html
├── package.json
├── package-lock.json
├── scraper.js
└── README.md
```

**IMPORTANTE:** Los archivos deben quedar en la raíz, NO adentro de otra carpeta.

### Paso 3: Activar GitHub Pages
1. En tu repo, andá a **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: **main** / **/(root)**
4. Guardar
5. Tu URL será: `https://TU-USUARIO.github.io/mercado-ganadero-femp/`

### Paso 4: Activar GitHub Actions
1. Andá a **Actions** en tu repo
2. Habilitá workflows si te lo pide
3. El scraper corre automático de lunes a viernes a las 9:00 AM Argentina
4. Ejecutalo manual: **Actions → "Actualizar Datos Ganaderos FEMP" → Run workflow**

---

## 🤖 ¿Qué se automatiza?

| Bloque | Fuente | Automático |
|--------|--------|------------|
| 💱 Dólar | DolarAPI | ✅ 100% |
| 🌾 Granos | BCR Rosario / Agrofy | ✅ 100% |
| 🏛️ Cañuelas | MercadoAgroganadero.com.ar | ✅ 100% |
| 📊 APEA | APEA.org.ar | ✅ 100% |
| 🔨 Rosgan | RosganNet / Infocampo | ✅ 100% |
| 🌾 Tradición | Infocampo | ✅ 100% |
| 🏘️ Ceres | Infocampo | ✅ 100% |

---

## 📅 Feriados y fines de semana

- **Si es feriado o finde**: el scraper NO corre (detectado automático)
- **El dashboard muestra**: banner amarillo "Mercado cerrado"
- **Los datos**: son del **último día hábil** con fecha/hora del último dato real

---

## 🛡️ Modos de operación

| Modo | Significado |
|------|-------------|
| **AUTO** | Todo actualizado en tiempo real |
| **PARTIAL** | Algunas fuentes fallaron |
| **CACHE** | Mercado cerrado, último dato |
| **SEED** | Datos de respaldo |
| **FAIL** | Todas las fuentes fallaron |

---

## ⚠️ Kill Switch

Botón fijo en la esquina inferior derecha. Detiene TODO el dashboard.

---

## 🔍 Trazabilidad FEMP

Cada dato tiene: fuente, URL, timestamp, estado, confianza y hash SHA-256.
