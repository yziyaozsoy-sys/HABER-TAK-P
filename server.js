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

// Hem pubDate hem createdAt için indexleme (hızlı sıralama)
newsSchema.index({ pubDate: -1, createdAt: -1 });

const News = mongoose.model('News', newsSchema);

// 2. Veritabanı Bağlantısı
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
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

// 3. RSS Çekme
async function fetchRssFeed(sourceName, url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 8000
    });

    const parser = new xml2js.Parser({ explicitArray: false, trim: true });
    const result = await parser.parseStringPromise(response.data);
    const channel = result.rss ? result.rss.channel : (result.feed || {});
    const items = channel.item || channel.entry || [];
    const itemList = (Array.isArray(items) ? items : [items]).slice(0, 20);

    for (const item of itemList) {
      const rawTitle = extractText(item.title);
      if (!rawTitle) continue;

      let rawLink = typeof item.link === 'string' ? item.link : (item.link?.$?.href || extractText(item.link));
      let rawGuid = extractText(item.guid) || rawLink || rawTitle;
      const rawDesc = extractText(item.description || item.summary || '');
      
      let parsedDate = new Date();
      if (item.pubDate) {
        const d = new Date(item.pubDate);
        if (!isNaN(d.getTime())) parsedDate = d;
      }

      if (!rawGuid || !rawLink) continue;

      await News.updateOne(
        { guid: String(rawGuid) },
        {
          $setOnInsert: {
            guid: String(rawGuid),
            title: rawTitle,
            link: String(rawLink),
            description: rawDesc,
            pubDate: parsedDate,
            source: sourceName,
            category: 'Gündem',
            createdAt: new Date()
          }
        },
        { upsert: true }
      ).catch(() => {});
    }
  } catch (error) {
    console.log(`[${sourceName}] RSS Hatasi: ${error.message}`);
  }
}

const defaultSources = [
  { name: 'NTV', rss: 'https://www.ntv.com.tr/son-dakika.rss' },
  { name: 'Ensonhaber', rss: 'https://www.ensonhaber.com/rss/ensonhaber.xml' },
  { name: 'BBC Türkçe', rss: 'https://feeds.bbci.co.uk/turkce/rss.xml' },
  { name: 'Hürriyet', rss: 'https://www.hurriyet.com.tr/rss/gundem' },
  { name: 'Milliyet', rss: 'https://www.milliyet.com.tr/rss/rssnew/sondakikarss.xml' }
];

let isSyncing = false;
async function fetchAllSources() {
  if (isSyncing) return;
  isSyncing = true;
  for (const src of defaultSources) {
    await fetchRssFeed(src.name, src.rss);
  }
  isSyncing = false;
}

// 4. API Endpointleri
// Mevcut kaynakları listele
app.get('/api/sources', async (req, res) => {
  try {
    const sources = await News.distinct('source');
    res.json({ success: true, data: sources });
  } catch (err) {
    res.json({ success: true, data: defaultSources.map(s => s.name) });
  }
});

// Haberleri getir (geliş / yayın sırasına göre sıralı)
app.get('/api/news', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const query = {};
    
    // Çoklu kaynak filtreleme (virgülle ayrılmış: NTV,BBC)
    if (req.query.sources) {
      const srcList = req.query.sources.split(',').filter(Boolean);
      if (srcList.length > 0) {
        query.source = { $in: srcList };
      }
    }

    if (req.query.search) {
      query.$or = [
        { title: { $regex: req.query.search, $options: 'i' } },
        { description: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    // Kesin sıralama: En son gelen/yayınlanan en üstte
    const news = await News.find(query).sort({ pubDate: -1, createdAt: -1 }).limit(limit).maxTimeMS(4000);
    res.json({ success: true, count: news.length, data: news });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

app.get('/api/sync', (req, res) => {
  fetchAllSources();
  res.json({ success: true, message: "Tarama arka planda baslatildi." });
});

setInterval(fetchAllSources, 10 * 60 * 1000);
setTimeout(fetchAllSources, 4000);

app.listen(PORT, () => {
  console.log(`Haber Takip Web Sunucusu ${PORT} portunda calisiyor.`);
});
