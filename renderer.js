// ==================== renderer.js ====================
// Haber Takip Uygulamasi - Duzeltilmis ve Tam Surum
// ==================== renderer.js ====================
// Haber Takip Uygulamasi - Duzeltilmis ve Tam Surum

const CATEGORY_COLORS = {
  "Gündem": "#f97316",
  "Spor": "#22c55e",
  "Ekonomi": "#3b82f6",
  "Dünya": "#a855f7",
  "Teknoloji": "#06b6d4",
  "Magazin": "#ec4899",
  "Sağlık": "#ef4444",
  "Politika": "#6b7280",
  "Genel": "#94a3b8"
};

const autoColorCache = {};
const AUTO_COLOR_PALETTE = [
  "#eab308", "#14b8a6", "#8b5cf6", "#f43f5e",
  "#0ea5e9", "#84cc16", "#d946ef", "#f59e0b"
];

function getCategoryColor(category) {
  const name = category || "Genel";
  if (CATEGORY_COLORS[name]) {
    return CATEGORY_COLORS[name];
  }
  if (autoColorCache[name]) {
    return autoColorCache[name];
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % AUTO_COLOR_PALETTE.length;
  }
  const color = AUTO_COLOR_PALETTE[Math.abs(hash) % AUTO_COLOR_PALETTE.length];
  autoColorCache[name] = color;
  return color;
}

function initApp() {
  // ==================== DURUM (STATE) ====================
  let sourcesData = [];              // { id, name, url, category, logo }
  let allNewsItems = [];             // yuklenmis tum haberler (mevcut sekme icin)
  let currentCategory = null;        // secili kategori ("__all__", "__favorites__", "__tracking__" veya kategori adi)
  let favorites = loadJSON("favorites", []);         // favori haber linkleri
  let readItems = loadJSON("readItems", []);         // okunmus haber linkleri
  let darkMode = loadJSON("darkMode", false);
  let autoRefreshTimer = null;
  const AUTO_REFRESH_MS = 3 * 60 * 1000; // 3 dakikada bir otomatik yenile

  // ==================== HABER TAKIP (KEYWORD) STATE ====================
  let trackedKeywords = loadJSON("trackedKeywords", []);     // ["deprem", "secim", ...]
  let trackedSeenLinks = loadJSON("trackedSeenLinks", []);   // bildirimi daha once gonderilen linkler
  const TRACK_CHECK_MS = 5 * 60 * 1000;                      // 5 dakikada bir tum kaynaklari tara
  let trackCheckTimer = null;
 let trackingMatches = loadJSON("trackingMatches", []);
  // eslesen haberler: {title, link, pubDate, sourceName, sourceLogo, matchedKeyword}
  let isFirstTrackCheck = true;  // acilista spam bildirim gondermemek icin

  // ✅ TEMİZLİK: Artık takip edilmeyen kelimelere ait yetim (orphan) eşleşmeleri temizle
  {
    const activeKeywordsLower = trackedKeywords.map(k =>
      String(k).trim().toLocaleLowerCase('tr-TR')
    );
    const beforeCount = trackingMatches.length;
    trackingMatches = trackingMatches.filter(item =>
      activeKeywordsLower.includes(
        String(item.matchedKeyword || "").trim().toLocaleLowerCase('tr-TR')
      )
    );
    if (trackingMatches.length !== beforeCount) {
      saveJSON("trackingMatches", trackingMatches);
      console.log(`Temizlik: ${beforeCount - trackingMatches.length} yetim eslesme kaldirildi.`);
    }
  }


  // Kaydedilmis takip verilerini main process'e senkronize et
  if (window.api && typeof window.api.syncTrackedKeywords === "function") {
    window.api.syncTrackedKeywords({ keywords: trackedKeywords, seenLinks: trackedSeenLinks });
  }

  // ==================== DOM REFERANSLARI ====================
  const tabsContainer = document.getElementById("tabs");
  const newsListContainer = document.getElementById("newsList");
  const statusEl = document.getElementById("status");
  const searchInput = document.getElementById("searchInput");
  const sourceFilterSelect = document.getElementById("sourceFilter");
  const darkModeToggle = document.getElementById("darkModeToggle");

  const modal = document.getElementById("sourceModal");
  const modalTitle = document.getElementById("modalTitle");
  const modalNameInput = document.getElementById("modalName");
  const modalUrlInput = document.getElementById("modalUrl");
  const modalCategoryInput = document.getElementById("modalCategory");
  const modalLogoInput = document.getElementById("modalLogo");
const modalTypeInput = document.getElementById("modalType");
const htmlSelectorFields = document.getElementById("htmlSelectorFields");
const modalItemSelectorInput = document.getElementById("modalItemSelector");
const modalTitleSelectorInput = document.getElementById("modalTitleSelector");
const modalLinkSelectorInput = document.getElementById("modalLinkSelector");
const modalDescriptionSelectorInput = document.getElementById("modalDescriptionSelector");
const modalDateSelectorInput = document.getElementById("modalDateSelector");
  const categoryDatalist = document.getElementById("categoryList");

  let editingSourceId = null;
function updateHtmlSelectorVisibility() {
  if (!htmlSelectorFields || !modalTypeInput) return;

  htmlSelectorFields.style.display =
    modalTypeInput.value === "html" ? "block" : "none";
}

  // ==================== YARDIMCI FONKSIYONLAR ====================
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.error("loadJSON hatasi:", key, e);
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error("saveJSON hatasi:", key, e);
    }
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }
function parseNewsDate(dateStr) {
  if (!dateStr) return null;

  const value = String(dateStr).trim();
  if (!value) return null;

  /*
   * Saat dilimi açıkça belirtilmişse JavaScript'in dönüşümünü kullan:
   * 2026-08-23T14:30:00Z
   * 2026-08-23T14:30:00+02:00
   * Sun, 23 Aug 2026 14:30:00 GMT
   * Sun, 23 Aug 2026 14:30:00 -0400
   */
  const hasExplicitTimezone =
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ||
    /\b(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/i.test(value);

  if (hasExplicitTimezone) {
    const dateWithTimezone = new Date(value);

    if (!Number.isNaN(dateWithTimezone.getTime())) {
      return dateWithTimezone;
    }
  }

  /*
   * ISO biçiminde saat dilimi yoksa saati olduğu gibi koru:
   * 2026-08-23T14:30:00
   * 2026-08-23 14:30:00
   */
  let match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const second = Number(match[6] || 0);

    const localDate = new Date(
      year,
      month,
      day,
      hour,
      minute,
      second
    );

    if (!Number.isNaN(localDate.getTime())) {
      return localDate;
    }
  }

  /*
   * Diğer standart RSS tarihlerini ayrıştırmayı dene.
   */
  const fallbackDate = new Date(value);

  if (!Number.isNaN(fallbackDate.getTime())) {
    return fallbackDate;
  }

  return null;
}
function isTurkishNewsSource(item) {
  if (!item) return false;

  const registeredSource = sourcesData.find(source =>
    String(source.id || "") === String(item.sourceId || "")
  );

  // Bir kaynağa dateMode: "turkey-local" eklenmişse
  // kesinlikle Türkiye yerel saati olarak değerlendirilir.
  if (registeredSource?.dateMode === "turkey-local") {
    return true;
  }

  // T24 RSS'i arka planda çalışıyor, sourceUrl bazen boş gelebiliyor.
  // Bu yüzden T24'ü doğrudan ve garantili şekilde yakalıyoruz.
  const sourceIdText = String(item.sourceId || registeredSource?.id || "").toLowerCase();
  const sourceNameText = String(item.sourceName || registeredSource?.name || "").toLocaleLowerCase("tr-TR");

  if (sourceIdText === "t24" || sourceNameText.includes("t24")) {
    return true;
  }

  const sourceText = [
    item.sourceName,
    item.sourceUrl,
    registeredSource?.name,
    registeredSource?.url
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("tr-TR");

  const turkishDomains = [
    ".com.tr",
    ".net.tr",
    ".org.tr",
    ".gov.tr",
    "cnnturk.com",
    "haberturk.com",
    "trthaber.com",
    "aa.com.tr",
    "ensonhaber.com",
    "sozcu.com.tr",
    "hurriyet.com.tr",
    "milliyet.com.tr",
    "sabah.com.tr",
    "takvim.com.tr",
    "haber7.com",
    "t24.com.tr",
    "gazeteduvar.com.tr",
    "cumhuriyet.com.tr",
    "karar.com",
    "diken.com.tr"
  ];

  return turkishDomains.some(domain => sourceText.includes(domain)) ||
    /\bcnn\s*türk\b/i.test(sourceText) ||
    /\btrt\s*haber\b/i.test(sourceText) ||
    /\bhaber\s*türk\b/i.test(sourceText);
}

function parseDateAsWritten(dateStr) {
  if (!dateStr) return null;

  const value = String(dateStr).trim();
  if (!value) return null;

  // ISO: 2026-08-23T21:53:00Z veya +00:00
  let match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );

  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4] || 0),
      minute: Number(match[5] || 0),
      second: Number(match[6] || 0)
    };
  }

  // RFC/RSS: Sun, 23 Aug 2026 21:53:00 GMT
  match = value.match(
    /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/
  );

  if (match) {
    const months = {
      Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
      Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
    };

    const month = months[match[2]];

    if (month) {
      return {
        year: Number(match[3]),
        month,
        day: Number(match[1]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6] || 0)
      };
    }
  }

  return null;
}

