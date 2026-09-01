// ==================== renderer.js ====================
// Haber Takip Uygulamasi - Duzeltilmis ve Tam Surum

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
  let trackingMatches = [];      // eslesen haberler: {title, link, pubDate, sourceName, sourceLogo, matchedKeyword}
  let isFirstTrackCheck = true;  // acilista spam bildirim gondermemek icin

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
  const categoryDatalist = document.getElementById("categoryList");

  let editingSourceId = null;

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

  function formatDate(dateStr) {
  if (!dateStr) return "";

  // RSS kaynağı (örn. CNN Türk) tarihi Türkiye saatiyle yazıp
  // yanlışlıkla UTC olarak işaretliyor. Bu yüzden otomatik saat
  // dilimi dönüşümünü DEVRE DIŞI bırakıp, tarihi olduğu gibi
  // (kaydırma yapmadan) gösteriyoruz.

  // ISO format: 2026-08-21T01:26:00...
  let match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return `${day}.${month}.${year} ${hour}:${minute}`;
  }

  // RFC 822 format: Thu, 21 Aug 2026 01:26:00 +0300
  match = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s+(\d{2}):(\d{2})/);
  if (match) {
    const months = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
                      Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };
    const [, day, monName, year, hour, minute] = match;
    const month = months[monName] || "01";
    return `${day.padStart(2, "0")}.${month}.${year} ${hour}:${minute}`;
  }

  // Hiçbir formata uymazsa eski yönteme geri dön (yedek çözüm)
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleString("tr-TR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}


  function getCategories() {
    const cats = new Set(sourcesData.map(s => s.category || "Genel"));
    return Array.from(cats).sort();
  }

  function getSourcesByCategory(category) {
    if (!category || category === "__all__" || category === "__favorites__" || category === "__tracking__") {
      return sourcesData;
    }
    return sourcesData.filter(s => (s.category || "Genel") === category);
  }

function getNewsTimestamp(dateStr) {
  if (!dateStr) return 0;

  // ISO biçimi: 2026-08-21T01:26:00
  let match = String(dateStr).match(
    /(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/
  );

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);

    return new Date(
      year,
      month,
      day,
      hour,
      minute,
      second
    ).getTime();
  }

  // RSS/RFC biçimi: Thu, 21 Aug 2026 01:26:00 +0300
  match = String(dateStr).match(
    /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/
  );

  if (match) {
    const months = {
      Jan: 0,
      Feb: 1,
      Mar: 2,
      Apr: 3,
      May: 4,
      Jun: 5,
      Jul: 6,
      Aug: 7,
      Sep: 8,
      Oct: 9,
      Nov: 10,
      Dec: 11
    };

    const day = Number(match[1]);
    const month = months[match[2]];
    const year = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);

    if (month !== undefined) {
      return new Date(
        year,
        month,
        day,
        hour,
        minute,
        second
      ).getTime();
    }
  }

  // Diğer geçerli tarih biçimleri için yedek yöntem
  const parsed = new Date(dateStr).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
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
  async function loadSources() {
    setStatus("Kaynaklar yukleniyor...");
    try {
      sourcesData = loadJSON("sourcesData", []);
      refreshCategoryDatalist();
      buildSourceFilterOptions();
      renderTabs();

      const savedCategory = loadJSON("lastCategory", "__all__");
      selectCategory(savedCategory);

      setStatus("Hazir.");
    } catch (e) {
      console.error("loadSources hatasi:", e);
      setStatus("Kaynaklar yuklenirken hata olustu.");
    }
  }

     async function loadCategory(category) {
    const sources = getSourcesByCategory(category);
    if (sources.length === 0) {
      allNewsItems = [];
      renderNewsList([]);
      setStatus("Bu kategoride kaynak yok.");
      return;
    }

    setStatus("Haberler yukleniyor...");
    try {
      const results = await Promise.all(
        sources.map(src => window.api.fetchRSS(src.url).then(result => {
          const items = (result && result.items) || (Array.isArray(result) ? result : []);
          return items.map(item => ({ ...item, sourceName: src.name, sourceLogo: src.logo, sourceId: src.id }));
        }).catch(err => {
          console.error("RSS yukleme hatasi:", src.url, err);
          return [];
        }))
      );

     allNewsItems = results
  .flat()
  .sort((a, b) => getNewsTimestamp(b.pubDate) - getNewsTimestamp(a.pubDate));


      const cacheMap = new Map(newsCache.map(it => [it.link, it]));
      allNewsItems.forEach(it => cacheMap.set(it.link, it));
      newsCache = Array.from(cacheMap.values());

      applyFiltersAndRender();
      setStatus(`${allNewsItems.length} haber yuklendi.`);
    } catch (e) {
      console.error("loadCategory hatasi:", e);
      setStatus("Haberler yuklenirken hata olustu.");
 
    }
  }

  function applyFiltersAndRender() {
    if (currentCategory === "__tracking__" || currentCategory === "__favorites__") return;

    let items = [...allNewsItems];

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
  function renderNewsList(items) {
    if (!newsListContainer) return;
    newsListContainer.innerHTML = "";

    if (!items || items.length === 0) {
      newsListContainer.innerHTML = '<p class="empty-msg">Gosterilecek haber bulunamadi.</p>';
      return;
    }

  items.forEach(item => {
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
          ${item.sourceLogo ? `<img src="${item.sourceLogo}" class="source-logo" alt="${item.sourceName}" />` : ""}
          <span class="source-name">${item.sourceName || ""}</span>
          <span class="pub-date">${formatDate(item.pubDate)}</span>
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
        card.innerHTML = `
          <div class="news-header">
            ${item.sourceLogo ? `<img src="${item.sourceLogo}" class="source-logo" alt="${item.sourceName}" />` : ""}
            <span class="source-name">${item.sourceName || ""}</span>
            <span class="pub-date">${formatDate(item.pubDate)}</span>
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
    trackedKeywords = trackedKeywords.filter(k => k !== keyword);
    saveJSON("trackedKeywords", trackedKeywords);

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
  sourcesData.map(src => window.api.fetchRSS(src.url).then(result => {
    const items = (result && result.items) || (Array.isArray(result) ? result : []);
    return items.map(item => ({ ...item, sourceName: src.name, sourceLogo: src.logo, sourceId: src.id }));
  }).catch(err => {
    console.error("Takip icin RSS yukleme hatasi:", src.url, err);
    return [];
  }))
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
            if (!trackedSeenLinks.includes(item.link)) {
              newMatches.push({ ...item, matchedKeyword: kw });
              trackedSeenLinks.push(item.link);
            }
            break;
          }
        }
      });

      if (newMatches.length > 0) {
        trackingMatches = [...newMatches, ...trackingMatches].slice(0, 200);
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
    if (modal) modal.classList.add("open");
    renderSourceListInModal();   // ← EKLEYİN
}


  function openEditModal(sourceId) {
    const src = sourcesData.find(s => s.id === sourceId);
    if (!src) return;
    editingSourceId = sourceId;
    if (modalTitle) modalTitle.textContent = "Kaynagi Duzenle";
    if (modalNameInput) modalNameInput.value = src.name || "";
    if (modalUrlInput) modalUrlInput.value = src.url || "";
    if (modalCategoryInput) modalCategoryInput.value = src.category || "";
    if (modalLogoInput) modalLogoInput.value = src.logo || "";
    if (modal) modal.classList.add("open");
    if (modal) modal.classList.add("open");
    renderSourceListInModal();   // ← EKLEYİN
}
  function closeModal() {
    if (modal) modal.classList.remove("open");
    editingSourceId = null;
  }

 function saveSourceFromModal() {
  const name = modalNameInput ? modalNameInput.value.trim() : "";
  const url = modalUrlInput ? modalUrlInput.value.trim() : "";
  const category = modalCategoryInput ? modalCategoryInput.value.trim() || "Genel" : "Genel";
  let logo = modalLogoInput ? modalLogoInput.value.trim() : "";

  if (!name || !url) {
    alert("Kaynak adi ve URL zorunludur.");
    return;
  }

  // YENİ: Logo boşsa otomatik favicon oluşturulur
  if (!logo) {
    try {
      const urlObj = new URL(url);
      logo = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=64`;
    } catch (e) {
      console.error("Favicon otomatik olusturulamadi:", e);
    }
  }

  if (editingSourceId) {
    const src = sourcesData.find(s => s.id === editingSourceId);
    if (src) {
      src.name = name;
      src.url = url;
      src.category = category;
      src.logo = logo;
    }
  } else {
    sourcesData.push({
      id: "src_" + Date.now(),
      name, url, category, logo
    });
  }

  saveJSON("sourcesData", sourcesData);
  refreshCategoryDatalist();
  buildSourceFilterOptions();
  renderTabs();
  renderSourceListInModal();   // ← EKLEYİN
  closeModal();
}                                   // ✅ EKLENEN SATIR — saveSourceFromModal'ı kapatıyor

function deleteSource(sourceId) {

  if (!confirm("Bu kaynagi silmek istediginize emin misiniz?")) return;
  sourcesData = sourcesData.filter(s => s.id !== sourceId);
  saveJSON("sourcesData", sourcesData);
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

const saveModalBtn = document.getElementById("modalSaveBtn");      // ✅ düzeltildi
if (saveModalBtn) saveModalBtn.addEventListener("click", saveSourceFromModal);

const cancelModalBtn = document.getElementById("modalCancelBtn");  // ✅ düzeltildi
if (cancelModalBtn) cancelModalBtn.addEventListener("click", closeModal);


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
