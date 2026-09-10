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
  description: String,
  pubDate: { type: Date, default: Date.now },
  source: String,
  category: String,
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

// 3. RSS Çekme Mantığı
async function fetchRssFeed(sourceName, url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(response.data);
    const channel = result.rss ? result.rss.channel : (result.feed || {});
    const items = channel.item || channel.entry || [];
    const itemList = Array.isArray(items) ? items : [items];

    let savedCount = 0;
    for (const item of itemList) {
      if (!item.title) continue;
      const guid = item.guid ? (typeof item.guid === 'object' ? item.guid._ : item.guid) : (item.link || item.id);
      const link = typeof item.link === 'object' ? (item.link.$ ? item.link.$.href : item.link._) : item.link;
      const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

      if (!guid || !link) continue;

      try {
        await News.updateOne(
          { guid: String(guid) },
          {
            $setOnInsert: {
              guid: String(guid),
              title: item.title,
              link: String(link),
              description: item.description || '',
              pubDate: isNaN(pubDate.getTime()) ? new Date() : pubDate,
              source: sourceName,
              category: item.category || 'Genel'
            }
          },
          { upsert: true }
        );
        savedCount++;
      } catch (e) {}
    }
    console.log(`[${sourceName}] Cekildi. (${savedCount} yeni/guncel kayit islendi)`);
  } catch (error) {
    console.error(`[${sourceName}] RSS Hatasi:`, error.message);
  }
}

async function fetchAllSources() {
  console.log("RSS senkronizasyonu baslatiliyor...");
  try {
    const sourcesPath = path.join(__dirname, 'sources.json');
    if (!fs.existsSync(sourcesPath)) {
      console.warn("sources.json dosyasi bulunamadi!");
      return;
    }
    const raw = fs.readFileSync(sourcesPath, 'utf8');
    const sources = JSON.parse(raw);

    for (const [key, source] of Object.entries(sources)) {
      if (source.rss) {
        await fetchRssFeed(source.name || key, source.rss);
      }
    }
  } catch (err) {
    console.error("Kaynak okuma hatasi:", err.message);
  }
}

// 4. API Endpointleri
app.get('/api/news', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 60;
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

app.get('/api/sync', async (req, res) => {
  fetchAllSources();
  res.json({ success: true, message: "Senkronizasyon baslatildi." });
});

// Periyodik görev (10 dakikada bir)
setInterval(fetchAllSources, 10 * 60 * 1000);
setTimeout(fetchAllSources, 2000);

app.listen(PORT, () => {
  console.log(`Haber Takip Web Sunucusu http://localhost:${PORT} portunda calisiyor.`);
});
