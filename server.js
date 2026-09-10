require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'haber-takip-gizli-anahtar-2026';

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
  category: { type: String, default: 'Gündem', index: true },
  createdAt: { type: Date, default: Date.now }
});
newsSchema.index({ pubDate: -1, createdAt: -1 });
const News = mongoose.model('News', newsSchema);

// Kaynak Modeli (Kategori Alanı Eklendi)
const sourceSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  rss: { type: String, required: true },
  category: { type: String, default: 'Gündem' },
  isActive: { type: Boolean, default: true },
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

// Yetki Doğrulama
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

// 2. Varsayılan Başlangıç Verileri
const initialSources = [
  { name: 'NTV Son Dakika', rss: 'https://www.ntv.com.tr/son-dakika.rss', category: 'Gündem' },
  { name: 'Hürriyet Gündem', rss: 'https://www.hurriyet.com.tr/rss/gundem', category: 'Gündem' },
  { name: 'Ensonhaber', rss: 'https://www.ensonhaber.com/rss/ensonhaber.xml', category: 'Gündem' },
  { name: 'BBC Türkçe', rss: 'https://feeds.bbci.co.uk/turkce/rss.xml', category: 'Dünya' },
  { name: 'Milliyet Spor', rss: 'https://www.milliyet.com.tr/rss/rssnew/skorersondakikarss.xml', category: 'Spor' },
  { name: 'Hürriyet Ekonomi', rss: 'https://www.hurriyet.com.tr/rss/ekonomi', category: 'Ekonomi' },
  { name: 'Sözcü', rss: 'https://www.sozcu.com.tr/rss/tum-haberler.xml', category: 'Gündem' }
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

// 3. RSS Motoru
async function fetchRssFeed(sourceName, url, categoryName = 'Gündem') {
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
            category: categoryName,
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
      await fetchRssFeed(src.name, src.rss, src.category || 'Gündem');
    }
  } catch (err) {
    console.error("Kaynak tarama hatası:", err.message);
  }
  isSyncing = false;
}

// 4. API Endpointleri

// Giriş (Login)
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

// Kendi Şifresini Değiştirme (Tüm giriş yapmış kullanıcılar)
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Mevcut ve yeni şifre gereklidir.' });
    }
    if (newPassword.length < 5) {
      return res.status(400).json({ success: false, message: 'Yeni şifre en az 5 karakter olmalıdır.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).json({ success: false, message: 'Mevcut şifrenizi hatalı girdiniz!' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ success: true, message: 'Şifreniz başarıyla güncellendi!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin'in İstediği Personelin Şifresini Değiştirmesi
app.post('/api/users/:id/password', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Bu işlem için admin yetkisi gerekir.' });
    }
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 5) {
      return res.status(400).json({ success: false, message: 'Yeni şifre en az 5 karakter olmalıdır.' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ success: true, message: `${user.fullname} adlı personelin şifresi güncellendi.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Personel Listele
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Yeni Personel Ekle
app.post('/api/users', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Personel ekleme yetkiniz yok.' });
    }
    const { username, password, fullname, role } = req.body;
    if (!username || !password || !fullname) {
      return res.status(400).json({ success: false, message: 'Tüm alanları doldurunuz.' });
    }
    const exist = await User.findOne({ username });
    if (exist) return res.status(400).json({ success: false, message: 'Bu kullanıcı adı zaten kullanılıyor.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      username,
      password: hashedPassword,
      fullname,
      role: role || 'staff'
    });
    res.json({ success: true, data: { username: newUser.username, fullname: newUser.fullname, role: newUser.role } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Personel Sil
app.delete('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Personel silme yetkiniz yok.' });
    }
    const user = await User.findById(req.params.id);
    if (user.username === 'admin') {
      return res.status(400).json({ success: false, message: 'Ana süper yönetici silinemez!' });
    }
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Personel hesabı silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Kategorileri Listele
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await Source.distinct('category');
    const defaults = ['Tümü', 'Gündem', 'Spor', 'Ekonomi', 'Dünya', 'Teknoloji', 'Magazin'];
    const merged = Array.from(new Set([...defaults, ...categories])).filter(Boolean);
    res.json({ success: true, data: merged });
  } catch (err) {
    res.json({ success: true, data: ['Tümü', 'Gündem', 'Spor', 'Ekonomi', 'Dünya', 'Teknoloji'] });
  }
});

// Haberler (Kategori ve Kaynak Filtreli)
app.get('/api/news', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 120;
    const query = {};

    // Kategori Filtresi
    if (req.query.category && req.query.category !== 'Tümü') {
      query.category = req.query.category;
    }

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

// Kaynak Yönetimi
app.get('/api/sources', async (req, res) => {
  try {
    const sources = await Source.find().sort({ category: 1, name: 1 });
    res.json({ success: true, data: sources });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sources', authMiddleware, async (req, res) => {
  try {
    const { name, rss, category } = req.body;
    if (!name || !rss) return res.status(400).json({ success: false, message: 'İsim ve RSS zorunludur.' });
    const newSource = await Source.create({ 
      name, 
      rss, 
      category: category || 'Gündem' 
    });
    fetchAllSources();
    res.json({ success: true, data: newSource });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/sources/:id', authMiddleware, async (req, res) => {
  try {
    await Source.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Kaynak silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/sources/:id/toggle', authMiddleware, async (req, res) => {
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

// Reklam Yönetimi
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

app.get('/api/sync', (req, res) => {
  fetchAllSources();
  res.json({ success: true, message: "Tarama arka planda baslatildi." });
});

setInterval(fetchAllSources, 10 * 60 * 1000);
setTimeout(fetchAllSources, 4000);

app.listen(PORT, () => {
  console.log(`Haber Takip Web Sunucusu http://localhost:${PORT} portunda calisiyor.`);
});
