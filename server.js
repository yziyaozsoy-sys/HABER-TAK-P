require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'haber-takip-gizli-anahtar-2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. VERİ MODELLERİ (SCHEMAS)
const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  createdAt: { type: Date, default: Date.now }
});
const Category = mongoose.model('Category', categorySchema);

const newsSchema = new mongoose.Schema({
  guid: { type: String, unique: true, required: true, index: true },
  title: { type: String, required: true },
  link: { type: String, required: true },
  description: { type: String, default: '' },
  pubDate: { type: Date, default: Date.now, index: true },
  source: { type: String, default: 'Genel', index: true },
  category: { type: String, default: 'Gündem', index: true },
  lang: { type: String, default: 'tr' },
  isTranslated: { type: Boolean, default: false },
  views: { type: Number, default: 0, index: true },
  createdAt: { type: Date, default: Date.now, index: true }
});

// İndeksler & 24 SAAT TTL KURALI (86.400 Saniye sonra Mongo otomatik siler)
newsSchema.index({ pubDate: -1 });
newsSchema.index({ views: -1 });
newsSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

const News = mongoose.model('News', newsSchema);

const sourceSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  type: { type: String, enum: ['rss', 'html'], default: 'rss' },
  url: { type: String, required: true },
  selector: { type: String, default: '' },
  category: { type: String, default: 'Gündem' },
  lang: { type: String, enum: ['tr', 'en'], default: 'tr' },
  isActive: { type: Boolean, default: true, index: true },
  createdAt: { type: Date, default: Date.now }
});
const Source = mongoose.model('Source', sourceSchema);

const adSchema = new mongoose.Schema({
  position: { type: String, enum: ['left', 'right'], required: true, unique: true },
  type: { type: String, enum: ['code', 'custom'], default: 'custom' },
  code: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  targetUrl: { type: String, default: '' },
  title: { type: String, default: 'Sponsorlu Reklam' },
  isActive: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now }
});
const Ad = mongoose.model('Ad', adSchema);

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  fullname: { type: String, required: true },
  role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const requestSchema = new mongoose.Schema({
  email: { type: String, required: true },
  subject: { type: String, default: 'Genel Talep' },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Request = mongoose.model('Request', requestSchema);

// Yetki Doğrulama Ara Yazılımı (JWT)
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'Yetkisiz erişim. Lütfen giriş yapın.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Geçersiz veya süresi dolmuş oturum.' });
  }
};

