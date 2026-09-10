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
  guid: { type: String, unique: true, required: true },
  title: { type: String, required: true },
  link: { type: String, required: true },
  description: { type: String, default: '' },
  pubDate: { type: Date, default: Date.now },
  source: { type: String, default: 'Genel', index: true },
  category: { type: String, default: 'Gündem', index: true },
  lang: { type: String, default: 'tr' },
  isTranslated: { type: Boolean, default: false },
  views: { type: Number, default: 0, index: true },
  createdAt: { type: Date, default: Date.now }
});
newsSchema.index({ pubDate: -1, createdAt: -1 });
newsSchema.index({ views: -1 });
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
  { name: 'NTV Son Dakika', type: 'rss', url: 'https://www.ntv.com.tr/son-dakika.rss', category: 'Gündem', lang: 'tr' },
  { name: 'Hürriyet Gündem', type: 'rss', url: 'https://www.hurriyet.com.tr/rss/gundem', category: 'Gündem', lang: 'tr' },
  { name: 'Ensonhaber', type: 'rss', url: 'https://www.ensonhaber.com/rss/ensonhaber.xml', category: 'Gündem', lang: 'tr' },
  { name: 'BBC Türkçe', type: 'rss', url: 'https://feeds.bbci.co.uk/turkce/rss.xml', category: 'Dünya', lang: 'tr' },
  { name: 'Milliyet Spor', type: 'rss', url: 'https://www.milliyet.com.tr/rss/rssnew/skorersondakikarss.xml', category: 'Spor', lang: 'tr' },
  { name: 'Hürriyet Ekonomi', type: 'rss', url: 'https://www.hurriyet.com.tr/rss/ekonomi', category: 'Ekonomi', lang: 'tr' },
  { name: 'Sözcü', type: 'rss', url: 'https://www.sozcu.com.tr/rss/tum-haberler.xml', category: 'Gündem', lang: 'tr' },
  { name: 'Reuters World', type: 'rss', url: 'https://feeds.reuters.com/reuters/worldNews', category: 'Dünya', lang: 'en' }
];

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
      console.log('MongoDB Atlas bağlantısı başarılı.');

      const adminExist = await User.findOne({ username: 'admin' });
      if (!adminExist) {
        const hashedPassword = await bcrypt.hash('123456', 10);
        await User.create({
          username: 'admin',
          password: hashedPassword,
          fullname: 'Yusuf Yönetici',
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

// Otomatik Türkçeye Çeviri Servisi
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache'
      },
      timeout: 7000
    });

    const parser = new xml2js.Parser({ explicitArray: false, trim: true });
    const result = await parser.parseStringPromise(response.data);
    const channel = result.rss ? result.rss.channel : (result.feed || {});
    const items = channel.item || channel.entry || [];
    const itemList = (Array.isArray(items) ? items : [items]).slice(0, 25);

    let count = 0;
    for (const item of itemList) {
      let rawTitle = extractText(item.title);
      if (!rawTitle) continue;

      let rawLink = typeof item.link === 'string' ? item.link : (item.link?.$?.href || extractText(item.link));
      let rawGuid = extractText(item.guid) || rawLink || rawTitle;
      let rawDesc = extractText(item.description || item.summary || '');
      
      // Çoklu tarih formatı yakalama (pubDate, dc:date, published vb.)
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

      // --- YENİ VE DÜZELTİLMİŞ KISIM ---
      await News.updateOne(
        { guid: String(rawGuid) },
        {
          $set: {
            title: finalTitle,
            link: String(rawLink),
            description: finalDesc,
            pubDate: parsedDate,          // <--- BURAYA ALDIK (Artık en yeni saat neyse o geçerli!)
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
      ).catch(() => {});
      count++;
    }
    console.log(`[RSS Tamam] ${sourceName}: ${count} haber işlendi.`);
  } catch (error) {
    console.log(`[${sourceName} - RSS Atlandı]: ${error.message}`);
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
      timeout: 7000
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
      if (scrapedList.length >= 25) return false;

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

      await News.updateOne(
        { guid: item.guid },
        {
          $set: {
            title: finalTitle,
            link: item.link,
            description: item.description,
            source: item.source,
            category: item.category,
            lang: lang || 'tr',
            isTranslated: isTranslated
          },
          $setOnInsert: {
            guid: item.guid,
            pubDate: item.pubDate,
            views: 0,
            createdAt: new Date()
          }
        },
        { upsert: true }
      ).catch(() => {});
    }
  } catch (error) {
    console.log(`[${sourceName} - HTML Kazıma Atlandı]: ${error.message}`);
  }
}

