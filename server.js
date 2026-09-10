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

// 1. Modeller
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
newsSchema.index({ pubDate: -1, createdAt: -1 });
const News = mongoose.model('News', newsSchema);

// Kaynak Modeli
const sourceSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  rss: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const Source = mongoose.model('Source', sourceSchema);

// Reklam Modeli (Sol ve Sağ Kule Banner)
const adSchema = new mongoose.Schema({
  position: { type: String, enum: ['left', 'right'], required: true, unique: true },
  type: { type: String, enum: ['code', 'custom'], default: 'custom' }, // 'code' (Google AdSense) veya 'custom' (Resim+Link)
  code: { type: String, default: '' }, // AdSense HTML/JS Kodu
  imageUrl: { type: String, default: '' },
  targetUrl: { type: String, default: '' },
  title: { type: String, default: 'Sponsorlu Reklam' },
  isActive: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now }
});
const Ad = mongoose.model('Ad', adSchema);

// 2. Veritabanı Bağlantısı ve Varsayılanları Oluşturma
const initialSources = [
  { name: 'NTV', rss: 'https://www.ntv.com.tr/son-dakika.rss' },
  { name: 'Ensonhaber', rss: 'https://www.ensonhaber.com/rss/ensonhaber.xml' },
  { name: 'BBC Türkçe', rss: 'https://feeds.bbci.co.uk/turkce/rss.xml' },
  { name: 'Hürriyet', rss: 'https://www.hurriyet.com.tr/rss/gundem' },
  { name: 'Milliyet', rss: 'https://www.milliyet.com.tr/rss/rssnew/sondakikarss.xml' },
  { name: 'Sözcü', rss: 'https://www.sozcu.com.tr/rss/tum-haberler.xml' },
  { name: 'Cumhuriyet', rss: 'https://www.cumhuriyet.com.tr/rss/son_dakika.xml' },
  { name: 'Habertürk', rss: 'https://www.haberturk.com/rss/kategori/gundem.xml' }
];

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
      console.log('MongoDB Atlas bağlantısı başarılı.');
      // İlk açılışta kaynak tablosu boşsa varsayılanları ekle
      const srcCount = await Source.countDocuments();
      if (srcCount === 0) {
        await Source.insertMany(initialSources);
        console.log('Varsayılan 8 haber kaynağı veritabanına eklendi.');
      }
      // Reklam kayıtlarını garantiye al
      for (const pos of ['left', 'right']) {
        const exist = await Ad.findOne({ position: pos });
        if (!exist) {
          await Ad.create({
            position: pos,
            type: 'custom',
            title: pos === 'left' ? 'Sol Reklam Alanı' : 'Sağ Reklam Alanı',
            imageUrl: 'https://placehold.co/160x600/1e293b/38bdf8?text=Reklam+Alanı',
            targetUrl: 'https://google.com',
            isActive: true
          });
        }
      }
    })
    .catch(err => console.error('MongoDB bağlantı hatası:', err.message));
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

// 3. RSS Motoru
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
    console.log(`[${sourceName}] RSS Hatası: ${error.message}`);
  }
}

let isSyncing = false;
async function fetchAllSources() {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const sources = await Source.find({ isActive: true });
    for (const src of sources) {
      await fetchRssFeed(src.name, src.rss);
    }
  } catch (err) {
    console.error("Kaynakları çekerken hata:", err.message);
  }
  isSyncing = false;
}

// 4. API Endpoints

// Haberleri Listele
app.get('/api/news', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 120;
    const query = {};
    if (req.query.sources) {
      const srcList = req.query.sources.split(',').filter(Boolean);
      if (srcList.length > 0) query.source = { $in: srcList };
    }
    if (req.query.search) {
      query.$or = [
        { title: { $regex: req.query.search, $options: 'i' } },
        { description: { $regex: req.query.search, $options: 'i' } }
      ];
    }
    const news = await News.find(query).sort({ pubDate: -1, createdAt: -1 }).limit(limit).maxTimeMS(4000);
    res.json({ success: true, count: news.length, data: news });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

// Kaynak Yönetimi API
app.get('/api/sources', async (req, res) => {
  try {
    const sources = await Source.find().sort({ name: 1 });
    res.json({ success: true, data: sources });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sources', async (req, res) => {
  try {
    const { name, rss } = req.body;
    if (!name || !rss) return res.status(400).json({ success: false, message: 'İsim ve RSS linki zorunludur.' });
    const newSource = await Source.create({ name, rss });
    fetchAllSources(); // Yeni kaynağı anında tara
    res.json({ success: true, data: newSource });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/sources/:id', async (req, res) => {
  try {
    await Source.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Kaynak silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/sources/:id/toggle', async (req, res) => {
  try {
    const src = await Source.findById(req.params.id);
    if (!src) return res.status(404).json({ success: false, message: 'Kaynak bulunamadı' });
    src.isActive = !src.isActive;
    await src.save();
    res.json({ success: true, data: src });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reklam Yönetimi API
app.get('/api/ads', async (req, res) => {
  try {
    const ads = await Ad.find();
    res.json({ success: true, data: ads });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ads', async (req, res) => {
  try {
    const { position, type, code, imageUrl, targetUrl, title, isActive } = req.body;
    const ad = await Ad.findOneAndUpdate(
      { position },
      { type, code, imageUrl, targetUrl, title, isActive, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, data: ad });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Senkronizasyon Tetikleyici
app.get('/api/sync', (req, res) => {
  fetchAllSources();
  res.json({ success: true, message: "Tarama arka planda baslatildi." });
});

setInterval(fetchAllSources, 10 * 60 * 1000);
setTimeout(fetchAllSources, 4000);

app.listen(PORT, () => {
  console.log(`Haber Takip Web Sunucusu http://localhost:${PORT} portunda calisiyor.`);
});