function formatDate(dateStr, item = null) {
  if (!dateStr) return "";

  /*
   * Bazı Türk kaynakları Türkiye saatini Z/GMT olarak gönderiyor.
   * Bu kaynaklarda saat dilimi dönüşümü yapmadan ekranda yazıldığı
   * tarih ve saati koruyoruz.
   */
  if (isTurkishNewsSource(item)) {
    const parts = parseDateAsWritten(dateStr);

    if (parts) {
      const fakeUtcDate = new Date(Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second
      ));

      return new Intl.DateTimeFormat("tr-TR", {
        timeZone: "UTC",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).format(fakeUtcDate);
    }
  }

  // Yabancı kaynakları gerçek saat diliminden Türkiye saatine çevir.
  const date = parseNewsDate(dateStr);

  if (!date) {
    return String(dateStr);
  }

  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

  function getSourcesByCategory(category) {
    if (!category || category === "__all__" || category === "__favorites__" || category === "__tracking__") {
      return sourcesData;
    }
    return sourcesData.filter(s => (s.category || "Genel") === category);
  }
async function fetchNewsFromSource(src) {
  if (!src) {
    throw new Error("Kaynak bilgisi bulunamadı.");
  }

  // Eski kaynaklarda type alanı yoktur; bunlar RSS kabul edilir.
  const sourceType = src.type || "rss";

  if (sourceType === "html") {
    if (
      !window.api ||
      typeof window.api.fetchSource !== "function"
    ) {
      throw new Error("HTML kaynak köprüsü kullanılamıyor.");
    }

  const result = await window.api.fetchSource({
  id: src.id,
  name: src.name,
  url: src.url,
  category: src.category,
  logo: src.logo,
  type: "html",
  selectors: src.selectors || {}
});

return result;
  }

  if (
    !window.api ||
    typeof window.api.fetchRSS !== "function"
  ) {
    throw new Error("RSS kaynak köprüsü kullanılamıyor.");
  }

  return window.api.fetchRSS(src.url);
}

function getNewsTimestamp(dateStr, item = null) {
  if (!dateStr) return 0;

  if (isTurkishNewsSource(item)) {
    const parts = parseDateAsWritten(dateStr);

    if (parts) {
      // ✅ DÜZELTME: Yazılı saat Türkiye yereldir (UTC+3, DST yok).
      // Gerçek UTC epoch üretmek için saatten 3 çıkarıyoruz.
      // Date.UTC negatif saat değerini otomatik olarak
      // bir önceki güne doğru taşır (örn. gün 1, saat -1 → gün 0, saat 23).
      return Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour - 3,
        parts.minute,
        parts.second || 0
      );
    }
  }

  // Yabancı kaynaklarda gerçek saat dilimi dönüşümünü kullan.
  const date = parseNewsDate(dateStr);
  return date ? date.getTime() : 0;
}


  // ==================== SEKME (TAB) YONETIMI ====================
  function renderTabs() {
    if (!tabsContainer) return;
    tabsContainer.innerHTML = "";

    const specialTabs = [
      { key: "__all__", label: "Tumu" },
      { key: "__favorites__", label: "Favoriler" },
      { key: "__tracking__", label: "Haber Takip" }
    ];

    const categories = getCategories();

    const allTabs = [
      ...specialTabs,
      ...categories.map(c => ({ key: c, label: c }))
    ];

    allTabs.forEach(tab => {
      const btn = document.createElement("button");
      btn.className = "tab-btn" + (currentCategory === tab.key ? " active" : "");
      btn.textContent = tab.label;
      btn.addEventListener("click", () => selectCategory(tab.key));
      tabsContainer.appendChild(btn);
    });
  }

  function selectCategory(key) {
    currentCategory = key;
    saveJSON("lastCategory", key);
    renderTabs();

    if (key === "__favorites__") {
      renderFavoritesTab();
      stopAutoRefreshUI();
      return;
    }

    if (key === "__tracking__") {
      renderTrackingTab();
      stopAutoRefreshUI();
      return;
    }

    loadCategory(key);
    startAutoRefresh();
  }

  function stopAutoRefreshUI() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  // ==================== KAYNAK (SOURCE) YUKLEME ====================
 async function saveSourceFromModal() {
  const name = modalNameInput ? modalNameInput.value.trim() : "";
  const url = modalUrlInput ? modalUrlInput.value.trim() : "";
  const category = modalCategoryInput ? modalCategoryInput.value.trim() : "Genel";
  const logo = modalLogoInput ? modalLogoInput.value.trim() : "";
  const type = modalTypeInput ? modalTypeInput.value : "rss";

  if (!name || !url) {
    setStatus("Kaynak adı ve URL alanları zorunludur.");
    return;
  }

  const selectors = type === "html"
    ? {
        item: modalItemSelectorInput ? modalItemSelectorInput.value.trim() : "",
        title: modalTitleSelectorInput ? modalTitleSelectorInput.value.trim() : "",
        link: modalLinkSelectorInput ? modalLinkSelectorInput.value.trim() : "",
        description: modalDescriptionSelectorInput ? modalDescriptionSelectorInput.value.trim() : "",
        date: modalDateSelectorInput ? modalDateSelectorInput.value.trim() : ""
      }
    : undefined;

  try {
    if (editingSourceId) {
      const result = await window.api.updateSource({
        id: editingSourceId,
        name, url, category, logo, type, selectors
      });
      if (result?.success) sourcesData = result.sources;
    } else {
      const result = await window.api.addSource({
        name, url, category, logo, type, selectors
      });
      if (result?.success) sourcesData = result.sources;
    }
  } catch (e) {
    console.error("Kaynak kaydetme hatasi:", e);
    setStatus("Kaynak kaydedilirken hata olustu.");
    return;
  }

  refreshCategoryDatalist();
  buildSourceFilterOptions();
  renderTabs();
  renderSourceListInModal();
  closeModal();
}

     async function loadCategory(category) {
    const sources = getSourcesByCategory(category);
 if (sources.length === 0) {
  allNewsItems = [];
  newsCache = [];
  renderNewsList([]);
      setStatus("Bu kategoride kaynak yok.");
      return;
    }

    setStatus("Haberler yukleniyor...");
    try {
     const results = await Promise.all(
  sources.map(async src => {
    try {
      const result = await fetchNewsFromSource(src);

      const items =
        (result && Array.isArray(result.items) && result.items) ||
        (Array.isArray(result) ? result : []);

           return items.map(item => ({
        ...item,
        sourceName: src.name,
        sourceLogo: src.logo,
        sourceId: src.id,
        category: src.category || "Genel"
      }));
    } catch (err) {
      console.error(
        "Kaynak yükleme hatası:",
        {
          name: src.name,
          type: src.type || "rss",
          url: src.url,
          error: err
        }
      );

      return [];
    }
  })
);

// Seçili kategorideki bütün kaynakların sonuçlarını birleştir.
allNewsItems = results.flat();

// Aynı bağlantıya sahip mükerrer haberleri kaldır.
const categoryMap = new Map();

allNewsItems.forEach(item => {
  const key =
    item.link ||
    `${item.sourceId || ""}|${item.title || ""}|${item.pubDate || ""}`;

  const existingItem = categoryMap.get(key);

  if (
    !existingItem ||
    (item.pubDate && !existingItem.pubDate)
  ) {
    categoryMap.set(key, item);
  }
});

// Yalnızca seçili kategorinin birleştirilmiş haberlerini sıralayıp cache'e aktar.
newsCache = Array.from(categoryMap.values()).sort((a, b) => {
  const tsA = getNewsTimestamp(a.pubDate, a);
  const tsB = getNewsTimestamp(b.pubDate, b);

  return tsB - tsA;
});

    applyFiltersAndRender();

     setStatus(`${newsCache.length} haber yuklendi.`);
    } catch (e) {
      console.error("loadCategory hatasi:", e);
      setStatus("Haberler yuklenirken hata olustu.");
 
    }
  }

  function applyFiltersAndRender() {
    if (currentCategory === "__tracking__" || currentCategory === "__favorites__") return;

    // Birleştirilmiş ve önceden tarihe göre sıralanmış listeyi kullan.
    let items = [...newsCache];

 const searchTerm = (searchInput && searchInput.value || "").trim().toLocaleLowerCase('tr-TR');
    if (searchTerm) {
      items = items.filter(it =>
        (it.title || "").toLocaleLowerCase('tr-TR').includes(searchTerm) ||
        (it.description || "").toLocaleLowerCase('tr-TR').includes(searchTerm)
      );
    }

    const sourceFilter = sourceFilterSelect ? sourceFilterSelect.value : "__all__";
    if (sourceFilter && sourceFilter !== "__all__") {
      items = items.filter(it => it.sourceId === sourceFilter);
    }

    renderNewsList(items);
  }

  function buildSourceFilterOptions() {
    if (!sourceFilterSelect) return;
    sourceFilterSelect.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "__all__";
    allOpt.textContent = "Tum Kaynaklar";
    sourceFilterSelect.appendChild(allOpt);

    sourcesData.forEach(src => {
      const opt = document.createElement("option");
      opt.value = src.id;
      opt.textContent = src.name;
      sourceFilterSelect.appendChild(opt);
    });
  }

  function getCategories() {
    const cats = new Set(sourcesData.map(s => s.category || "Genel"));
    return Array.from(cats).sort();
  }

  function refreshCategoryDatalist() {
    if (!categoryDatalist) return;
    categoryDatalist.innerHTML = "";
    getCategories().forEach(cat => {
      const opt = document.createElement("option");
      opt.value = cat;
      categoryDatalist.appendChild(opt);
    });
  }

  // ==================== HABER LISTESI RENDER ====================
    let lastRenderedItems = [];
    function renderNewsList(items) {
    if (!newsListContainer) return;
    newsListContainer.innerHTML = "";
    lastRenderedItems = items;


    if (!items || items.length === 0) {
      newsListContainer.innerHTML = '<p class="empty-msg">Gosterilecek haber bulunamadi.</p>';
      return;
    }

  lastRenderedItems = items; // export için tüm listeyi sakla
items.forEach((item, idx) => {
  const card = document.createElement("div");

  const isRead = readItems.includes(item.link);
  const isFav = favorites.includes(item.link);

  // Haberde eşleşen takip kelimelerini bul
  const matchedKeywords = getMatchedTrackedKeywords(item);
  const isTrackedMatch = matchedKeywords.length > 0;

  card.className =
    "news-card" +
    (isRead ? " read" : "") +
    (isTrackedMatch ? " tracked-match" : "");
      const catColor = getCategoryColor(item.category);
  card.style.borderTop = `3px solid ${catColor}`;
const trackedBadge = isTrackedMatch
  ? `
    <div class="tracked-match-badge">
      <span class="tracked-bell">🔔</span>
      <span>Takip:</span>
      <strong>${matchedKeywords.join(", ")}</strong>
    </div>
  `
  : "";


      card.innerHTML = `
                            <div class="news-header">
          <input type="checkbox" class="news-export-checkbox" data-link="${item.link}" style="margin-right:8px; width:16px; height:16px; cursor:pointer;" />
          ${item.sourceLogo ? `<img src="${item.sourceLogo}" class="source-logo" alt="${item.sourceName}" />` : ""}
          <span class="source-name">${item.sourceName || ""}</span>
          <span class="category-badge" style="background:${catColor}20; color:${catColor}; border:1px solid ${catColor}55;">
            ${item.category || "Genel"}
          </span>
          <span class="pub-date">${formatDate(item.pubDate, item)}</span>
        </div>
${trackedBadge}

        <h3 class="news-title">${item.title || ""}</h3>
        <p class="news-desc">${(item.description || "").slice(0, 200)}</p>
        <div class="news-actions">
          <button class="fav-btn ${isFav ? "active" : ""}" data-link="${item.link}">
            ${isFav ? "★ Favoride" : "☆ Favorile"}
          </button>
          <a href="${item.link}" target="_blank" class="read-link" data-link="${item.link}">Habere Git</a>
        </div>
      `;

      newsListContainer.appendChild(card);
    });

    newsListContainer.querySelectorAll(".fav-btn").forEach(btn => {
      btn.addEventListener("click", () => toggleFavorite(btn.dataset.link));
    });
    newsListContainer.querySelectorAll(".read-link").forEach(a => {
      a.addEventListener("click", () => markAsRead(a.dataset.link));
    });
  }

  function renderFavoritesTab() {
    const favItems = allNewsItemsCache().filter(it => favorites.includes(it.link));
    renderNewsList(favItems);
    setStatus(`${favItems.length} favori haber.`);
  }

  // Favoriler icin, tum kategorilerden gecmis haberleri hafizada tutmak yerine
  // basit cozum: son yuklenen allNewsItems + su anki oturumda gorulenler.
  let newsCache = [];
  function allNewsItemsCache() {
    return newsCache;
  }

  function toggleFavorite(link) {
    const idx = favorites.indexOf(link);
    if (idx === -1) {
      favorites.push(link);
    } else {
      favorites.splice(idx, 1);
    }
    saveJSON("favorites", favorites);

    if (currentCategory === "__favorites__") {
      renderFavoritesTab();
    } else {
      applyFiltersAndRender();
    }
  }

  function markAsRead(link) {
    if (!readItems.includes(link)) {
      readItems.push(link);
      saveJSON("readItems", readItems);
    }
  }