// PARALEL VE ASLA KİLİTLENMEYEN ANA TARAMA FONKSİYONU
let isSyncing = false;
async function fetchAllSources() {
  if (isSyncing) return;
  isSyncing = true;
  console.log("--> [TARAMA BAŞLADI] Aktif kaynaklar taranıyor...");

  try {
    const sources = await Source.find({ isActive: true });
    
    // src.url || src.rss sayesinde hiçbir kaynak boş geçilmez
    const tasks = sources.map(async (src) => {
      const targetUrl = src.url || src.rss;
      if (!targetUrl) return;

      try {
        if (src.type === 'html') {
          await scrapeHtmlSite(src.name, targetUrl, src.category || 'Gündem', src.selector || '', src.lang || 'tr');
        } else {
          await fetchRssFeed(src.name, targetUrl, src.category || 'Gündem', src.lang || 'tr');
        }
      } catch (err) {
        console.error(`[HATA] ${src.name} taranamadı:`, err.message);
      }
    });

    await Promise.allSettled(tasks);
    console.log("<-- [TARAMA BİTTİ] Tüm aktif kaynaklar güncellendi.");
  } catch (err) {
    console.error("Genel tarama hatası:", err.message);
  } finally {
    isSyncing = false;
  }
}

// 4. API ENDPOINTLERİ