// 2. BAŞLANGIÇ VERİLERİ (SEED)
const defaultCategories = ['Gündem', 'Spor', 'Ekonomi', 'Dünya', 'Teknoloji', 'Magazin', 'Sağlık', 'Eğitim'];
const initialSources = [
  { name: 'BBC Türkçe', type: 'rss', url: 'https://feeds.bbci.co.uk/turkce/rss.xml', category: 'Gündem', lang: 'tr' },
  { name: 'Cumhuriyet', type: 'rss', url: 'https://www.cumhuriyet.com.tr/rss/son_dakika.xml', category: 'Gündem', lang: 'tr' },
  { name: 'Ensonhaber', type: 'rss', url: 'https://www.ensonhaber.com/rss/ensonhaber.xml', category: 'Gündem', lang: 'tr' },
  { name: 'Habertürk', type: 'rss', url: 'https://www.haberturk.com/rss/kategori/gundem.xml', category: 'Gündem', lang: 'tr' },
  { name: 'Hürriyet', type: 'rss', url: 'https://www.hurriyet.com.tr/rss/gundem', category: 'Gündem', lang: 'tr' },
  { name: 'Milliyet', type: 'rss', url: 'https://www.milliyet.com.tr/rss/rssnew/sondakikarss.xml', category: 'Gündem', lang: 'tr' },
  { name: 'NTV', type: 'rss', url: 'https://www.ntv.com.tr/son-dakika.rss', category: 'Gündem', lang: 'tr' },
  { name: 'Sabah', type: 'rss', url: 'https://www.sabah.com.tr/rss/gundem.xml', category: 'Gündem', lang: 'tr' },
  { name: 'Sözcü', type: 'rss', url: 'https://www.sozcu.com.tr/rss/tum-haberler.xml', category: 'Gündem', lang: 'tr' },
  { name: 'Ekonomi Gazetesi', type: 'rss', url: 'https://www.ekonomim.com/rss.xml', category: 'Ekonomi', lang: 'tr' },
  { name: 'Ntv Ekonomi', type: 'rss', url: 'https://www.ntv.com.tr/ekonomi.rss', category: 'Ekonomi', lang: 'tr' },
  { name: 'Patronlar Dünyası', type: 'rss', url: 'https://www.patronlardunyasi.com/rss', category: 'Ekonomi', lang: 'tr' },
  { name: 'Sözcü Ekonomi', type: 'rss', url: 'https://www.sozcu.com.tr/feeds-rss-category-ekonomi', category: 'Ekonomi', lang: 'tr' },
  { name: 'Sözcü Magazin', type: 'rss', url: 'https://www.sozcu.com.tr/feeds-rss-category-magazin', category: 'Magazin', lang: 'tr' },
  { name: 'Ajansspor', type: 'rss', url: 'https://ajansspor.com/rss', category: 'Spor', lang: 'tr' },
  { name: 'Aspor', type: 'rss', url: 'https://www.aspor.com.tr/rss/anasayfa.xml', category: 'Spor', lang: 'tr' },
  { name: 'Sabah Spor', type: 'rss', url: 'https://www.sabah.com.tr/rss/spor.xml', category: 'Spor', lang: 'tr' },
  { name: 'Herkese Bilim Teknoloji', type: 'rss', url: 'https://www.herkesebilimteknoloji.com/feed', category: 'Teknoloji', lang: 'tr' }
];

