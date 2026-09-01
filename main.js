console.log("MAIN.JS CALISTI");

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
if (process.platform === "win32") {
  app.setAppUserModelId("com.habertakip.app");
}

process.on("uncaughtException", (err) => {
  try {
    dialog.showErrorBox("Uygulama Baslatma Hatasi", String(err && err.stack ? err.stack : err));
  } catch (e) {}
  app.exit(1);
});

let https, http, zlib, URL, iconv, Parser, parser, cheerio;
try {
  https = require("https");
  http = require("http");
  zlib = require("zlib");
  URL = require("url").URL;
  iconv = require("iconv-lite");
 Parser = require("rss-parser");
parser = new Parser();
cheerio = require("cheerio");
} catch (err) {
  app.whenReady().then(() => {
    dialog.showErrorBox(
      "Modul Yukleme Hatasi",
      "Bir bagimlilik yuklenemedi:\n\n" + (err && err.stack ? err.stack : String(err))
    );
    app.exit(1);
  });
}

const userDataPath = app.getPath("userData");
console.log("=== USER DATA YOLU: " + userDataPath + " ===");
const logFilePath = path.join(userDataPath, "app.log");
const sourcesFilePath = path.join(userDataPath, "sources.json");

function logToFile(message) {
  try {
    const timestamp = new Date().toLocaleString("tr-TR");
    const logLine = `[${timestamp}] ${message}\n`;
    console.log(logLine.trim());
    fs.appendFileSync(logFilePath, logLine, "utf8");
  } catch (e) {}
}
// ==================== HABER TARIH ONBELLEGI ====================

const articleDateCacheFilePath = path.join(
  userDataPath,
  "article-date-cache.json"
);

// Tarihi bulunan kayıtlar 90 gün saklanır.
const ARTICLE_DATE_SUCCESS_TTL =
  90 * 24 * 60 * 60 * 1000;

// Tarihi bulunamayan bağlantılar 30 dakika tekrar sorgulanmaz.
const ARTICLE_DATE_FAILURE_TTL =
  30 * 60 * 1000;

// Aynı bağlantı için devam eden tarih sorgularını tutar.
const pendingArticleDateRequests = new Map();

let articleDateCache = {};
let articleDateCacheSaveTimer = null;

function loadArticleDateCache() {
  try {
    // Dosya yoksa ilk çalıştırmada boş olarak oluştur.
    if (!fs.existsSync(articleDateCacheFilePath)) {
      fs.writeFileSync(
        articleDateCacheFilePath,
        "{}",
        "utf8"
      );

      logToFile(
        "Tarih onbellek dosyasi olusturuldu: " +
        articleDateCacheFilePath
      );

      return {};
    }

    const rawContent = fs.readFileSync(
      articleDateCacheFilePath,
      "utf8"
    );

    if (!rawContent.trim()) {
      return {};
    }

    const parsedCache = JSON.parse(rawContent);

    if (
      parsedCache &&
      typeof parsedCache === "object" &&
      !Array.isArray(parsedCache)
    ) {
      return parsedCache;
    }

    return {};
  } catch (error) {
    logToFile(
      "Tarih onbellegi okunamadi: " +
      error.message
    );

    return {};
  }
}

function saveArticleDateCache() {
  try {
    const entries = Object.entries(articleDateCache);

    // Önbellek dosyasının sınırsız büyümesini engeller.
    if (entries.length > 5000) {
      entries.sort(
        (firstEntry, secondEntry) =>
          Number(secondEntry[1]?.checkedAt || 0) -
          Number(firstEntry[1]?.checkedAt || 0)
      );

      articleDateCache = Object.fromEntries(
        entries.slice(0, 5000)
      );
    }

    fs.writeFileSync(
      articleDateCacheFilePath,
      JSON.stringify(articleDateCache, null, 2),
      "utf8"
    );

  } catch (error) {
    logToFile(
      "Tarih onbellegi yazilamadi: " +
      error.message
    );
  }
}

function scheduleArticleDateCacheSave() {
  if (articleDateCacheSaveTimer) {
    clearTimeout(articleDateCacheSaveTimer);
  }

  articleDateCacheSaveTimer = setTimeout(() => {
    saveArticleDateCache();
    articleDateCacheSaveTimer = null;
  }, 300);
}

function normalizeArticleUrl(
  rawUrl,
  baseUrl = undefined
) {
  try {
    const parsedUrl = baseUrl
      ? new URL(rawUrl, baseUrl)
      : new URL(rawUrl);

    // Sayfa içi bağlantı bölümünü kaldır.
    parsedUrl.hash = "";

    const trackingParameters = [
      "fbclid",
      "gclid",
      "dclid",
      "msclkid",
      "ref",
      "referrer"
    ];

    for (const parameterName of Array.from(
      parsedUrl.searchParams.keys()
    )) {
      const lowerName =
        parameterName.toLowerCase();

      if (
        lowerName.startsWith("utm_") ||
        trackingParameters.includes(lowerName)
      ) {
        parsedUrl.searchParams.delete(parameterName);
      }
    }

    parsedUrl.hostname =
      parsedUrl.hostname.toLowerCase();

    if (
      (parsedUrl.protocol === "https:" &&
        parsedUrl.port === "443") ||
      (parsedUrl.protocol === "http:" &&
        parsedUrl.port === "80")
    ) {
      parsedUrl.port = "";
    }

    if (
      parsedUrl.pathname.length > 1 &&
      parsedUrl.pathname.endsWith("/")
    ) {
      parsedUrl.pathname =
        parsedUrl.pathname.replace(/\/+$/, "");
    }

    return parsedUrl.toString();
  } catch (error) {
    return String(rawUrl || "").trim();
  }
}