function getMatchedTrackedKeywords(item) {
  const title = (item.title || "").toLocaleLowerCase("tr-TR");
  const description = (item.description || "").toLocaleLowerCase("tr-TR");
  const searchableText = title + " " + description;

  return trackedKeywords.filter(keyword => {
    const normalizedKeyword = String(keyword || "")
      .trim()
      .toLocaleLowerCase("tr-TR");

    if (!normalizedKeyword) return false;

    // Özel regex karakterlerini güvenli hâle getir
    const escapedKeyword = normalizedKeyword.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    // Türkçe karakterleri destekleyen kelime sınırı kontrolü
    const regex = new RegExp(
      `(^|[^a-zçğıöşü0-9])${escapedKeyword}([^a-zçğıöşü0-9]|$)`,
      "i"
    );

    return regex.test(searchableText);
  });
}

  // ==================== OTOMATIK YENILEME ====================
  function startAutoRefresh() {
    stopAutoRefreshUI();
    if (currentCategory === "__tracking__" || currentCategory === "__favorites__") return;

    autoRefreshTimer = setInterval(() => {
      if (currentCategory && currentCategory !== "__tracking__" && currentCategory !== "__favorites__") {
        loadCategory(currentCategory);
      }
    }, AUTO_REFRESH_MS);
  }

  // ==================== HABER TAKIP (KEYWORD TRACKING) ====================
  function renderTrackingTab() {
    if (!newsListContainer) return;
    newsListContainer.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "tracking-wrapper";

    wrapper.innerHTML = `
      <div class="tracking-input-row">
        <input type="text" id="newKeywordInput" placeholder="Takip edilecek kelime..." />
        <button id="addKeywordBtn">Ekle</button>
      </div>
      <div class="tracked-keywords-list" id="trackedKeywordsList"></div>
      <hr />
      <h4>Eslesen Haberler</h4>
      <div class="tracking-matches" id="trackingMatchesList"></div>
    `;

    newsListContainer.appendChild(wrapper);

    const keywordsListEl = document.getElementById("trackedKeywordsList");
    trackedKeywords.forEach(kw => {
      const chip = document.createElement("span");
      chip.className = "keyword-chip";
      chip.innerHTML = `${kw} <button data-kw="${kw}" class="remove-kw-btn">✕</button>`;
      keywordsListEl.appendChild(chip);
    });

    keywordsListEl.querySelectorAll(".remove-kw-btn").forEach(btn => {
      btn.addEventListener("click", () => removeTrackedKeyword(btn.dataset.kw));
    });

    document.getElementById("addKeywordBtn").addEventListener("click", () => {
      const input = document.getElementById("newKeywordInput");
      const val = input.value.trim();
      if (val) {
        addTrackedKeyword(val);
        input.value = "";
      }
    });

    document.getElementById("newKeywordInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        document.getElementById("addKeywordBtn").click();
      }
    });

    const matchesListEl = document.getElementById("trackingMatchesList");
    if (trackingMatches.length === 0) {
      matchesListEl.innerHTML = '<p class="empty-msg">Henuz eslesen haber yok.</p>';
    } else {
          trackingMatches.forEach(item => {
        const card = document.createElement("div");
        card.className = "news-card match-card";
        const catColor = getCategoryColor(item.category);
        card.style.borderTop = `3px solid ${catColor}`;
        card.innerHTML = `
          <div class="news-header">
            ${item.sourceLogo ? `<img src="${item.sourceLogo}" class="source-logo" alt="${item.sourceName}" />` : ""}
            <span class="source-name">${item.sourceName || ""}</span>
            <span class="category-badge" style="background:${catColor}20; color:${catColor}; border:1px solid ${catColor}55;">
              ${item.category || "Genel"}
            </span>
            <span class="pub-date">${formatDate(item.pubDate, item)}</span>
            <span class="matched-kw">Eslesen: ${item.matchedKeyword}</span>
          </div>
          <h3 class="news-title">${item.title || ""}</h3>
          <a href="${item.link}" target="_blank" class="read-link">Habere Git</a>
        `;
        matchesListEl.appendChild(card);
      });
    }

    setStatus(`${trackedKeywords.length} kelime takip ediliyor, ${trackingMatches.length} eslesme.`);
  }

