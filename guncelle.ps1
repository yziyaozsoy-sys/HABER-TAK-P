# Haber Takip - Coklu Kaynak Guncelleme Script'i
$ErrorActionPreference = "Stop"

Write-Host "Guncelleme basliyor..." -ForegroundColor Cyan

# ============ renderer.js ============
$rendererContent = @'
const categories = {
"Gündem": [
  { name: "Hürriyet", url: "https://www.hurriyet.com.tr/rss/gundem", logo: "https://www.google.com/s2/favicons?domain=hurriyet.com.tr&sz=64" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/gundem.xml", logo: "https://www.google.com/s2/favicons?domain=sabah.com.tr&sz=64" },
  { name: "NTV", url: "https://www.ntv.com.tr/gundem.rss", logo: "https://www.google.com/s2/favicons?domain=ntv.com.tr&sz=64" },
  { name: "Sözcü", url: "https://www.sozcu.com.tr/feeds-rss-category-gundem", logo: "https://www.google.com/s2/favicons?domain=sozcu.com.tr&sz=64" }
],
"Ekonomi": [
  { name: "Hürriyet", url: "https://www.hurriyet.com.tr/rss/ekonomi", logo: "https://www.google.com/s2/favicons?domain=hurriyet.com.tr&sz=64" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/ekonomi.xml", logo: "https://www.google.com/s2/favicons?domain=sabah.com.tr&sz=64" },
  { name: "Sözcü", url: "https://www.sozcu.com.tr/feeds-rss-category-ekonomi", logo: "https://www.google.com/s2/favicons?domain=sozcu.com.tr&sz=64" }
],
"Spor": [
  { name: "Hürriyet", url: "https://www.hurriyet.com.tr/rss/sporarena", logo: "https://www.google.com/s2/favicons?domain=hurriyet.com.tr&sz=64" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/spor.xml", logo: "https://www.google.com/s2/favicons?domain=sabah.com.tr&sz=64" }
],
"Teknoloji": [
  { name: "Hürriyet", url: "https://www.hurriyet.com.tr/rss/teknoloji", logo: "https://www.google.com/s2/favicons?domain=hurriyet.com.tr&sz=64" },
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
      <span class="dot">•</span>
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
Write-Host "renderer.js guncellendi!" -ForegroundColor Green

# ============ style.css ============
$styleContent = @'
* { box-sizing: border-box; }
body {
font-family: "Segoe UI", Arial, sans-serif;
background: #1e1e2f;
color: #f0f0f0;
margin: 0;
padding: 0;
}
header {
display: flex;
justify-content: space-between;
align-items: center;
background: #2b2b40;
padding: 16px 24px;
border-bottom: 2px solid #444;
}
header h1 { margin: 0; font-size: 20px; }
#refreshBtn {
background: #4a90d9;
color: white;
border: none;
padding: 8px 16px;
border-radius: 6px;
cursor: pointer;
font-size: 14px;
}
#refreshBtn:hover { background: #357abd; }
#tabs {
display: flex;
gap: 8px;
padding: 12px 24px;
background: #24243a;
overflow-x: auto;
}
.tab-btn {
background: #333350;
color: #ccc;
border: none;
padding: 8px 14px;
border-radius: 20px;
cursor: pointer;
white-space: nowrap;
}
.tab-btn.active { background: #4a90d9; color: white; }
main { padding: 20px 24px; }
#status { margin-bottom: 12px; color: #aaa; font-size: 14px; }
#newsList { display: grid; gap: 12px; }
.news-card {
background: #2b2b40;
border-radius: 10px;
padding: 14px 18px;
border-left: 4px solid #4a90d9;
}
.source-row {
display: flex;
align-items: center;
gap: 8px;
margin-bottom: 8px;
}
.source-logo {
width: 18px;
height: 18px;
border-radius: 4px;
object-fit: contain;
background: white;
padding: 2px;
}
.source-name {
font-size: 12px;
font-weight: 600;
color: #4a90d9;
text-transform: uppercase;
letter-spacing: 0.5px;
}
.dot { color: #666; font-size: 12px; }
.time-badge {
font-size: 12px;
color: #999;
background: #1e1e2f;
padding: 2px 8px;
border-radius: 10px;
}
.news-card a {
color: #f0f0f0;
text-decoration: none;
font-weight: 600;
font-size: 16px;
}
.news-card a:hover { color: #4a90d9; }
.news-card .snippet {
font-size: 13px;
color: #ccc;
margin-top: 8px;
}
'@

Set-Content -Path ".\style.css" -Value $styleContent -Encoding UTF8
Write-Host "style.css guncellendi!" -ForegroundColor Green

# ============ Dogrulama ============
Write-Host "`nDogrulama yapiliyor..." -ForegroundColor Cyan
$check = Select-String -Path ".\renderer.js" -Pattern "categories" -Quiet
if ($check) {
  Write-Host "BASARILI: renderer.js dogru sekilde guncellendi." -ForegroundColor Green
} else {
  Write-Host "HATA: renderer.js guncellenemedi, tekrar deneyin." -ForegroundColor Red
}

Write-Host "`nTum islemler tamamlandi. Simdi 'npm start' ile uygulamayi baslatabilirsiniz." -ForegroundColor Yellow