// --- RATING & ETKİLEŞİM API'LERİ ---
app.post('/api/news/:id/click', async (req, res) => {
  try {
    const news = await News.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true }
    );
    if (!news) return res.status(404).json({ success: false, message: 'Haber bulunamadı' });
    res.json({ success: true, views: news.views });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/analytics/ratings', authMiddleware, async (req, res) => {
  try {
    const topNews = await News.find().sort({ views: -1, pubDate: -1 }).limit(15);

    const sourceRatings = await News.aggregate([
      { $group: { _id: "$source", totalViews: { $sum: "$views" }, newsCount: { $sum: 1 } } },
      { $sort: { totalViews: -1 } },
      { $limit: 10 }
    ]);

    const categoryRatings = await News.aggregate([
      { $group: { _id: "$category", totalViews: { $sum: "$views" }, newsCount: { $sum: 1 } } },
      { $sort: { totalViews: -1 } }
    ]);

    const totalViewsData = await News.aggregate([
      { $group: { _id: null, sumViews: { $sum: "$views" } } }
    ]);
    const totalViews = totalViewsData[0]?.sumViews || 0;
    const totalNewsCount = await News.countDocuments();

    res.json({
      success: true,
      data: {
        totalViews,
        totalNewsCount,
        topNews,
        sourceRatings,
        categoryRatings
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- KATEGORİ YÖNETİMİ ---
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/categories', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Kategori adı giriniz.' });
    const cleanName = name.trim();
    const exist = await Category.findOne({ name: { $regex: new RegExp(`^${cleanName}$`, 'i') } });
    if (exist) return res.status(400).json({ success: false, message: 'Bu kategori zaten mevcut.' });

    const newCat = await Category.create({ name: cleanName });
    res.json({ success: true, data: newCat, message: `"${cleanName}" kategorisi başarıyla eklendi.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/categories/:id', authMiddleware, async (req, res) => {
  try {
    const cat = await Category.findById(req.params.id);
    if (!cat) return res.status(404).json({ success: false, message: 'Kategori bulunamadı.' });
    if (['Gündem', 'Spor', 'Ekonomi'].includes(cat.name)) {
      return res.status(400).json({ success: false, message: 'Temel sistem kategorileri silinemez.' });
    }
    await Category.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: `"${cat.name}" kategorisi silindi.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- KULLANICI & GİRİŞ YÖNETİMİ ---
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı!' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı!' });

    const token = jwt.sign(
      { id: user._id, username: user.username, fullname: user.fullname, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user._id, username: user.username, fullname: user.fullname, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'Mevcut ve yeni şifre gereklidir.' });
    if (newPassword.length < 5) return res.status(400).json({ success: false, message: 'Yeni şifre en az 5 karakter olmalıdır.' });

    const user = await User.findById(req.user.id);
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).json({ success: false, message: 'Mevcut şifrenizi hatalı girdiniz!' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true, message: 'Şifreniz başarıyla güncellendi!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/users/:id/password', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Bu işlem için admin yetkisi gerekir.' });
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 5) return res.status(400).json({ success: false, message: 'Yeni şifre en az 5 karakter olmalıdır.' });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true, message: `${user.fullname} adlı personelin şifresi güncellendi.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/users', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Personel ekleme yetkiniz yok.' });
    const { username, password, fullname, role } = req.body;
    if (!username || !password || !fullname) return res.status(400).json({ success: false, message: 'Tüm alanları doldurunuz.' });
    const exist = await User.findOne({ username });
    if (exist) return res.status(400).json({ success: false, message: 'Bu kullanıcı adı zaten kullanılıyor.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({ username, password: hashedPassword, fullname, role: role || 'staff' });
    res.json({ success: true, data: { username: newUser.username, fullname: newUser.fullname, role: newUser.role } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Personel silme yetkiniz yok.' });
    const user = await User.findById(req.params.id);
    if (user.username === 'admin') return res.status(400).json({ success: false, message: 'Ana süper yönetici silinemez!' });
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Personel hesabı silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- KULLANICI TALEPLERİ ---
app.post('/api/requests', async (req, res) => {
  try {
    const { email, subject, message } = req.body;
    if (!email || !message) return res.status(400).json({ success: false, message: 'E-posta ve mesaj alanları zorunludur.' });
    await Request.create({ email, subject: subject || 'Genel Talep', message });
    res.json({ success: true, message: 'Talebiniz başarıyla yönetime iletildi. Teşekkür ederiz!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/requests', authMiddleware, async (req, res) => {
  try {
    const requests = await Request.find().sort({ createdAt: -1 });
    res.json({ success: true, data: requests });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/requests/:id', authMiddleware, async (req, res) => {
  try {
    await Request.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Talep silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// --- HABERLER API'Sİ (HIZLANDIRILMIŞ VE KİLİTSİZ) ---
app.get('/api/news', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 120;
    
    // Yalnızca aktif olan kaynakların isimlerini al
    const activeSources = await Source.find({ isActive: true }).select('name').lean();
    const activeSourceNames = activeSources.map(s => s.name);

    // Temel sorgu
    const query = {
      source: { $in: activeSourceNames }
    };

    if (req.query.category && req.query.category !== 'Tümü') {
      query.category = req.query.category;
    }

    if (req.query.sources) {
      const srcList = req.query.sources.split(',').map(s => s.trim()).filter(Boolean);
      const filtered = srcList.filter(s => activeSourceNames.includes(s));
      if (filtered.length > 0) query.source = { $in: filtered };
    }

    if (req.query.search) {
      query.$or = [
        { title: { $regex: req.query.search, $options: 'i' } },
        { description: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const sortField = req.query.sort === 'rating' ? { views: -1, pubDate: -1 } : { pubDate: -1 };

    // lean() ekleyerek JSON'a çevrim süresini 10 kat hızlandırıyoruz, maxTimeMS kaldırıldı
    const news = await News.find(query)
      .sort(sortField)
      .limit(limit)
      .lean();

    res.json({ success: true, count: news.length, data: news });
  } catch (err) {
    console.error("Haber getirme hatası:", err);
    res.status(500).json({ success: false, error: err.message, data: [] });
  }
});

// --- KAYNAK YÖNETİMİ ---
app.get('/api/sources', async (req, res) => {
  try {
    const sources = await Source.find().sort({ category: 1, name: 1 });
    const mapped = sources.map(s => {
      const doc = s.toObject();
      if (!doc.url && doc.rss) doc.url = doc.rss;
      if (!doc.type) doc.type = 'rss';
      if (!doc.lang) doc.lang = 'tr';
      return doc;
    });
    res.json({ success: true, data: mapped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sources', authMiddleware, async (req, res) => {
  try {
    const { name, url, rss, type, category, selector, lang } = req.body;
    const targetUrl = url || rss;
    if (!name || !targetUrl) return res.status(400).json({ success: false, message: 'İsim ve URL/RSS zorunludur.' });

    const newSource = await Source.create({ 
      name: name.trim(), 
      type: type || 'rss',
      url: targetUrl.trim(), 
      selector: selector ? selector.trim() : '',
      category: category || 'Gündem',
      lang: lang === 'en' ? 'en' : 'tr'
    });

    fetchAllSources();
    res.json({ success: true, data: newSource });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/sources/:id', authMiddleware, async (req, res) => {
  try {
    const { name, url, rss, type, category, selector, lang, isActive } = req.body;
    const targetUrl = url || rss;

    const updateFields = {};
    if (name) updateFields.name = name.trim();
    if (targetUrl) updateFields.url = targetUrl.trim();
    if (type) updateFields.type = type;
    if (category) updateFields.category = category;
    if (typeof selector !== 'undefined') updateFields.selector = selector.trim();
    if (lang) updateFields.lang = (lang === 'en' ? 'en' : 'tr');
    if (typeof isActive !== 'undefined') updateFields.isActive = isActive;

    const updatedSource = await Source.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true, runValidators: true }
    );

    if (!updatedSource) {
      return res.status(404).json({ success: false, message: 'Kaynak bulunamadı' });
    }

    if (updatedSource.isActive === false) {
      await News.deleteMany({ source: updatedSource.name });
    }

    fetchAllSources();
    res.json({ success: true, message: 'Kaynak başarıyla güncellendi.', data: updatedSource });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// KAYNAK SİLİNDİĞİNDE ESKİ HABERLERİ VERİTABANINDAN DA SİL
app.delete('/api/sources/:id', authMiddleware, async (req, res) => {
  try {
    const src = await Source.findByIdAndDelete(req.params.id);
    if (src) {
      await News.deleteMany({ source: src.name });
    }
    res.json({ success: true, message: 'Kaynak ve tüm haberleri silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// KAYNAK PASİF YAPILDIĞINDA ESKİ HABERLERİ TEMİZLE
app.patch('/api/sources/:id/toggle', authMiddleware, async (req, res) => {
  try {
    const src = await Source.findById(req.params.id);
    if (!src) return res.status(404).json({ success: false, message: 'Kaynak bulunamadı' });
    
    src.isActive = !src.isActive;
    await src.save();

    if (!src.isActive) {
      await News.deleteMany({ source: src.name });
      console.log(`[TEMİZLİK] Pasif edilen ${src.name} kaynağının haberleri veritabanından silindi.`);
    }

    res.json({ success: true, data: src });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- REKLAMLAR ---
app.get('/api/ads', async (req, res) => {
  try {
    const ads = await Ad.find();
    res.json({ success: true, data: ads });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ads', authMiddleware, async (req, res) => {
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
// --- SENKRONİZASYON & ZAMANLAYICI (DÜZELTİLMİŞ & RAPORLU) ---
app.get('/api/sync', async (req, res) => {
  try {
    console.log("--> Manuel tarama tetiklendi, siteler taranıyor...");
    // await koyuyoruz ki sitelerin taranması tamamlansın, sonucu görelim!
    await fetchAllSources();
    
    // Son 5 haberi çekip bakalım güncel saat gelmiş mi?
    const latestNews = await News.find().sort({ pubDate: -1, createdAt: -1 }).limit(3).lean();
    
    res.json({
      success: true,
      message: "Tüm kaynaklar başarıyla tarandı!",
      son_haber_saati: latestNews[0] ? (latestNews[0].pubDate || latestNews[0].createdAt) : "Haber yok",
      son_haber_basligi: latestNews[0] ? latestNews[0].title : "Haber yok"
    });
  } catch (err) {
    console.error("Tarama hatası:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3 dakikada bir otomatik tara
setInterval(fetchAllSources, 3 * 60 * 1000);
// Sunucu açıldıktan 3 saniye sonra ilk taramayı başlat
setTimeout(fetchAllSources, 3000);

app.listen(PORT, () => {
  console.log(`Haber Takip Web Sunucusu http://localhost:${PORT} portunda çalışıyor.`);
});
