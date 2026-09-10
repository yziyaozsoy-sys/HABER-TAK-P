require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');

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
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000 // 5 saniyede MongoDB yanıt vermezse kilitlenme
  })
  .then(() => console.log('MongoDB Atlas baglantisi basarili.'))
  .catch(err => console.error('MongoDB baglanti hatasi:', err.message));
}

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

// 3. Hafif ve Hızlı RSS Çekici
async function fetchRssFeed(sourceName, url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 6000 // Hızlı zaman aşımı (sunucuyu bekletmez)
    });

    const parser = new xml2js.Parser({ explicitArray: false, trim: true });
    const result = await parser.parseStringPromise(response.data);
    const channel = result.rss ? result.rss.channel : (result.feed || {});
    const items = channel.item || channel.entry || [];
    const itemList = (Array.isArray(items) ? items : [items]).slice(0, 15); // İlk 15 haber (hız için)

    for (const item of itemList) {
      const rawTitle = extractText(item.title);
      if (!rawTitle) continue;

      let rawLink = typeof item.link === 'string' ? item.link : (item.link?.$?.href || extractText(item.link));
      let rawGuid = extractText(item.guid) || rawLink || rawTitle;
      const rawDesc = extractText(item.description || item.summary || '');
      const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

      if (!rawGuid || !rawLink) continue;

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
            category: 'Gündem'
          }
        },
        { upsert: true }
      ).catch(() => {});
    }
    console.log(`[${sourceName}] Basariyla cekildi.`);
  } catch (error) {
    console.log(`[${sourceName}] RSS Atlaniyor: ${error.message}`);
  }
}

// En hızlı açılan güvenilir RSS kaynakları
const fastSources = [
  { name: 'NTV', rss: 'https://www.ntv.com.tr/son-dakika.rss' },
  { name: 'Ensonhaber', rss: 'https://www.ensonhaber.com/rss/ensonhaber.xml' },
  { name: 'BBC Türkçe', rss: 'https://feeds.bbci.co.uk/turkce/rss.xml' }
];

let isSyncing = false;
async function fetchAllSources() {
  if (isSyncing) return;
  isSyncing = true;
  console.log("RSS senkronizasyonu basladi...");
  
  for (const src of fastSources) {
    await fetchRssFeed(src.name, src.rss);
  }
  
  console.log("RSS senkronizasyonu bitti.");
  isSyncing = false;
}

// 4. API Endpointleri
app.get('/api/news', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const query = {};
    if (req.query.search) {
      query.title = { $regex: req.query.search, $options: 'i' };
    }
    // Maksimum 3 saniye sorgu süresi
    const news = await News.find(query).sort({ pubDate: -1 }).limit(limit).maxTimeMS(4000);
    res.json({ success: true, count: news.length, data: news });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

// Senkronizasyonu arka planda tetikler ve ANINDA yanıt döner (504 yemez!)
app.get('/api/sync', (req, res) => {
  fetchAllSources(); // Arka planda başlar, kullanıcıyı bekletmez
  res.json({ success: true, message: "Tarama arka planda baslatildi." });
});

// Periyodik görev (15 dakikada bir)
setInterval(fetchAllSources, 15 * 60 * 1000);

// Sunucu açıldıktan 5 saniye sonra ilk taramayı sessizce yap
setTimeout(fetchAllSources, 5000);

app.listen(PORT, () => {
  console.log(`Haber Takip Web Sunucusu ${PORT} portunda calisiyor.`);
});