function addTrackedKeyword(keyword) {
  const normalized = keyword.trim();
  if (!normalized) return;
  if (trackedKeywords.some(k => k.toLocaleLowerCase('tr-TR') === normalized.toLocaleLowerCase('tr-TR'))) return;

  trackedKeywords.push(normalized);
  saveJSON("trackedKeywords", trackedKeywords);

  if (window.api && typeof window.api.syncTrackedKeywords === "function") {
    window.api.syncTrackedKeywords({ keywords: trackedKeywords, seenLinks: trackedSeenLinks });
  }

  if (currentCategory === "__tracking__") {
    renderTrackingTab();
    checkKeywordsAcrossAllSources();   // ✅ EKLENDİ: kelimeyi hemen tara
  }
}


   function removeTrackedKeyword(keyword) {
    const keywordLower = keyword.trim().toLocaleLowerCase('tr-TR');

    // 1) Kelimeyi takip listesinden çıkar
    trackedKeywords = trackedKeywords.filter(k => k !== keyword);
    saveJSON("trackedKeywords", trackedKeywords);

    // 2) ✅ DÜZELTME: Bu kelimeyle eşleşmiş "seenLinks" kayıtlarını temizle
    //    (böylece kelime tekrar eklenirse aynı haber tekrar eşleşebilir)
    trackedSeenLinks = trackedSeenLinks.filter(seenKey => {
      const parts = String(seenKey).split("::");
      const kwPart = parts.length > 1 ? parts[1] : null;
      return kwPart !== keywordLower;
    });
    saveJSON("trackedSeenLinks", trackedSeenLinks);

    // 3) ✅ DÜZELTME: Bu kelimeyle eşleşmiş geçmiş haber kartlarını da listeden kaldır
    trackingMatches = trackingMatches.filter(item =>
      (item.matchedKeyword || "").toLocaleLowerCase('tr-TR') !== keywordLower
    );
    saveJSON("trackingMatches", trackingMatches);

    if (window.api && typeof window.api.syncTrackedKeywords === "function") {
      window.api.syncTrackedKeywords({ keywords: trackedKeywords, seenLinks: trackedSeenLinks });
    }

    if (currentCategory === "__tracking__") {
      renderTrackingTab();
    }
  }


  async function checkKeywordsAcrossAllSources() {
    if (trackedKeywords.length === 0) return;

    try {
    // YENİ (düzeltilmiş):
const results = await Promise.all(
  sourcesData.map(async src => {
    try {
      const result = await fetchNewsFromSource(src);

      const items =
        (result && Array.isArray(result.items) && result.items) ||
        (Array.isArray(result) ? result : []);

          return items.map(item => ({
        ...item,
        sourceName: src.name,
        sourceLogo: src.logo,
        sourceId: src.id,
        category: src.category || "Genel"
      }));
    } catch (err) {
      console.error(
        "Takip için kaynak yükleme hatası:",
        {
          name: src.name,
          type: src.type || "rss",
          url: src.url,
          error: err
        }
      );

      return [];
    }
  })
);



      const allItems = results.flat();
      newsCache = allItems; // favoriler sekmesi icin de kullanilabilir

      const newMatches = [];

           allItems.forEach(item => {
        const titleLower = (item.title || "").toLocaleLowerCase('tr-TR');
        const descLower = (item.description || "").toLocaleLowerCase('tr-TR');

        for (const kw of trackedKeywords) {
          const kwLower = kw.toLocaleLowerCase('tr-TR');
          if (titleLower.includes(kwLower) || descLower.includes(kwLower)) {
            // ✅ DÜZELTME: link + kelime kombinasyonu ile takip et
            const seenKey = `${item.link}::${kwLower}`;
            if (!trackedSeenLinks.includes(seenKey)) {
              newMatches.push({ ...item, matchedKeyword: kw });
              trackedSeenLinks.push(seenKey);
            }
            break;
          }
        }
      });

                if (newMatches.length > 0) {
        trackingMatches = [...newMatches, ...trackingMatches].slice(0, 200);
        saveJSON("trackingMatches", trackingMatches);
        saveJSON("trackedSeenLinks", trackedSeenLinks);

        if (window.api && typeof window.api.syncTrackedKeywords === "function") {
          window.api.syncTrackedKeywords({ keywords: trackedKeywords, seenLinks: trackedSeenLinks });
        }

        if (currentCategory === "__tracking__") {
          renderTrackingTab();
        }

        // Not: Bildirim gonderme sorumlulugu artik main.js (arka plan tarayici) tarafinda.
        // Renderer sadece UI guncellemesi yapar.
      }

      isFirstTrackCheck = false;
    } catch (e) {
      console.error("checkKeywordsAcrossAllSources hatasi:", e);
    }
  }

  function startTrackingCheck() {

    if (trackCheckTimer) clearInterval(trackCheckTimer);
    checkKeywordsAcrossAllSources();
    trackCheckTimer = setInterval(checkKeywordsAcrossAllSources, TRACK_CHECK_MS);
  }

      

  // ==================== KAYNAK YONETIMI (MODAL) ====================
 function openAddModal() {
  editingSourceId = null;

  if (modalTitle) modalTitle.textContent = "Yeni Kaynak Ekle";
  if (modalNameInput) modalNameInput.value = "";
  if (modalUrlInput) modalUrlInput.value = "";
  if (modalCategoryInput) modalCategoryInput.value = "";
  if (modalLogoInput) modalLogoInput.value = "";

  if (modalTypeInput) modalTypeInput.value = "rss";
  if (modalItemSelectorInput) modalItemSelectorInput.value = "";
  if (modalTitleSelectorInput) modalTitleSelectorInput.value = "";
  if (modalLinkSelectorInput) modalLinkSelectorInput.value = "";
  if (modalDescriptionSelectorInput) modalDescriptionSelectorInput.value = "";
  if (modalDateSelectorInput) modalDateSelectorInput.value = "";

  updateHtmlSelectorVisibility();

  if (modal) modal.classList.add("open");
  renderSourceListInModal();
}


  function openEditModal(sourceId) {
  const src = sourcesData.find(s => s.id === sourceId);
  if (!src) return;

  editingSourceId = sourceId;

  if (modalTitle) modalTitle.textContent = "Kaynağı Düzenle";
  if (modalNameInput) modalNameInput.value = src.name || "";
  if (modalUrlInput) modalUrlInput.value = src.url || "";
  if (modalCategoryInput) modalCategoryInput.value = src.category || "";
  if (modalLogoInput) modalLogoInput.value = src.logo || "";

  // Eski kaynaklarda type bulunmadığı için RSS kabul edilir.
  if (modalTypeInput) modalTypeInput.value = src.type || "rss";

  const selectors = src.selectors || {};

  if (modalItemSelectorInput) {
    modalItemSelectorInput.value = selectors.item || "";
  }

  if (modalTitleSelectorInput) {
    modalTitleSelectorInput.value = selectors.title || "";
  }

  if (modalLinkSelectorInput) {
    modalLinkSelectorInput.value = selectors.link || "";
  }

  if (modalDescriptionSelectorInput) {
    modalDescriptionSelectorInput.value = selectors.description || "";
  }

  if (modalDateSelectorInput) {
    modalDateSelectorInput.value = selectors.date || "";
  }

  updateHtmlSelectorVisibility();

  if (modal) modal.classList.add("open");
  renderSourceListInModal();
}

  function closeModal() {
    if (modal) modal.classList.remove("open");
    editingSourceId = null;
  }

