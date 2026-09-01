$ErrorActionPreference = "Stop"
Write-Host "renderer.js encoding duzeltmesi basliyor..." -ForegroundColor Cyan

$rendererContent = @'
const categories = {
"G\u00fcndem": [
  { name: "H\u00fcrriyet", url: "https://www.hurriyet.com.tr/rss/gundem", logo: "https://www.google.com/s2/favicons?domain=hurriyet.com.tr&sz=64" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/gundem.xml", logo: "https://www.google.com/s2/favicons?domain=sabah.com.tr&sz=64" },
  { name: "NTV", url: "https://www.ntv.com.tr/gundem.rss", logo: "https://www.google.com/s2/favicons?domain=ntv.com.tr&sz=64" },
  { name: "S\u00f6zc\u00fc", url: "https://www.sozcu.com.tr/feeds-rss-category-gundem", logo: "https://www.google.com/s2/favicons?domain=sozcu.com.tr&sz=64" }
],
"Ekonomi": [
  { name: "H\u00fcrriyet", url: "https://www.hurriyet.com.tr/rss/ekonomi", logo: "https://www.google.com/s2/favicons?domain=hurriyet.com.tr&sz=64" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/ekonomi.xml", logo: "https://www.google.com/s2/favicons?domain=sabah.com.tr&sz=64" },
  { name: "S\u00f6zc\u00fc", url: "https://www.sozcu.com.tr/feeds-rss-category-ekonomi", logo: "https://www.google.com/s2/favicons?domain=sozcu.com.tr&sz=64" }
],
"Spor": [
  { name: "H\u00fcrriyet", url: "https://www.hurriyet.com.tr/rss/sporarena", logo: "https://www.google.com/s2/favicons?domain=hurriyet.com.tr&sz=64" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/spor.xml", logo: "https://www.google.com/s2/favicons?domain=sabah.com.tr&sz=64" }
],
"Teknoloji": [
  { name: "H\u00fcrriyet", url: "https://www.hurriyet.com.tr/rss/teknoloji", logo: "https://www.google.com/s2/favicons?domain=hurriyet.com.tr&sz=64" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/teknoloji.xml", logo: "https://www.google.com/s2/favicons?domain=sabah.com.tr&sz=64" }
]
};

const tabsEl = document.getElementById("tabs");
const statusEl = document.getElementById("status");
const newsListEl = document.getElementById("newsList");
const refreshBtn = document.getElementById("refreshBtn");

let activeTab = Object.keys(categories)[0];

function renderTabs() {
tabsEl.innerHTML = "";
Object.keys(categories).forEach(name => {
  const btn = document.createElement("button");
  btn.className = "tab-btn" + (name === activeTab ? " active" : "");
  btn.textContent = name;
  btn.onclick = () => {
    activeTab = name;
    renderTabs();
    loadCategory(activeTab);
  };
  tabsEl.appendChild(btn);
});
}

function formatDate(dateStr) {
if (!dateStr) return "";
const d = new Date(dateStr);
if (isNaN(d.getTime())) return dateStr;
return d.toLocaleString("tr-TR", {
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit"
});
}

function renderNews(items) {
newsListEl.innerHTML = "";
if (!items || items.length === 0) {
  newsListEl.innerHTML = "<p>Haber bulunamadi.</p>";
  return;
}
items.forEach(item => {
  const card = document.createElement("div");
  card.className = "news-card";
  card.innerHTML = `
    <div class="source-row">
      <img src="${item.sourceLogo}" class="source-logo" onerror="this.style.display='none'" />
      <span class="source-name">${item.sourceName}</span>
      <span class="dot">\u2022</span>
      <span class="time-badge">${formatDate(item.pubDate)}</span>
    </div>
    <a href="${item.link}" target="_blank">${item.title}</a>
    <div class="snippet">${item.contentSnippet || ""}</div>
  `;
  newsListEl.appendChild(card);
});
}

async function loadCategory(categoryName) {
const sources = categories[categoryName];
statusEl.textContent = `Yukleniyor: ${categoryName} (${sources.length} kaynak)...`;
newsListEl.innerHTML = "";

const results = await Promise.all(
  sources.map(src => window.api.fetchRSS(src.url).then(res => ({ ...res, src })))
);

let allItems = [];
let successCount = 0;
let failCount = 0;

results.forEach(res => {
  if (res.success) {
    successCount++;
    const tagged = res.items.map(item => ({
      ...item,
      sourceName: res.src.name,
      sourceLogo: res.src.logo
    }));
    allItems = allItems.concat(tagged);
  } else {
    failCount++;
  }
});

allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

statusEl.textContent = `${categoryName}: ${allItems.length} haber (${successCount} kaynak basarili${failCount > 0 ? ", " + failCount + " kaynak yanit vermedi" : ""})`;

renderNews(allItems);
}

refreshBtn.addEventListener("click", () => loadCategory(activeTab));

renderTabs();
loadCategory(activeTab);
'@

Set-Content -Path ".\renderer.js" -Value $rendererContent -Encoding UTF8
Write-Host "renderer.js guncellendi (Unicode kacis kodlariyla)!" -ForegroundColor Green

$check = Select-String -Path ".\renderer.js" -Pattern "u00fc" -Quiet
if ($check) {
  Write-Host "DOGRULAMA BASARILI." -ForegroundColor Green
} else {
  Write-Host "UYARI: Dogrulama basarisiz, dosyayi kontrol edin." -ForegroundColor Red
}

Write-Host "`nSimdi 'npm start' ile uygulamayi baslatin." -ForegroundColor Yellow