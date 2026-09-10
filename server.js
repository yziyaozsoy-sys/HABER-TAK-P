require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Model Tanımı
const newsSchema = new mongoose.Schema({
  guid: { type: String, unique: true, required: true },
  title: { type: String, required: true },
  link: { type: String, required: true },
  description: { type: String, default: '' },
  pubDate: { type: Date, default: Date.now },
  source: { type: String, default: 'Genel' },
  category: { type: String, default: 'Genel' },
  createdAt: { type: Date, default: Date.now }
});

const News = mongoose.model('News', newsSchema);

// 2. Veritabanı Bağlantısı
if (!MONGODB_URI) {
  console.error("UYARI: MONGODB_URI ortam degiskeni tanimlanmamis! .env dosyasini kontrol edin.");
} else {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB Atlas baglantisi basarili.'))
    .catch(err => console.error('MongoDB baglanti hatasi:', err.message));
}

// Güvenli Metin Ayıklayıcı (xml2js Obje veya CDATA döndüğünde string'e çevirir)
function extractText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'object') {
    if (val._) return String(val._).trim();
    if (val.$t) return String(val.$t).trim();
    if (Array.isArray(val) && val.length > 0) return extractText(val[0]);
  }
  return String(val).trim();
}

// 3. RSS Çekme Mantığı
async function fetchRssFeed(sourceName, url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 12000
    });

    const parser = new xml2js.Parser({ explicitArray: false, trim: true });
    const result = await parser.parseStringPromise(response.data);
    const channel = result.rss ? result.rss.channel : (result.feed || {});
    const items = channel.item || channel.entry || [];
    const itemList = Array.isArray(items) ? items : [items];

    let savedCount = 0;
    for (const item of itemList) {
      const rawTitle = extractText(item.title);
      if (!rawTitle) continue;

      let rawLink = '';
      if (typeof item.link === 'string') {
        rawLink = item.link;
      } else if (item.link && item.link.$ && item.link.$.href) {
        rawLink = item.link.$.href;
      } else {
        rawLink = extractText(item.link || item.id);
      }

      let rawGuid = extractText(item.guid) || rawLink || rawTitle;
      const rawDesc = extractText(item.description || item.summary || '');
      const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

      if (!rawGuid || !rawLink) continue;

      try {
        await News.updateOne(
          { guid: String(rawGuid) },
          {
            $setOnInsert: {
              guid: String(rawGuid),
              title: rawTitle,
              link: String(rawLink),
              description: rawDesc,
              pubDate: isNaN(pubDate.getTime()) ? new Date() : pubDate,
              source: sourceName,
              category: extractText(item.category) || 'Genel'
            }
          },
          { upsert: true }
        );
        savedCount++;
      } catch (e) {
        // Tekil anahtar çakışmalarını veya geçersiz verileri yoksay
      }
    }
    console.log(`[${sourceName}] Cekildi. (${savedCount} kayit islendi)`);
  } catch (error) {
    console.error(`[${sourceName}] RSS Hatasi:`, error.message);
  }
}

// Yedek / Varsayılan Güvenilir Kaynaklar (sources.json yoksa veya eksikse çalışır)
const defaultSources = [
  { name: 'NTV Son Dakika', rss: 'https://www.ntv.com.tr/son-dakika.rss' },
  { name: 'Hürriyet Gündem', rss: 'https://www.hurriyet.com.tr/rss/gundem' },
  { name: 'Milliyet Son Dakika', rss: 'https://www.milliyet.com.tr/rss/rssnew/sondakikarss.xml' },
  { name: 'Ensonhaber', rss: 'https://www.ensonhaber.com/rss/ensonhaber.xml' },
  { name: 'BBC Türkçe', rss: 'https://feeds.bbci.co.uk/turkce/rss.xml' },
  { name: 'Sözcü', rss: 'https://www.sozcu.com.tr/rss/tum-haberler.xml' }
];

async function fetchAllSources() {
  console.log("RSS senkronizasyonu baslatiliyor...");
  let sourcesToFetch = defaultSources;

  try {
    const sourcesPath = path.join(__dirname, 'sources.json');
    if (fs.existsSync(sourcesPath)) {
      const raw = fs.readFileSync(sourcesPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        sourcesToFetch = parsed;
      } else if (typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        sourcesToFetch = Object.entries(parsed).map(([k, v]) => ({
          name: v.name || k,
          rss: v.rss || v.url || v
        }));
      }
    }
  } catch (err) {
    console.warn("sources.json okunamadi, varsayilan kaynaklar kullaniliyor:", err.message);
  }

  for (const src of sourcesToFetch) {
    if (src.rss) {
      await fetchRssFeed(src.name, src.rss);
    }
  }
  console.log("RSS senkronizasyonu tamamlandi.");
}

// 4. API Endpointleri
app.get('/api/news', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 90;
    const query = {};
    if (req.query.source) query.source = req.query.source;
    if (req.query.search) {
      query.title = { $regex: req.query.search, $options: 'i' };
    }
    const news = await News.find(query).sort({ pubDate: -1 }).limit(limit);
    res.json({ success: true, count: news.length, data: news });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Senkronizasyonu tetikle ve bitmesini bekle
app.get('/api/sync', async (req, res) => {
  try {
    await fetchAllSources();
    const count = await News.countDocuments();
    res.json({ success: true, message: "Senkronizasyon tamamlandi.", totalNews: count });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Periyodik görev (10 dakikada bir)
setInterval(fetchAllSources, 10 * 60 * 1000);
// Sunucu basladiktan 3 saniye sonra otomatik ilk taramayi yap
setTimeout(fetchAllSources, 3000);

app.listen(PORT, () => {
  console.log(`Haber Takip Web Sunucusu http://localhost:${PORT} portunda calisiyor.`);
});