async function getCachedArticlePublishedDate(
  articleUrl,
  fetchDateFunction
) {
  const normalizedUrl =
    normalizeArticleUrl(articleUrl);

  if (!normalizedUrl) {
    return "";
  }

  const now = Date.now();
  const cachedEntry =
    articleDateCache[normalizedUrl];

  if (cachedEntry) {
    const cacheAge =
      now - Number(cachedEntry.checkedAt || 0);

    const cacheTTL = cachedEntry.date
      ? ARTICLE_DATE_SUCCESS_TTL
      : ARTICLE_DATE_FAILURE_TTL;

    if (cacheAge >= 0 && cacheAge < cacheTTL) {
      logToFile(
        "TARIH ONBELLEKTEN: " +
        normalizedUrl
      );

      return String(cachedEntry.date || "");
    }
  }

  // Aynı bağlantı zaten sorgulanıyorsa mevcut işlemi kullan.
  if (
    pendingArticleDateRequests.has(normalizedUrl)
  ) {
    return pendingArticleDateRequests.get(
      normalizedUrl
    );
  }

  const requestPromise = (async () => {
    try {
      const dateValue = String(
        (await fetchDateFunction(normalizedUrl)) || ""
      );

      articleDateCache[normalizedUrl] = {
        date: dateValue,
        checkedAt: Date.now()
      };

      scheduleArticleDateCacheSave();

      return dateValue;
    } catch (error) {
      articleDateCache[normalizedUrl] = {
        date: "",
        checkedAt: Date.now()
      };

      scheduleArticleDateCacheSave();

      logToFile(
        "Tarih onbellek sorgu hatasi: " +
        normalizedUrl +
        " | " +
        error.message
      );

      return "";
    } finally {
      pendingArticleDateRequests.delete(
        normalizedUrl
      );
    }
  })();

  pendingArticleDateRequests.set(
    normalizedUrl,
    requestPromise
  );

  return requestPromise;
}

// Program başlatılırken önbelleği yükle.
// Dosya yoksa boş önbellek dosyasını hemen oluşturur.
articleDateCache = loadArticleDateCache();

logToFile(
  "TARIH ONBELLEK DOSYASI: " +
  articleDateCacheFilePath
);

let mainWindow = null;
let tray = null;
let isQuitting = false;
let autoRefreshInterval = null;

function createWindow() {
  logToFile("Pencere baslatiliyor...");

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile("index.html");

  mainWindow.webContents.on("did-finish-load", () => {
    logToFile("Pencere basariyla yuklendi.");
  });

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    logToFile(`Pencere yuklenemedi: ${errorCode} - ${errorDescription}`);
  });

  // OZELLIK 7: Kapat butonuna basinca gizle (tepsiye kucult)
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      logToFile("Pencere sistem tepsisine kucultuldu.");
    }
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, "assets", "icon.ico");
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      { label: "Goster", click: () => mainWindow.show() },
      {
        label: "Simdi Yenile",
        click: () => {
          mainWindow.show();
          mainWindow.webContents.send("tray-refresh");
        }
      },
      { type: "separator" },
      {
        label: "Cikis",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip("Haber Takip");
    tray.setContextMenu(contextMenu);

    tray.on("click", () => {
      if (mainWindow.isVisible()) mainWindow.hide();
      else mainWindow.show();
    });

    logToFile("Sistem tepsisi olusturuldu.");
  } catch (err) {
    logToFile("Sistem tepsisi olusturulamadi: " + err.message);
  }
}

app.whenReady().then(() => {
  logToFile("Electron hazir, pencere olusturuluyor...");
  createWindow();
  createTray();
  startBackgroundTracking();   // ✅ YENİ: Arka plan takibi artık main process'te, pencereden bağımsız

  // ==================== AUTO-UPDATE LOGLAMA ====================
  const log = require("electron-log");
  log.transports.file.level = "info";
  log.transports.file.resolvePathFn = () => path.join(userDataPath, "update.log");
  autoUpdater.logger = log;

  logToFile("Auto-updater baslatiliyor, mevcut versiyon: " + app.getVersion());

  autoUpdater.on("checking-for-update", () => {
    logToFile("Guncelleme kontrol ediliyor...");
  });

  autoUpdater.on("update-available", (info) => {
    logToFile("YENI GUNCELLEME BULUNDU: " + info.version);
  });

  autoUpdater.on("update-not-available", (info) => {
    logToFile("Guncelleme yok. Mevcut surum en son surum: " + info.version);
  });

  autoUpdater.on("error", (err) => {
    logToFile("AUTO-UPDATER HATASI: " + (err && err.stack ? err.stack : String(err)));
  });

  autoUpdater.on("download-progress", (progress) => {
    logToFile("Indiriliyor: %" + Math.round(progress.percent));
  });

  autoUpdater.on("update-downloaded", (info) => {
    logToFile("Guncelleme indirildi: " + info.version + " - Yeniden baslatilacak.");
  });

  // Otomatik güncelleme kontrolü
  autoUpdater.checkForUpdatesAndNotify();
  // ================================================================

});