async function deleteSource(sourceId) {
  if (!confirm("Bu kaynagi silmek istediginize emin misiniz?")) return;

  try {
    const result = await window.api.removeSource({ id: sourceId });
    if (result?.success) {
      sourcesData = result.sources;
    }
  } catch (e) {
    console.error("Kaynak silme hatasi:", e);
    setStatus("Kaynak silinirken hata olustu.");
    return;
  }

  refreshCategoryDatalist();
  buildSourceFilterOptions();
  renderTabs();

  if (currentCategory) {
    selectCategory(currentCategory);
  }
}

 function renderSourceListInModal() {
  const container = document.getElementById("sourceListContainer");
  if (!container) return;
  container.innerHTML = "";

  if (sourcesData.length === 0) {
    container.innerHTML = '<p class="empty-msg">Henüz kaynak eklenmedi.</p>';
    return;
  }

  sourcesData.forEach(src => {
    const row = document.createElement("div");
    row.className = "source-item";
    row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #eee;";
    row.innerHTML = `
      ${src.logo ? `<img src="${src.logo}" style="width:20px;height:20px;border-radius:4px;" alt="" />` : ""}
      <span style="flex:1; font-weight:500;">${src.name}</span>
      <span style="color:#888; font-size:12px;">${src.category || "Genel"}</span>
      <button class="edit-source-btn" data-id="${src.id}" title="Düzenle">✏️</button>
      <button class="delete-source-btn" data-id="${src.id}" title="Sil">🗑️</button>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll(".edit-source-btn").forEach(btn => {
    btn.addEventListener("click", () => openEditModal(btn.dataset.id));
  });
  container.querySelectorAll(".delete-source-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteSource(btn.dataset.id));
  });
}


  // ==================== OLAY DINLEYICILERI (EVENT LISTENERS) ====================
  if (searchInput) {
    searchInput.addEventListener("input", () => applyFiltersAndRender());
  }
  if (sourceFilterSelect) {
    sourceFilterSelect.addEventListener("change", () => applyFiltersAndRender());
  }
  if (darkModeToggle) {
    darkModeToggle.addEventListener("click", () => {
      darkMode = !darkMode;
      saveJSON("darkMode", darkMode);
      applyDarkMode();
    });
  }

function applyDarkMode() {
  document.body.classList.toggle("dark-mode", !!darkMode);
  if (darkModeToggle) {
    darkModeToggle.textContent = darkMode ? "☀️ Aydınlık Mod" : "🌙 Karanlık Mod";
  }
}

  const addSourceBtn = document.getElementById("addSourceBtn");
  if (addSourceBtn) addSourceBtn.addEventListener("click", openAddModal);
const refreshBtn = document.getElementById("refreshBtn");
const refreshIcon = document.getElementById("refreshIcon");
if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    if (refreshIcon) refreshIcon.classList.add("spinning");
    try {
      if (currentCategory === "__tracking__") {
        // Haber Takip sekmesindeyken, kategori yerine kelime taramasını tetikle
        await checkKeywordsAcrossAllSources();
        renderTrackingTab();
      } else {
        await loadCategory(currentCategory);
      }
    } finally {
      refreshBtn.disabled = false;
      if (refreshIcon) refreshIcon.classList.remove("spinning");
    }
  });
}

// ============================================
// 🎯 TICKER (HABER BANDI) BUTONU
// ============================================
const openTickerBtn = document.getElementById("openTickerBtn");
if (openTickerBtn) {
  openTickerBtn.addEventListener("click", async () => {
    try {
      await window.api.openTickerWindow();
    } catch (err) {
      console.error("Ticker penceresi açılırken hata:", err);
    }
  });
}

const exportBtn = document.getElementById("exportBtn");
if (exportBtn) {
  exportBtn.addEventListener("click", async () => {
    const checkboxes = newsListContainer.querySelectorAll(".news-export-checkbox:checked");
    let selectedItems;

    if (checkboxes.length > 0) {
      const selectedLinks = Array.from(checkboxes).map((cb) => cb.dataset.link);
      selectedItems = lastRenderedItems.filter((it) => selectedLinks.includes(it.link));
    } else {
      selectedItems = lastRenderedItems;
    }

    if (!selectedItems || selectedItems.length === 0) {
      alert("Dışa aktarılacak haber bulunamadı.");
      return;
    }

    const result = await window.api.exportNews({ data: selectedItems });

    if (result.success) {
      setStatus(`✅ ${selectedItems.length} haber dışa aktarıldı: ${result.filePath}`);
    } else if (!result.canceled) {
      alert("Dışa aktarma hatası: " + result.error);
    }
  });
}

if (modalTypeInput) {
  modalTypeInput.addEventListener("change", updateHtmlSelectorVisibility);
}

const saveModalBtn = document.getElementById("modalSaveBtn");      // ✅ düzeltildi
if (saveModalBtn) saveModalBtn.addEventListener("click", saveSourceFromModal);

const cancelModalBtn = document.getElementById("modalCancelBtn");  // ✅ düzeltildi
if (cancelModalBtn) cancelModalBtn.addEventListener("click", closeModal);

async function loadSources() {
  try {
    sourcesData = await window.api.getSources();
  } catch (e) {
    console.error("Kaynaklar yüklenirken hata:", e);
    sourcesData = [];
  }

  refreshCategoryDatalist();
  buildSourceFilterOptions();
  renderTabs();
}

  // ==================== BASLANGIC ====================
  applyDarkMode();
  loadSources();
  startTrackingCheck();
}

// DOM yukleme kontrolu
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
// Sayfa yüklendiğinde bir kez çağırın:
window.api.onDescriptionUpdated(({ link, description }) => {
  const card = document.querySelector(`[data-link="${CSS.escape(link)}"]`);
  if (card) {
    const descEl = card.querySelector(".haber-ozet-metni");
    if (descEl) {
      descEl.textContent = description;
    }
  }
});

// ==================== YENİ: UYGULAMA VERSİYONU ====================
(async function showAppVersion() {
  try {
    if (window.api && typeof window.api.getAppVersion === "function") {
      const version = await window.api.getAppVersion();
      const versionEl = document.getElementById("appVersion");
      if (versionEl) {
        versionEl.textContent = `v${version}`;
      }
    }
  } catch (e) {
    console.error("Versiyon bilgisi alinamadi:", e);
  }
})();








// ============================================
// TICKER (HABER BANDI) AYARLARI MODALI
// ============================================
const tickerSettingsBtn = document.getElementById("tickerSettingsBtn");
const tickerSettingsModal = document.getElementById("tickerSettingsModal");
const tickerSourceList = document.getElementById("tickerSourceList");
const tickerSpeedSelect = document.getElementById("tickerSpeedSelect");
const tickerSettingsCancelBtn = document.getElementById("tickerSettingsCancelBtn");
const tickerSettingsSaveBtn = document.getElementById("tickerSettingsSaveBtn");

async function openTickerSettingsModal() {
  if (!tickerSettingsModal) return;

  const sources = await window.api.getSources();
  const settings = await window.api.getTickerSettings();
  const selectedIds = settings.sourceIds || [];

  tickerSourceList.innerHTML = "";

  sources.forEach((s) => {
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.padding = "4px 0";
    row.style.cursor = "pointer";

       const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = s.id;
    checkbox.checked = selectedIds.length === 0 || selectedIds.includes(s.id);
    checkbox.style.width = "18px";
    checkbox.style.height = "18px";
    checkbox.style.minWidth = "18px";
    checkbox.style.flexShrink = "0";
    checkbox.style.margin = "0";
    checkbox.style.accentColor = "#3b82f6";
    checkbox.style.cursor = "pointer";

    const dot = document.createElement("span");
    dot.style.display = "inline-block";
    dot.style.width = "10px";
    dot.style.height = "10px";
    dot.style.borderRadius = "50%";
    dot.style.background = getCategoryColor(s.category);
    dot.style.flexShrink = "0";

    const text = document.createElement("span");
    text.textContent = (s.name || "Adsız Kaynak") + " (" + (s.category || "Kategori yok") + ")";

    row.appendChild(checkbox);
    row.appendChild(dot);
    row.appendChild(text);
    tickerSourceList.appendChild(row);
  });

  tickerSpeedSelect.value = settings.speed || "normal";

  tickerSettingsModal.classList.add("open");
}

function closeTickerSettingsModal() {
  if (tickerSettingsModal) {
    tickerSettingsModal.classList.remove("open");
  }
}

if (tickerSettingsBtn) {
  tickerSettingsBtn.addEventListener("click", openTickerSettingsModal);
}

if (tickerSettingsCancelBtn) {
  tickerSettingsCancelBtn.addEventListener("click", closeTickerSettingsModal);
}

if (tickerSettingsSaveBtn) {
  tickerSettingsSaveBtn.addEventListener("click", async () => {
    const checkboxes = tickerSourceList.querySelectorAll('input[type="checkbox"]');
    const selectedIds = Array.from(checkboxes)
      .filter((cb) => cb.checked)
      .map((cb) => cb.value);

    const settings = {
      sourceIds: selectedIds,
      speed: tickerSpeedSelect.value
    };

    try {
      await window.api.saveTickerSettings(settings);
      closeTickerSettingsModal();
    } catch (err) {
      console.error("Ticker ayarlari kaydedilirken hata:", err);
    }
  });
}


