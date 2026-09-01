$ErrorActionPreference = "Stop"
Write-Host "main.js encoding duzeltmesi basliyor..." -ForegroundColor Cyan

$mainContent = @'
console.log("MAIN.JS CALISTI");
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");
const iconv = require("iconv-lite");
const Parser = require("rss-parser");
const parser = new Parser();

const logFilePath = path.join(__dirname, "app.log");

function logToFile(message) {
const timestamp = new Date().toLocaleString("tr-TR");
const logLine = `[${timestamp}] ${message}\n`;
console.log(logLine.trim());
fs.appendFileSync(logFilePath, logLine, "utf8");
}

function createWindow() {
logToFile("Uygulama baslatiliyor...");

const win = new BrowserWindow({
  width: 1200,
  height: 800,
  webPreferences: {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false
  }
});

win.loadFile("index.html");

win.webContents.on("did-finish-load", () => {
  logToFile("Pencere basariyla yuklendi.");
});

win.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
  logToFile(`Pencere yuklenemedi: ${errorCode} - ${errorDescription}`);
});
}

app.whenReady().then(() => {
logToFile("Electron hazir, pencere olusturuluyor...");
createWindow();
});

app.on("window-all-closed", () => {
logToFile("Tum pencereler kapatildi, uygulama sonlandiriliyor.");
if (process.platform !== "darwin") app.quit();
});

// ---------- Ham veri (buffer) cekme, redirect ve sikistirma destegi ----------
function fetchBuffer(urlStr, redirects) {
redirects = redirects || 0;
return new Promise((resolve, reject) => {
  if (redirects > 5) return reject(new Error("Cok fazla yonlendirme (redirect)"));

  let parsedUrl;
  try {
    parsedUrl = new URL(urlStr);
  } catch (e) {
    return reject(new Error("Gecersiz URL: " + urlStr));
  }

  const client = parsedUrl.protocol === "http:" ? http : https;
  const req = client.get(urlStr, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/rss+xml, application/xml, text/xml, */*"
    },
    timeout: 10000
  }, (res) => {
    if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
      res.resume();
      const nextUrl = new URL(res.headers.location, urlStr).toString();
      fetchBuffer(nextUrl, redirects + 1).then(resolve).catch(reject);
      return;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.resume();
      return reject(new Error("HTTP " + res.statusCode));
    }

    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const contentEncoding = (res.headers["content-encoding"] || "").toLowerCase();

      const finish = (buf) => resolve({ buffer: buf, headers: res.headers });

      try {
        if (contentEncoding.indexOf("br") !== -1) {
          zlib.brotliDecompress(buffer, (err, result) => {
            if (err) return reject(err);
            finish(result);
          });
        } else if (contentEncoding.indexOf("gzip") !== -1) {
          zlib.gunzip(buffer, (err, result) => {
            if (err) return reject(err);
            finish(result);
          });
        } else if (contentEncoding.indexOf("deflate") !== -1) {
          zlib.inflate(buffer, (err, result) => {
            if (err) return reject(err);
            finish(result);
          });
        } else {
          finish(buffer);
        }
      } catch (err) {
        reject(err);
      }
    });
  });

  req.on("timeout", () => {
    req.destroy(new Error("Istek zaman asimina ugradi (timeout)"));
  });
  req.on("error", reject);
});
}

function detectEncoding(buffer, headers) {
const contentType = (headers && headers["content-type"]) || "";
let match = contentType.match(/charset=([^;]+)/i);
if (match) return match[1].trim().toLowerCase();

const head = buffer.slice(0, 500).toString("latin1");
match = head.match(/encoding=["']([^"']+)["']/i);
if (match) return match[1].trim().toLowerCase();

return "utf-8";
}

function normalizeEncodingName(enc) {
const map = {
  "iso-8859-9": "win1254",
  "windows-1254": "win1254",
  "iso-8859-1": "win1252",
  "windows-1252": "win1252",
  "utf8": "utf-8",
  "utf-8": "utf-8"
};
return map[enc] || enc;
}

async function fetchAndParseRSS(url) {
const result = await fetchBuffer(url);
const buffer = result.buffer;
const headers = result.headers;
let encoding = normalizeEncodingName(detectEncoding(buffer, headers));

let xmlString;
try {
  if (encoding === "utf-8" || encoding === "utf8") {
    xmlString = buffer.toString("utf8");
  } else if (iconv.encodingExists(encoding)) {
    xmlString = iconv.decode(buffer, encoding);
  } else {
    xmlString = buffer.toString("utf8");
  }
} catch (e) {
  xmlString = buffer.toString("utf8");
}

return parser.parseString(xmlString);
}

// ---------- RSS kaynaklarindan haber cekme ----------
ipcMain.handle("fetch-rss", async (event, url) => {
const startTime = Date.now();
logToFile("RSS cekiliyor: " + url);

try {
  const feed = await fetchAndParseRSS(url);
  const duration = Date.now() - startTime;

  logToFile("BASARILI: " + url + " | " + feed.items.length + " haber bulundu | Sure: " + duration + "ms");

  return {
    success: true,
    items: feed.items.map((item) => ({
      title: item.title,
      link: item.link,
      pubDate: item.pubDate,
      contentSnippet: item.contentSnippet || ""
    }))
  };
} catch (error) {
  const duration = Date.now() - startTime;
  logToFile("HATA: " + url);
  logToFile("  Hata Mesaji: " + error.message);
  logToFile("  Sure: " + duration + "ms");

  return {
    success: false,
    error: error.message,
    code: error.code || "UNKNOWN"
  };
}
});
'@

Set-Content -Path ".\main.js" -Value $mainContent -Encoding UTF8
Write-Host "main.js guncellendi!" -ForegroundColor Green

$check = Select-String -Path ".\main.js" -Pattern "iconv-lite" -Quiet
if ($check) {
  Write-Host "DOGRULAMA BASARILI: main.js encoding duzeltmesini iceriyor." -ForegroundColor Green
} else {
  Write-Host "UYARI: Dogrulama basarisiz, dosyayi kontrol edin." -ForegroundColor Red
}

Write-Host "`nSimdi 'npm install iconv-lite' calistirdiginizdan emin olun, sonra 'npm start' ile uygulamayi baslatin." -ForegroundColor Yellow