app.on("before-quit", () => {
  isQuitting = true;
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
});

app.on("window-all-closed", () => {
  logToFile("Tum pencereler kapatildi.");
  if (process.platform !== "darwin") app.quit();
});

// --- Ham veri (buffer) cekme, redirect ve sikistirma destegi ---
function fetchBuffer(urlStr, redirects, customHeaders) {
  redirects = redirects || 0;
  customHeaders = customHeaders || {};
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Cok fazla yonlendirme (redirect)"));

    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
    } catch (e) {
      return reject(new Error("Gecersiz URL: " + urlStr));
    }

    const defaultHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/rss+xml, application/xml, text/xml, */*",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7"
    };

    const finalHeaders = Object.assign({}, defaultHeaders, customHeaders);

    const client = parsedUrl.protocol === "http:" ? http : https;
    const req = client.get(urlStr, {
      headers: finalHeaders,
      timeout: 10000
    }, (res) => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, urlStr).toString();
        fetchBuffer(nextUrl, redirects + 1, customHeaders).then(resolve).catch(reject);
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
            zlib.brotliDecompress(buffer, (err, result) => err ? reject(err) : finish(result));
          } else if (contentEncoding.indexOf("gzip") !== -1) {
            zlib.gunzip(buffer, (err, result) => err ? reject(err) : finish(result));
          } else if (contentEncoding.indexOf("deflate") !== -1) {
            zlib.inflate(buffer, (err, result) => err ? reject(err) : finish(result));
          } else {
            finish(buffer);
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("timeout", () => req.destroy(new Error("Istek zaman asimina ugradi (timeout)")));
    req.on("error", reject);
  });
}


function detectEncoding(buffer, headers) {
  const contentType = (headers && headers["content-type"]) || "";
  let match = contentType.match(/charset=([^;]+)/i);
  if (match) return match[1].trim().toLowerCase();

  const head = buffer.slice(0, 500).toString("latin1");
  match = head.match(/encoding=['"]([^'"]+)['"]/i);
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
// --- RSS bulunmayan sitelerden HTML yoluyla haber çekme ---
async function fetchAndParseHTML(source) {
  if (!source || !source.url) {
    throw new Error("HTML kaynağının adresi bulunamadı.");
  }

  if (!cheerio) {
    throw new Error("Cheerio modülü yüklenemedi.");
  }

  const result = await fetchBuffer(source.url, 0, {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Referer": "https://www.google.com/",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document"
});
  const buffer = result.buffer;
  const headers = result.headers;

  let encoding = normalizeEncodingName(
    detectEncoding(buffer, headers)
  );

  let htmlString;

  try {
    if (iconv.encodingExists(encoding)) {
      htmlString = iconv.decode(buffer, encoding);
    } else {
      htmlString = buffer.toString("utf8");
    }
  } catch (error) {
    htmlString = buffer.toString("utf8");
  }

  const $ = cheerio.load(htmlString);
  const selectors = source.selectors || {};
  const items = [];

  // Siteye özel seçici verilmemişse genel haber seçicilerini kullanır.
  const itemSelector =
    selectors.item ||
    "article, .news-item, .news-card, .haber-item, .haber-karti, .story";

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findElement(root, selector, fallbackSelector) {
    const finalSelector = selector || fallbackSelector;

    if (!finalSelector) {
      return root;
    }

    if (root.is(finalSelector)) {
      return root;
    }

    return root.find(finalSelector).first();
  }

  $(itemSelector).each((index, element) => {
    const root = $(element);

    const titleElement = findElement(
      root,
      selectors.title,
      "h1 a, h2 a, h3 a, h4 a, .title a, .haber-baslik a"
    );

    const linkElement = findElement(
      root,
      selectors.link,
      "h1 a, h2 a, h3 a, h4 a, .title a, .haber-baslik a, a"
    );

    const descriptionElement = findElement(
      root,
      selectors.description,
      "p, .description, .summary, .spot, .news-spot, .haber-ozet"
    );

    const dateElement = findElement(
      root,
      selectors.date,
      "time, .date, .news-date, .publish-date, .tarih"
    );

    const title =
      cleanText(titleElement.attr("title")) ||
      cleanText(titleElement.text()) ||
      cleanText(linkElement.attr("title")) ||
      cleanText(linkElement.text());

    const rawLink =
      linkElement.attr("href") ||
      titleElement.attr("href") ||
      "";

    if (!title || !rawLink) {
      return;
    }

    let absoluteLink;

    try {
      absoluteLink = new URL(rawLink, source.url).toString();
    } catch (error) {
      return;
    }

    // JavaScript bağlantılarını haber olarak kabul etme.
    if (
      absoluteLink.startsWith("javascript:") ||
      absoluteLink.startsWith("mailto:")
    ) {
      return;
    }

    const description = cleanText(descriptionElement.text());

    // Tarihi önce seçilen HTML öğesinden al.
    let pubDate =
      cleanText(dateElement.attr("datetime")) ||
      cleanText(dateElement.attr("content")) ||
      cleanText(dateElement.attr("data-date")) ||
      cleanText(dateElement.text()) ||
      "";

    // Seçici sonuç vermediyse kart içindeki genel tarih öğelerini ara.
    if (!pubDate) {
      const fallbackDateElement = root
        .find("time, .date, .news-date, .publish-date, .tarih")
        .first();

      pubDate =
        cleanText(fallbackDateElement.attr("datetime")) ||
        cleanText(fallbackDateElement.attr("content")) ||
        cleanText(fallbackDateElement.attr("data-date")) ||
        cleanText(fallbackDateElement.text()) ||
        "";
    }

    // Motor1 gibi "Aug 23" biçiminde yıl içermeyen tarihleri düzelt.
    const dateSearchText = pubDate || cleanText(root.text());

    const englishDateMatch = dateSearchText.match(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i
    );

    if (englishDateMatch) {
      const months = {
        jan: 1,
        january: 1,
        feb: 2,
        february: 2,
        mar: 3,
        march: 3,
        apr: 4,
        april: 4,
        may: 5,
        jun: 6,
        june: 6,
        jul: 7,
        july: 7,
        aug: 8,
        august: 8,
        sep: 9,
        sept: 9,
        september: 9,
        oct: 10,
        october: 10,
        nov: 11,
        november: 11,
        dec: 12,
        december: 12
      };

      const monthName = englishDateMatch[1]
        .toLowerCase()
        .replace(".", "");

      const month = months[monthName];
      const day = Number(englishDateMatch[2]);
      const explicitYear = englishDateMatch[3];

      let year = explicitYear
        ? Number(explicitYear)
        : new Date().getFullYear();

      // Yıl yoksa ve tarih gelecekte görünüyorsa önceki yılı kullan.
      if (!explicitYear) {
        const candidateDate = new Date(year, month - 1, day);
        const sevenDaysLater =
          Date.now() + (7 * 24 * 60 * 60 * 1000);

        if (candidateDate.getTime() > sevenDaysLater) {
          year -= 1;
        }
      }

      pubDate =
        `${year}-` +
        `${String(month).padStart(2, "0")}-` +
        `${String(day).padStart(2, "0")}` +
        "T00:00:00+03:00";
    }

    items.push({
      title,
      link: absoluteLink,
      pubDate,
      description,
      source: source.name || source.url
    });
  });


  // JSON-LD yapısı içinde datePublished değerini özyinelemeli olarak ara.
  function findDatePublished(value) {
    if (!value) {
      return "";
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const foundDate = findDatePublished(entry);

        if (foundDate) {
          return foundDate;
        }
      }

      return "";
    }

    if (typeof value === "object") {
      if (
        typeof value.datePublished === "string" &&
        value.datePublished.trim()
      ) {
        return value.datePublished.trim();
      }

      for (const nestedValue of Object.values(value)) {
        const foundDate = findDatePublished(nestedValue);

        if (foundDate) {
          return foundDate;
        }
      }
    }

    return "";
  }

  // Haber ayrıntı sayfasındaki meta veya JSON-LD yayın tarihini getir.
  async function fetchArticlePublishedDate(articleUrl) {
    try {
      const detailResult = await fetchBuffer(articleUrl);
      const detailBuffer = detailResult.buffer;
      const detailHeaders = detailResult.headers;

      const detailEncoding = normalizeEncodingName(
        detectEncoding(detailBuffer, detailHeaders)
      );

      let detailHTML;

      try {
        detailHTML = iconv.encodingExists(detailEncoding)
          ? iconv.decode(detailBuffer, detailEncoding)
          : detailBuffer.toString("utf8");
      } catch (error) {
        detailHTML = detailBuffer.toString("utf8");
      }

      const detailPage = cheerio.load(detailHTML);

      const directDateSelectors = [
        'meta[property="article:published_time"]',
        'meta[name="article:published_time"]',
        'meta[itemprop="datePublished"]',
        'meta[name="datePublished"]',
        'meta[name="date"]',
        'time[itemprop="datePublished"]'
      ];

      for (const selector of directDateSelectors) {
        const element = detailPage(selector).first();

        const dateValue =
          cleanText(element.attr("content")) ||
          cleanText(element.attr("datetime")) ||
          cleanText(element.text());

        if (dateValue && !Number.isNaN(Date.parse(dateValue))) {
          return dateValue;
        }
      }

      const jsonLdElements = detailPage(
        'script[type="application/ld+json"]'
      ).toArray();

      for (const jsonLdElement of jsonLdElements) {
        const jsonText = detailPage(jsonLdElement).html();

        if (!jsonText || !jsonText.trim()) {
          continue;
        }

        try {
          const jsonData = JSON.parse(jsonText.trim());
          const jsonDate = findDatePublished(jsonData);

          if (jsonDate && !Number.isNaN(Date.parse(jsonDate))) {
            return jsonDate;
          }
        } catch (error) {
          // Geçersiz JSON-LD bloklarını atla.
        }
      }
    } catch (error) {
      logToFile(
        "HTML DETAY TARIH HATASI: " +
        articleUrl +
        " | " +
        error.message
      );
    }

    return "";
  }

   // Bağlantıları normalize ederek yinelenen haberleri temizle.
  const uniqueItemMap = new Map();

  for (const item of items) {
    const normalizedLink = normalizeArticleUrl(
      item.link,
      source.url
    );

    if (!normalizedLink) {
      continue;
    }

    item.link = normalizedLink;

    const existingItem = uniqueItemMap.get(normalizedLink);

    if (!existingItem) {
      uniqueItemMap.set(normalizedLink, item);
      continue;
    }

    // Yinelenen iki kayıttan daha dolu olan alanları koru.
    if (!existingItem.title && item.title) {
      existingItem.title = item.title;
    }

    if (!existingItem.description && item.description) {
      existingItem.description = item.description;
    }

    if (!existingItem.pubDate && item.pubDate) {
      existingItem.pubDate = item.pubDate;
    }
  }

  const uniqueItems = Array.from(uniqueItemMap.values());

  // Liste kartında tarihi olmayan bütün HTML haberlerinde
  // ayrıntı sayfasından tarih getir.
  const itemsWithoutDate = uniqueItems.filter(
    item => !item.pubDate && item.link
  );

  // Siteye aşırı eş zamanlı istek göndermemek için
  // detay sayfalarını beşerli gruplar halinde işle.
  const DETAIL_REQUEST_CONCURRENCY = 5;

  for (
    let index = 0;
    index < itemsWithoutDate.length;
    index += DETAIL_REQUEST_CONCURRENCY
  ) {
    const batch = itemsWithoutDate.slice(
      index,
      index + DETAIL_REQUEST_CONCURRENCY
    );

    await Promise.all(
      batch.map(async item => {
        const detailDate =
          await getCachedArticlePublishedDate(
            item.link,
            fetchArticlePublishedDate
          );

        if (detailDate) {
          item.pubDate = detailDate;

          logToFile(
            "HTML DETAY TARIHI: " +
            (source.name || source.url) +
            " | " +
            detailDate +
            " | " +
            item.link
          );
        }
      })
    );
  }

// ============================================================
// BOLUM 1
// Şu satırların HEMEN ALTINA ekleyin:
//
//   articleDateCache = loadArticleDateCache();
//   logToFile("TARIH ONBELLEK DOSYASI: " + articleDateCacheFilePath);
/// ==================== HABER OZET (SPOT) ONBELLEGI ====================

const articleDescriptionCacheFilePath = path.join(
  userDataPath,
  "article-description-cache.json"
);

// Özeti bulunan kayıtlar 90 gün saklanır.
const ARTICLE_DESCRIPTION_SUCCESS_TTL = 90 * 24 * 60 * 60 * 1000;

// Özeti bulunamayan başarısızlıklar 30 dakika sonra tekrar sorgulanmaz.
const ARTICLE_DESCRIPTION_FAILURE_TTL = 30 * 60 * 1000;

// Aynı bağlantı için devam eden istek varsa tekrar tetiklenmez.
const pendingArticleDescriptionRequests = new Map();

let articleDescriptionCache = {};
let articleDescriptionCacheSaveTimer = null;

function loadArticleDescriptionCache() {
  try {
    if (!fs.existsSync(articleDescriptionCacheFilePath)) {
      fs.writeFileSync(articleDescriptionCacheFilePath, "{}", "utf8");

      logToFile(
        "Ozet onbellek dosyasi olusturuldu: " +
        articleDescriptionCacheFilePath
      );
      return {};
    }

    const rawContent = fs.readFileSync(
      articleDescriptionCacheFilePath,
      "utf8"
    );

    if (!rawContent.trim()) {
      return {};
    }

    const parsedCache = JSON.parse(rawContent);

    if (
      parsedCache &&
      typeof parsedCache === "object" &&
      !Array.isArray(parsedCache)
    ) {
      return parsedCache;
    }

    return {};
  } catch (error) {
    logToFile("Ozet onbellegi okunamadi: " + error.message);
    return {};
  }
}

function saveArticleDescriptionCache() {
  try {
    const entries = Object.entries(articleDescriptionCache);

    // Önbellek dosyasının sınırsız büyümesini engeller.
    if (entries.length > 5000) {
      entries.sort(
        (firstEntry, secondEntry) =>
          Number(secondEntry[1]?.checkedAt || 0) -
          Number(firstEntry[1]?.checkedAt || 0)
      );

      articleDescriptionCache = Object.fromEntries(entries.slice(0, 5000));
    }

    fs.writeFileSync(
      articleDescriptionCacheFilePath,
      JSON.stringify(articleDescriptionCache, null, 2),
      "utf8"
    );
  } catch (error) {
    logToFile("Ozet onbellegi yazilamadi: " + error.message);
  }
}

function scheduleArticleDescriptionCacheSave() {
  if (articleDescriptionCacheSaveTimer) {
    clearTimeout(articleDescriptionCacheSaveTimer);
  }

  articleDescriptionCacheSaveTimer = setTimeout(() => {
    saveArticleDescriptionCache();
    articleDescriptionCacheSaveTimer = null;
  }, 300);
}

// Önbellekten kontrol ederek, gerekirse detay sayfasından özet getirir.
async function getCachedArticleDescription(
  articleUrl,
  fetchDescriptionFunction
) {
  const normalizedLink = normalizeArticleUrl(articleUrl);

  if (!normalizedLink) {
    return "";
  }

  const cachedEntry = articleDescriptionCache[normalizedLink];
  const now = Date.now();

  if (cachedEntry) {
    const ttl = cachedEntry.description
      ? ARTICLE_DESCRIPTION_SUCCESS_TTL
      : ARTICLE_DESCRIPTION_FAILURE_TTL;

    if (now - Number(cachedEntry.checkedAt || 0) < ttl) {
      return cachedEntry.description || "";
    }
  }

  // Aynı bağlantı için zaten devam eden bir istek varsa onu bekle.
  if (pendingArticleDescriptionRequests.has(normalizedLink)) {
    return pendingArticleDescriptionRequests.get(normalizedLink);
  }

  const fetchPromise = (async () => {
    let description = "";

    try {
      description = await fetchDescriptionFunction(articleUrl);
    } catch (error) {
      logToFile(
        "OZET CEKME HATASI: " + articleUrl + " | " + error.message
      );
    }

    articleDescriptionCache[normalizedLink] = {
      description: description || "",
      checkedAt: Date.now()
    };

    scheduleArticleDescriptionCacheSave();
    pendingArticleDescriptionRequests.delete(normalizedLink);

    return description || "";
  })();

  pendingArticleDescriptionRequests.set(normalizedLink, fetchPromise);

  return fetchPromise;
}

// Program başlatılırken önbelleği yükle.
articleDescriptionCache = loadArticleDescriptionCache();

logToFile(
  "OZET ONBELLEK DOSYASI: " + articleDescriptionCacheFilePath
);


// ============================================================
// BOLUM 2
// fetchAndParseHTML fonksiyonu İÇİNDE, şu bloğun HEMEN ALTINA
// ekleyin (itemsWithoutDate döngüsü bittikten sonra,
// "return { title: ..., items: uniqueItems };" satırından ÖNCE):
// ============================================================

// Haber ayrıntı sayfasındaki kısa özet (spot) metnini getir.
async function fetchArticleDescription(articleUrl) {
  try {
    const detailResult = await fetchBuffer(articleUrl);
    const detailBuffer = detailResult.buffer;
    const detailHeaders = detailResult.headers;

    const detailEncoding = normalizeEncodingName(
      detectEncoding(detailBuffer, detailHeaders)
    );

    let detailHTML;

    try {
      detailHTML = iconv.encodingExists(detailEncoding)
        ? iconv.decode(detailBuffer, detailEncoding)
        : detailBuffer.toString("utf8");
    } catch (error) {
      detailHTML = detailBuffer.toString("utf8");
    }

    const detailPage = cheerio.load(detailHTML);

    // 1) Önce meta açıklama etiketlerini dene.
    const metaSelectors = [
      'meta[property="og:description"]',
      'meta[name="description"]',
      'meta[name="twitter:description"]'
    ];

    for (const selector of metaSelectors) {
      const content = cleanText(
        detailPage(selector).first().attr("content")
      );

      if (content && content.length > 15) {
        return content;
      }
    }

    // 2) H1 başlığını takip eden H2 (spot) metnini dene.
    const h1FollowingH2 = cleanText(
      detailPage("h1").first().nextAll("h2").first().text()
    );

    if (h1FollowingH2 && h1FollowingH2.length > 15) {
      return h1FollowingH2;
    }

    // 3) Sık kullanılan spot/özet class'larını dene.
    const spotSelectors = [
      ".spot",
      ".ozet",
      ".summary",
      ".haber-spot",
      ".haber-ozet",
      ".article-summary",
      ".news-spot"
    ];

    for (const selector of spotSelectors) {
      const spotText = cleanText(detailPage(selector).first().text());

      if (spotText && spotText.length > 15) {
        return spotText;
      }
    }

    // 4) Hiçbiri bulunamazsa ilk anlamlı paragrafı dene.
    const firstParagraph = cleanText(
      detailPage("article p, .content p, .haber-detay p").first().text()
    );

    if (firstParagraph && firstParagraph.length > 15) {
      return firstParagraph;
    }
  } catch (error) {
    logToFile(
      "HTML DETAY OZET HATASI: " + articleUrl + " | " + error.message
    );
  }

  return "";
}

// Liste kartında özet (spot) metni olmayan HTML haberlerinde
// ayrıntı sayfasından özet getir. (Aşamalı + önbellekli + canlı UI güncelleme)
const itemsWithoutDescription = uniqueItems.filter(
  item => !item.description && item.link
);

for (
  let index = 0;
  index < itemsWithoutDescription.length;
  index += DETAIL_REQUEST_CONCURRENCY
) {
  const batch = itemsWithoutDescription.slice(
    index,
    index + DETAIL_REQUEST_CONCURRENCY
  );

  await Promise.all(
    batch.map(async item => {
      const detailDescription = await getCachedArticleDescription(
        item.link,
        fetchArticleDescription
      );

      if (detailDescription) {
        item.description = detailDescription;

        logToFile(
          "HTML DETAY OZETI: " +
          (source.name || source.url) +
          " | " +
          item.link
        );

        // Arayüze anlık güncelleme gönder (asenkron akış).
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("description-updated", {
            link: item.link,
            description: detailDescription
          });
        }
      }
    })
  );
}
  return {
    title: source.name || source.url,
    items: uniqueItems
  };
}

// --- RSS kaynagindan haber cekme ---
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
  description: item.contentSnippet || item.summary || item.content || "",
  source: feed.title || url
}))
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    logToFile("HATA: " + url + " | " + error.message + " | Sure: " + duration + "ms");
    return { success: false, error: error.message, items: [] };
  }
});
// RSS ve normal HTML kaynaklarını ortak kanaldan çalıştırır.
ipcMain.handle("fetch-source", async (event, source) => {
  if (!source || typeof source !== "object") {
    throw new Error("Geçerli bir kaynak bilgisi gönderilmedi.");
  }

  if (!source.url) {
    throw new Error("Kaynak adresi bulunamadı.");
  }

  const sourceType = String(source.type || "rss").toLowerCase();

  if (
    sourceType === "html" ||
    sourceType === "web" ||
    sourceType === "website" ||
    sourceType === "site"
  ) {
    return await fetchAndParseHTML(source);
  }

  return await fetchAndParseRSS(source.url);
});

// --- Kaynak yonetimi (DIZI yapisi) ---
function readSources() {
  try {
    if (!fs.existsSync(sourcesFilePath)) {
      fs.writeFileSync(sourcesFilePath, JSON.stringify([], null, 2), "utf8");
      return [];
    }
    const raw = fs.readFileSync(sourcesFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logToFile("Kaynaklar okunamadi: " + e.message);
    return [];
  }
}

function writeSources(data) {
  try {
    fs.writeFileSync(sourcesFilePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) {
    logToFile("Kaynaklar yazilamadi: " + e.message);
    return false;
  }
}

function ensureProtocol(url) {
  if (!/^https?:\/\//i.test(url)) return "https://" + url;
  return url;
}

function getFaviconUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return "https://www.google.com/s2/favicons?domain=" + hostname + "&sz=64";
  } catch (e) {
    return "";
  }
}

ipcMain.handle("get-sources", async () => {
  return readSources();
});

ipcMain.handle("add-source", async (event, { category, name, url }) => {
  const sources = readSources();
  const fixedUrl = ensureProtocol(url);
  const newSource = {
    id: "src_" + Date.now(),
    name,
    url: fixedUrl,
    logo: getFaviconUrl(fixedUrl),
    category
  };
  sources.push(newSource);

  const ok = writeSources(sources);
  if (!ok) {
    logToFile(`HATA: Kaynak eklenemedi (disk yazma başarısız): [${category}] ${name}`);
    return { success: false, error: "Kaynak dosyaya yazılamadı. app.log dosyasını kontrol edin.", sources: readSources() };
  }

  logToFile(`Kaynak eklendi: [${category}] ${name} -> ${fixedUrl}`);
  return { success: true, sources };
});

ipcMain.handle("remove-source", async (event, { id }) => {
  let sources = readSources();
  sources = sources.filter((s) => s.id !== id);

  const ok = writeSources(sources);
  if (!ok) {
    logToFile(`HATA: Kaynak silinemedi (disk yazma başarısız): ${id}`);
    return { success: false, error: "Silme işlemi diske yazılamadı. app.log dosyasını kontrol edin.", sources: readSources() };
  }

  logToFile(`Kaynak silindi: ${id}`);
  return { success: true, sources };
});

ipcMain.handle("update-source", async (event, { id, name, url, category }) => {
  const sources = readSources();
  const fixedUrl = ensureProtocol(url);
  const idx = sources.findIndex((s) => s.id === id);
  if (idx !== -1) {
    sources[idx] = { ...sources[idx], name, url: fixedUrl, category };
  }
  writeSources(sources);
  logToFile(`Kaynak guncellendi: ${id} -> ${fixedUrl}`);
  return { success: true, sources };
});

// --- OZELLIK 3: Bildirim gosterme ---
ipcMain.handle("show-notification", async (event, { title, body }) => {
  try {
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: title || "Haber Takip",
        body: body || "",
        icon: path.join(__dirname, "assets", "icon.ico")
      });
      notif.on("click", () => {
        mainWindow.show();
      });
      notif.show();
    }
    return { success: true };
  } catch (e) {
    logToFile("Bildirim hatasi: " + e.message);
    return { success: false, error: e.message };
  }
});

// --- OZELLIK 6: Haberleri disa aktarma ---
ipcMain.handle("export-news", async (event, { format, data }) => {
  try {
    const ext = format === "json" ? "json" : "txt";
    const defaultName = `haberler_${Date.now()}.${ext}`;

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Haberleri Disa Aktar",
      defaultPath: defaultName,
      filters: [
        format === "json"
          ? { name: "JSON Dosyasi", extensions: ["json"] }
          : { name: "Metin Dosyasi", extensions: ["txt"] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    let content;
    if (format === "json") {
      content = JSON.stringify(data, null, 2);
    } else {
      content = data
        .map((item) => `${item.title}\n${item.link}\n${item.pubDate || ""}\n${"-".repeat(40)}`)
        .join("\n\n");
    }

    fs.writeFileSync(result.filePath, content, "utf8");
    logToFile("Haberler disa aktarildi: " + result.filePath);
    return { success: true, filePath: result.filePath };
  } catch (e) {
    logToFile("Disa aktarma hatasi: " + e.message);
    return { success: false, error: e.message };
  }
});
// ==================== ARKA PLAN HABER TAKİP SİSTEMİ (KALICI ÇÖZÜM) ====================
const trackedFilePath = path.join(userDataPath, "tracked.json");

function readTracked() {
  try {
    if (!fs.existsSync(trackedFilePath)) {
      const initial = { keywords: [], seenLinks: [] };
      fs.writeFileSync(trackedFilePath, JSON.stringify(initial, null, 2), "utf8");
      return initial;
    }
    const raw = fs.readFileSync(trackedFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      seenLinks: Array.isArray(parsed.seenLinks) ? parsed.seenLinks : []
    };
  } catch (e) {
    logToFile("Tracked dosyasi okunamadi: " + e.message);
    return { keywords: [], seenLinks: [] };
  }
}

function writeTracked(data) {
  try {
    fs.writeFileSync(trackedFilePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) {
    logToFile("Tracked dosyasi yazilamadi: " + e.message);
    return false;
  }
}

// Renderer'dan gelen kelime listesini dosyaya senkronize et
ipcMain.handle("sync-tracked-keywords", async (event, { keywords, seenLinks }) => {
  const current = readTracked();
  const data = {
    keywords: Array.isArray(keywords) ? keywords : current.keywords,
    seenLinks: Array.isArray(seenLinks) ? seenLinks : current.seenLinks
  };
  writeTracked(data);
  return { success: true };
});

let backgroundTrackTimer = null;
let isFirstBackgroundCheck = true;
const BG_TRACK_CHECK_MS = 5 * 60 * 1000; // 5 dakika

async function checkKeywordsInBackground(silent) {
  const tracked = readTracked();
  if (!tracked.keywords || tracked.keywords.length === 0) return;

  const sources = readSources();
  if (!sources || sources.length === 0) return;

  const newMatches = [];

  for (const src of sources) {
    try {
      const feed = await fetchAndParseRSS(ensureProtocol(src.url));
      if (!feed || !feed.items) continue;

      feed.items.forEach((item) => {
       const titleLower = (item.title || "").toLocaleLowerCase('tr-TR');

function isWholeWordMatch(text, keyword) {
  const kw = keyword.toLocaleLowerCase('tr-TR').trim();
  if (!kw) return false;
  // Türkçe karakterleri de içeren kelime sınırı kontrolü
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^|[^a-zçğıöşü0-9])${escaped}([^a-zçğıöşü0-9]|$)`, 'i');
  return regex.test(text);
}

const matchedKeyword = tracked.keywords.find((kw) => isWholeWordMatch(titleLower, kw));

        if (!matchedKeyword) return;
        if (tracked.seenLinks.includes(item.link)) return;

        tracked.seenLinks.push(item.link);
        newMatches.push({
          title: item.title,
          link: item.link,
          sourceName: src.name,
          matchedKeyword
        });
      });
    } catch (e) {
      logToFile("Arka plan tarama hatasi (" + src.url + "): " + e.message);
    }
  }

  if (tracked.seenLinks.length > 2000) tracked.seenLinks = tracked.seenLinks.slice(-2000);
  writeTracked(tracked);

  if (!silent && newMatches.length > 0) {
    newMatches.forEach((m, index) => {
      setTimeout(() => {
        try {
          const notif = new Notification({
            title: `🔔 "${m.matchedKeyword}" eslesmesi: ${m.sourceName}`,
            body: m.title,
            icon: path.join(__dirname, "assets", "icon.ico")
          });
          notif.on("click", () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.webContents.send("tray-refresh");
            }
          });
          notif.show();
        } catch (e) {
          logToFile("Bildirim gosterme hatasi: " + e.message);
        }
      }, index * 1500); // Her bildirim 1.5 saniye arayla -> karismayi engeller
    });
    logToFile(`Arka plan taramasi: ${newMatches.length} yeni eslesen haber bulundu.`);
  } else {
    logToFile(`Arka plan taramasi calisti. Eslesen yeni haber: ${newMatches.length}`);
  }
}

function startBackgroundTracking() {
  if (backgroundTrackTimer) clearInterval(backgroundTrackTimer);
  checkKeywordsInBackground(isFirstBackgroundCheck).then(() => {
    isFirstBackgroundCheck = false;
  });
  backgroundTrackTimer = setInterval(() => {
    checkKeywordsInBackground(false);
  }, BG_TRACK_CHECK_MS);
}