// 24 Saatten Eski Haberleri Düzenli Temizleyen Arka Plan Görevi
setInterval(async () => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await News.deleteMany({
      $and: [
        { pubDate: { $lt: twentyFourHoursAgo } },
        { createdAt: { $lt: twentyFourHoursAgo } }
      ]
    });
    if (result.deletedCount > 0) {
      console.log(`[24 SAAT TEMİZLİĞİ] ${result.deletedCount} adet eski haber silindi.`);
    }
  } catch (err) {
    console.error('[TEMİZLİK HATASI]:', err.message);
  }
}, 30 * 60 * 1000); // 30 dakikada bir kontrol eder

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
      console.log('MongoDB Atlas bağlantısı başarılı.');

      // İlk çalıştırmada da 24 saatten eski haberleri temizle
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await News.deleteMany({
        $and: [
          { pubDate: { $lt: twentyFourHoursAgo } },
          { createdAt: { $lt: twentyFourHoursAgo } }
        ]
      }).catch(() => {});

      const adminExist = await User.findOne({ username: 'admin' });
      if (!adminExist) {
        const hashedPassword = await bcrypt.hash('123456', 10);
        await User.create({
          username: 'admin',
          password: hashedPassword,
          fullname: 'Yusuf Yöneticisi',
          role: 'admin'
        });
        console.log('Süper Admin oluşturuldu: admin / 123456');
      }

      const catCount = await Category.countDocuments();
      if (catCount === 0) {
        for (const c of defaultCategories) {
          await Category.create({ name: c }).catch(() => {});
        }
      }

      const srcCount = await Source.countDocuments();
      if (srcCount === 0) {
        await Source.insertMany(initialSources);
      }

      for (const pos of ['left', 'right']) {
        const exist = await Ad.findOne({ position: pos });
        if (!exist) {
          await Ad.create({
            position: pos,
            type: 'custom',
            title: pos === 'left' ? 'Sol Reklam Alanı' : 'Sağ Reklam Alanı',
            imageUrl: 'https://placehold.co/160x600/1e293b/38bdf8?text=Reklam+Alani',
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

async function translateToTurkish(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return '';
  const clean = text.replace(/<[^>]*>?/gm, '').trim();
  if (clean.length === 0) return '';
  
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=${encodeURIComponent(clean)}`;
    const res = await axios.get(url, { timeout: 4000 });
    if (res.data && Array.isArray(res.data[0])) {
      return res.data[0].map(segment => segment[0]).join('');
    }
    return clean;
  } catch (e) {
    return clean;
  }
}

// 3. TARAMA MOTORLARI (RSS & HTML)
async function fetchRssFeed(sourceName, rawUrl, categoryName = 'Gündem', lang = 'tr') {
  const url = rawUrl ? rawUrl.trim() : '';
  if (!url) return;

  try {
    const response = await axios.get(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000
    });

    const parser = new xml2js.Parser({ explicitArray: false, trim: true });
    const result = await parser.parseStringPromise(response.data);
    const channel = result.rss ? result.rss.channel : (result.feed || {});
    const items = channel.item || channel.entry || [];
    const itemList = (Array.isArray(items) ? items : [items]).slice(0, 30);

    let count = 0;
    for (const item of itemList) {
      let rawTitle = extractText(item.title);
      if (!rawTitle) continue;

      let rawLink = typeof item.link === 'string' ? item.link : (item.link?.$.href || extractText(item.link));
      let rawGuid = extractText(item.guid) || rawLink || rawTitle;
      let rawDesc = extractText(item.description || item.summary || '');
      
      let rawDateStr = item.pubDate || item['dc:date'] || item.published || item.updated;
      let parsedDate = new Date();
      if (rawDateStr) {
        const d = new Date(rawDateStr);
        if (!isNaN(d.getTime())) {
          parsedDate = d;
        }
      }

      if (!rawGuid || !rawLink) continue;

      const isEnglish = (lang === 'en');
      let finalTitle = rawTitle;
      let finalDesc = rawDesc;
      let isTranslated = false;

      if (isEnglish) {
        try {
          finalTitle = await translateToTurkish(rawTitle);
          if (rawDesc) {
            finalDesc = await translateToTurkish(rawDesc);
          }
          isTranslated = true;
        } catch (trErr) {
          finalTitle = rawTitle;
        }
      }

      try {
        await News.updateOne(
          { guid: String(rawGuid) },
          {
            $set: {
              title: finalTitle,
              link: String(rawLink),
              description: finalDesc,
              pubDate: parsedDate,
              source: sourceName,
              category: categoryName,
              lang: lang || 'tr',
              isTranslated: isTranslated
            },
            $setOnInsert: {
              guid: String(rawGuid),
              views: 0,
              createdAt: new Date()
            }
          },
          { upsert: true }
        );
        count++;
      } catch (dbErr) {
        console.error(`[DB HATA - ${sourceName}]:`, dbErr.message);
      }
    }
    console.log(`[RSS Tamam] ${sourceName}: ${count} haber işlendi.`);
  } catch (error) {
    console.log(`[${sourceName} - RSS Hatası]: ${error.message}`);
  }
}

async function scrapeHtmlSite(sourceName, siteUrl, categoryName = 'Gündem', customSelector = '', lang = 'tr') {
  if (!siteUrl) return;
  try {
    const response = await axios.get(siteUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const parsedUrl = new URL(siteUrl);
    const origin = parsedUrl.origin;

    const scrapedList = [];
    const seenLinks = new Set();

    const targetSelector = customSelector && customSelector.trim() 
      ? customSelector 
      : 'article a, .news-item a, .card a, h2 a, h3 a, a[href*="/haber/"], a[href*="/son-dakika/"], a[href*=".html"]';

    $(targetSelector).each((i, el) => {
      if (scrapedList.length >= 30) return false;

      const title = $(el).text().replace(/\s+/g, ' ').trim() || $(el).attr('title') || '';
      let href = $(el).attr('href');

      if (!title || title.length < 15 || !href) return;

      if (href.startsWith('/')) {
        href = origin + href;
      } else if (!href.startsWith('http')) {
        href = origin + '/' + href;
      }

      if (seenLinks.has(href)) return;
      seenLinks.add(href);

      scrapedList.push({
        guid: href,
        title,
        link: href,
        description: '',
        pubDate: new Date(),
        source: sourceName,
        category: categoryName,
        lang: lang || 'tr',
        views: 0
      });
    });

    for (const item of scrapedList) {
      let finalTitle = item.title;
      let isTranslated = false;

      if (lang === 'en') {
        try {
          finalTitle = await translateToTurkish(item.title);
          isTranslated = true;
        } catch (trErr) {
          finalTitle = item.title;
        }
      }

      try {
        await News.updateOne(
          { guid: item.guid },
          {
            $set: {
              title: finalTitle,
              link: item.link,
              description: '',
              pubDate: item.pubDate,
              source: item.source,
              category: item.category,
              lang: item.lang,
              isTranslated: isTranslated
            },
            $setOnInsert: {
              guid: item.guid,
              views: 0,
              createdAt: new Date()
            }
          },
          { upsert: true }
        );
      } catch (err) {}
    }
    console.log(`[HTML Tamam] ${sourceName}: ${scrapedList.length} haber işlendi.`);
  } catch (err) {
    console.log(`[${sourceName} - HTML Hatası]: ${err.message}`);
  }
}

async function syncAllSources() {
  console.log('--- Kaynak Taraması Başlatıldı ---');
  try {
    const activeSources = await Source.find({ isActive: true });
    for (const src of activeSources) {
      if (src.type === 'rss') {
        await fetchRssFeed(src.name, src.url, src.category, src.lang);
      } else if (src.type === 'html') {
        await scrapeHtmlSite(src.name, src.url, src.category, src.selector, src.lang);
      }
    }
    console.log('--- Kaynak Taraması Tamamlandı ---');
  } catch (err) {
    console.error('Tarama döngüsü hatası:', err.message);
  }
}

// 4. API ENDPOINT'LERİ

// GÜVENLİ ÇEVİRİ MOTORU (CORS ENGELSİZ)
app.get('/api/translate', async (req, res) => {
  try {
    const text = req.query.text;
    if (!text) return res.json({ translatedText: '' });
    const translated = await translateToTurkish(text);
    res.json({ translatedText: translated });
  } catch (err) {
    res.status(500).json({ error: 'Çeviri başarısız' });
  }
});

// HABER LİSTELEME: SADECE SON 24 SAAT VE LİMİTSİZ (TÜM 24 SAAT)
app.get('/api/news', async (req, res) => {
  try {
    const { category, source, search, sort } = req.query;

    // 1. Son 24 saatin zaman eşiği
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    let filter = {
      $or: [
        { pubDate: { $gte: twentyFourHoursAgo } },
        { createdAt: { $gte: twentyFourHoursAgo } }
      ]
    };

    if (category && category !== 'Tümü') {
      filter.category = category;
    }

    if (source && source !== 'Tümü') {
      const srcList = source.split(',').map(s => s.trim()).filter(Boolean);
      if (srcList.length > 0) {
        filter.source = { $in: srcList };
      }
    }

    if (search && search.trim()) {
      filter.$or = [
        { title: { $regex: search.trim(), $options: 'i' } },
        { description: { $regex: search.trim(), $options: 'i' } }
      ];
    }

    let sortObj = { pubDate: -1, createdAt: -1 };
    if (sort === 'rating') {
      sortObj = { views: -1, pubDate: -1 };
    }

    // 2. Limiti 120'den kaldırıp son 24 saatin tüm haberlerini (maksimum 1500) getiriyoruz
    const news = await News.find(filter)
      .sort(sortObj)
      .limit(1500)
      .lean();

    res.json(news);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Okunma / Tıklanma Sayacı Arttırma
app.post('/api/news/:id/click', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await News.findByIdAndUpdate(
      id,
      { $inc: { views: 1 } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Haber bulunamadı' });
    res.json({ success: true, views: updated.views });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Canlı Rating & Analitik Raporu
app.get('/api/analytics', async (req, res) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const filter24h = {
      $or: [
        { pubDate: { $gte: twentyFourHoursAgo } },
        { createdAt: { $gte: twentyFourHoursAgo } }
      ]
    };

    const totalNews = await News.countDocuments(filter24h);

    const viewsAgg = await News.aggregate([
      { $match: filter24h },
      { $group: { _id: null, totalViews: { $sum: '$views' } } }
    ]);
    const totalViews = viewsAgg.length > 0 ? viewsAgg[0].totalViews : 0;

    const topNews = await News.find(filter24h)
      .sort({ views: -1, pubDate: -1 })
      .limit(10)
      .select('title source category views pubDate link');

    const sourceStats = await News.aggregate([
      { $match: filter24h },
      {
        $group: {
          _id: '$source',
          totalViews: { $sum: '$views' },
          newsCount: { $sum: 1 }
        }
      },
      { $sort: { totalViews: -1, newsCount: -1 } }
    ]);

    const categoryStats = await News.aggregate([
      { $match: filter24h },
      {
        $group: {
          _id: '$category',
          totalViews: { $sum: '$views' },
          newsCount: { $sum: 1 }
        }
      },
      { $sort: { totalViews: -1 } }
    ]);

    res.json({
      totalNews,
      totalViews,
      topNews,
      sourceStats,
      categoryStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reklam Bilgisini Getir
app.get('/api/ads/:position', async (req, res) => {
  try {
    const { position } = req.params;
    const ad = await Ad.findOne({ position });
    res.json(ad || { isActive: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reklam Güncelle (Yetkili)
app.post('/api/ads/:position', authMiddleware, async (req, res) => {
  try {
    const { position } = req.params;
    const { type, code, imageUrl, targetUrl, title, isActive } = req.body;
    const updated = await Ad.findOneAndUpdate(
      { position },
      { type, code, imageUrl, targetUrl, title, isActive, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, ad: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Kategorileri Getir
app.get('/api/categories', async (req, res) => {
  try {
    const cats = await Category.find().sort({ name: 1 });
    res.json(cats.map(c => c.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kategori Ekle (Yetkili)
app.post('/api/categories', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Kategori adı boş olamaz' });
    const trimmed = name.trim();
    const exist = await Category.findOne({ name: trimmed });
    if (exist) return res.status(400).json({ success: false, message: 'Bu kategori zaten var' });
    await Category.create({ name: trimmed });
    res.json({ success: true, message: 'Kategori eklendi' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Kategori Sil (Yetkili)
app.delete('/api/categories/:name', authMiddleware, async (req, res) => {
  try {
    const { name } = req.params;
    await Category.findOneAndDelete({ name });
    res.json({ success: true, message: 'Kategori silindi' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Kaynakları Getir
app.get('/api/sources', async (req, res) => {
  try {
    const sources = await Source.find().sort({ name: 1 });
    res.json(sources);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kaynak Ekle (Yetkili)
app.post('/api/sources', authMiddleware, async (req, res) => {
  try {
    const { name, type, url, selector, category, lang } = req.body;
    if (!name || !url) return res.status(400).json({ success: false, message: 'Ad ve URL zorunludur' });
    const exist = await Source.findOne({ name: name.trim() });
    if (exist) return res.status(400).json({ success: false, message: 'Bu kaynak zaten var' });

    const newSrc = await Source.create({
      name: name.trim(),
      type: type || 'rss',
      url: url.trim(),
      selector: selector || '',
      category: category || 'Gündem',
      lang: lang || 'tr',
      isActive: true
    });

    if (newSrc.type === 'rss') {
      fetchRssFeed(newSrc.name, newSrc.url, newSrc.category, newSrc.lang);
    } else {
      scrapeHtmlSite(newSrc.name, newSrc.url, newSrc.category, newSrc.selector, newSrc.lang);
    }

    res.json({ success: true, message: 'Kaynak eklendi', source: newSrc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Kaynak Güncelle (Yetkili)
app.put('/api/sources/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, url, selector, category, lang } = req.body;
    const updated = await Source.findByIdAndUpdate(
      id,
      { name: name?.trim(), type, url: url?.trim(), selector, category, lang },
      { new: true }
    );
    res.json({ success: true, message: 'Kaynak güncellendi', source: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Kaynak Durumunu Aç/Kapat (Yetkili)
app.patch('/api/sources/:id/toggle', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const src = await Source.findById(id);
    if (!src) return res.status(404).json({ success: false, message: 'Kaynak bulunamadı' });
    src.isActive = !src.isActive;
    await src.save();
    res.json({ success: true, isActive: src.isActive });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Kaynak Sil (Yetkili)
app.delete('/api/sources/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await Source.findByIdAndDelete(id);
    res.json({ success: true, message: 'Kaynak silindi' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manuel Kaynak Senkronizasyonu Tetikleme
app.post('/api/sync', async (req, res) => {
  syncAllSources();
  res.json({ success: true, message: 'Tarama işlemi arka planda başlatıldı.' });
});

// Kullanıcı Talep & İstek Formu
app.post('/api/requests', async (req, res) => {
  try {
    const { email, subject, message } = req.body;
    if (!email || !message) {
      return res.status(400).json({ success: false, message: 'E-posta ve mesaj alanları zorunludur.' });
    }
    await Request.create({ email, subject, message });
    res.json({ success: true, message: 'Talebiniz başarıyla iletildi. Teşekkür ederiz!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Hata: ' + err.message });
  }
});

// Kullanıcı Taleplerini Listele (Yetkili)
app.get('/api/requests', authMiddleware, async (req, res) => {
  try {
    const requests = await Request.find().sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Talep Sil (Yetkili)
app.delete('/api/requests/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await Request.findByIdAndDelete(id);
    res.json({ success: true, message: 'Talep silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Personel Listesi (Yetkili)
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Personel Ekle (Yetkili)
app.post('/api/users', authMiddleware, async (req, res) => {
  try {
    const { username, password, fullname, role } = req.body;
    if (!username || !password || !fullname) {
      return res.status(400).json({ success: false, message: 'Tüm alanları doldurunuz.' });
    }
    const exist = await User.findOne({ username: username.trim() });
    if (exist) return res.status(400).json({ success: false, message: 'Bu kullanıcı adı zaten alınmış.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({
      username: username.trim(),
      password: hashedPassword,
      fullname: fullname.trim(),
      role: role || 'staff'
    });
    res.json({ success: true, message: 'Personel oluşturuldu.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Personel Sil (Yetkili)
app.delete('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });
    if (user.username === 'admin') {
      return res.status(400).json({ success: false, message: 'Ana süper yönetici silinemez!' });
    }
    await User.findByIdAndDelete(id);
    res.json({ success: true, message: 'Kullanıcı silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Şifre Değiştir (Giriş Yapan Kendi Şifresini Değiştirir)
app.post('/api/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 5) {
      return res.status(400).json({ success: false, message: 'Yeni şifre en az 5 karakter olmalıdır.' });
    }
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: 'Mevcut şifreniz hatalı.' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true, message: 'Şifreniz başarıyla güncellendi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Giriş Yap (Login)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Giriş bilgileri eksik.' });

    const user = await User.findOne({ username: username.trim() });
    if (!user) return res.status(401).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı.' });

    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, fullname: user.fullname },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user._id, username: user.username, fullname: user.fullname, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Otomatik Başlangıç Taraması ve Periyodik Güncelleme
syncAllSources();
setInterval(syncAllSources, 5 * 60 * 1000); // 5 dakikada bir otomatik tazeler

app.listen(PORT, () => {
  console.log(`Haber Takip Portalı http://localhost:${PORT} adresinde yayında!`);
});
