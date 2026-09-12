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
const JWT_SECRET = String(
  process.env.JWT_SECRET || ''
).trim();

if (JWT_SECRET.length < 32) {
  console.error(
    'KRİTİK HATA: JWT_SECRET ortam değişkeni tanımlanmalı ve en az 32 karakter olmalıdır.'
  );

  process.exit(1);
}
app.use(cors());
app.use(express.json());

// TÜM API'LER İÇİN ÖNBELLEK (304) DEVRE DIŞI BIRAKILDI
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

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
  createdAt: { type: Date, default: Date.now }
});

newsSchema.index({ pubDate: -1 });
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
  lastSuccessAt: { type: Date, default: null },
  lastErrorAt: { type: Date, default: null },
  lastErrorMessage: { type: String, default: '', maxlength: 1000 },
  consecutiveErrors: { type: Number, default: 0, min: 0 },
  lastItemCount: { type: Number, default: 0, min: 0 },
  lastScanAt: { type: Date, default: null, index: true },
  healthStatus: {
    type: String,
    enum: ['healthy', 'warning', 'error', 'unknown'],
    default: 'unknown',
    index: true
  },
  createdAt: { type: Date, default: Date.now }
});
const Source = mongoose.model('Source', sourceSchema);

// =====================================================
// REKLAM YÖNETİMİ
// Altı sabit reklam konumu desteklenir.
// =====================================================

const AD_POSITIONS = [
  'top',
  'left',
  'right',
  'inline1',
  'inline2',
  'bottom'
];

const adSchema = new mongoose.Schema({
  position: {
    type: String,
    enum: AD_POSITIONS,
    required: true,
    unique: true,
    index: true
  },
  type: {
    type: String,
    enum: ['code', 'custom'],
    default: 'custom'
  },
  code: {
    type: String,
    default: '',
    maxlength: 100000
  },
  imageUrl: {
    type: String,
    default: '',
    trim: true,
    maxlength: 2000
  },
  targetUrl: {
    type: String,
    default: '',
    trim: true,
    maxlength: 2000
  },
  title: {
    type: String,
    default: 'Sponsorlu Reklam',
    trim: true,
    maxlength: 200
  },

  // Reklamın yönetimsel olarak aktif olup olmadığını belirler.
  isActive: {
    type: Boolean,
    default: false,
    index: true
  },

  // Reklam alanının sayfada yer kaplayıp kaplamayacağını belirler.
  isVisible: {
    type: Boolean,
    default: false,
    index: true
  },

  updatedBy: {
    type: String,
    default: 'Sistem',
    maxlength: 200
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const Ad = mongoose.model('Ad', adSchema);
const AD_DEFAULT_TITLES = {
  top: 'Üst Banner Reklamı',
  left: 'Sol Kule Reklamı',
  right: 'Sağ Kule Reklamı',
  inline1: 'Akış İçi Birinci Reklam',
  inline2: 'Akış İçi İkinci Reklam',
  bottom: 'Alt Banner Reklamı'
};

async function synchronizeAdPositions() {
  for (const position of AD_POSITIONS) {
    // collection.findOne kullanılması önemlidir:
    // Eski kayıtta isVisible alanının gerçekten bulunup
    // bulunmadığını Mongoose varsayılanlarından etkilenmeden kontrol eder.
    const existingAd = await Ad.collection.findOne({
      position
    });

    if (!existingAd) {
      await Ad.create({
        position,
        type: 'custom',
        code: '',
        imageUrl: '',
        targetUrl: '',
        title: AD_DEFAULT_TITLES[position],
        isActive: false,
        isVisible: false,
        updatedBy: 'Sistem',
        createdAt: new Date(),
        updatedAt: new Date()
      });

      console.log(
        `[REKLAM] Eksik reklam konumu oluşturuldu: ${position}`
      );

      continue;
    }

    const migrationFields = {};

    // Eski reklam görünürlüğünü korur.
    if (typeof existingAd.isVisible !== 'boolean') {
      migrationFields.isVisible =
        existingAd.isActive === true;
    }

    if (typeof existingAd.isActive !== 'boolean') {
      migrationFields.isActive = false;
    }

    if (!existingAd.title) {
      migrationFields.title =
        AD_DEFAULT_TITLES[position];
    }

    if (!existingAd.type) {
      migrationFields.type = 'custom';
    }

    if (Object.keys(migrationFields).length > 0) {
      migrationFields.updatedAt = new Date();

      await Ad.collection.updateOne(
        {
          _id: existingAd._id
        },
        {
          $set: migrationFields
        }
      );

      console.log(
        `[REKLAM] Eski reklam kaydı güncellendi: ${position}`
      );
    }
  }

  console.log(
    'Altı reklam konumu MongoDB ile senkronize edildi.'
  );
}
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
// =====================================================
// YASAL METİNLER — KVKK, GİZLİLİK VE DİĞER SAYFALAR
// =====================================================
const legalPageSchema = new mongoose.Schema({
  slug: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  content: {
    type: String,
    required: true,
    maxlength: 100000
  },
  isPublished: {
    type: Boolean,
    default: false,
    index: true
  },
  updatedBy: {
    type: String,
    default: 'Sistem'
  },
  publishedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const LegalPage = mongoose.model('LegalPage', legalPageSchema);


// =====================================================
// ZİYARETÇİ VE SAYFA GÖRÜNTÜLEME ANALİTİĞİ
// Her ziyaretçi için günlük tek kayıt tutulur.
// =====================================================
const dailyVisitSchema = new mongoose.Schema({
  visitorId: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
    index: true
  },
  day: {
    type: String,
    required: true,
    index: true
  },
  pageViews: {
    type: Number,
    default: 0,
    min: 0
  },
  firstSeenAt: {
    type: Date,
    default: Date.now
  },
  lastSeenAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  lastPath: {
    type: String,
    default: '/',
    maxlength: 500
  },
  userAgent: {
    type: String,
    default: '',
    maxlength: 500
  },
  isBot: {
    type: Boolean,
    default: false,
    index: true
  }
});

dailyVisitSchema.index(
  {
    visitorId: 1,
    day: 1
  },
  {
    unique: true
  }
);

const DailyVisit = mongoose.model('DailyVisit', dailyVisitSchema);

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
// Yalnızca ana yönetici rolünün kullanabileceği işlemler
const adminOnlyMiddleware = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Bu işlem yalnızca ana yönetici tarafından yapılabilir.'
    });
  }

  next();
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

async function cleanOldNews() {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await News.deleteMany({
      pubDate: { $lt: twentyFourHoursAgo }
    });
    if (result && result.deletedCount > 0) {
      console.log(`[TEMİZLİK] ${result.deletedCount} adet 24 saati geçmiş haber silindi.`);
    }
  } catch (err) {
    console.error('[TEMİZLİK UYARISI]:', err.message);
  }
}

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
      console.log('MongoDB Atlas bağlantısı başarılı.');
await synchronizeAdPositions();
      await cleanOldNews();
      setInterval(cleanOldNews, 60 * 60 * 1000);

     // İlk yönetici yalnızca ortam değişkenlerinden oluşturulur.
// Veritabanında bir admin varsa mevcut hesap korunur.
const existingAdmin = await User.findOne({
  role: 'admin'
});

if (!existingAdmin) {
  const initialAdminUsername = String(
    process.env.INITIAL_ADMIN_USERNAME || ''
  ).trim();

  const initialAdminPassword = String(
    process.env.INITIAL_ADMIN_PASSWORD || ''
  );

  const initialAdminFullname = String(
    process.env.INITIAL_ADMIN_FULLNAME || 'Ana Yönetici'
  ).trim();

  if (
    !initialAdminUsername ||
    initialAdminPassword.length < 12
  ) {
    console.error(
      'KRİTİK HATA: Veritabanında admin hesabı yok. ' +
      'INITIAL_ADMIN_USERNAME ve en az 12 karakterlik ' +
      'INITIAL_ADMIN_PASSWORD ortam değişkenleri tanımlanmalıdır.'
    );

    process.exit(1);
  }

  const usernameInUse = await User.findOne({
    username: initialAdminUsername
  });

  if (usernameInUse) {
    console.error(
      'KRİTİK HATA: INITIAL_ADMIN_USERNAME başka bir kullanıcı tarafından kullanılıyor.'
    );

    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(
    initialAdminPassword,
    12
  );

  await User.create({
    username: initialAdminUsername,
    password: hashedPassword,
    fullname:
      initialAdminFullname ||
      'Ana Yönetici',
    role: 'admin'
  });

  console.log(
    `İlk ana yönetici güvenli şekilde oluşturuldu: ${initialAdminUsername}`
  );
}

      // KATEGORİLERİ EKSİKSİZ TAMAMLA
      for (const c of defaultCategories) {
        await Category.updateOne(
          { name: c },
          { $setOnInsert: { name: c } },
          { upsert: true }
        ).catch(() => {});
      }

      // ESKİ YABANCI ARTIK KAYNAKLARI SİL
      await Source.deleteMany({ name: { $in: ['The New York Times', 'Zdf'] } }).catch(() => {});

      // YERLİ KAYNAKLARI ZORUNLU EŞLEŞTİR
      for (const src of initialSources) {
        await Source.updateOne(
          { name: src.name },
          { $set: src },
          { upsert: true }
        ).catch(() => {});
      }
      console.log('18 Yerli kaynak MongoDB ile senkronize edildi.');

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

      // HEMEN TARAMAYI BAŞLAT
      syncAllSources();
      setInterval(syncAllSources, 5 * 60 * 1000);
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
function getSourceErrorMessage(error) {
  const statusCode = error?.response?.status;
  const baseMessage = String(error?.message || 'Bilinmeyen tarama hatası').trim();
  const message = statusCode ? `HTTP ${statusCode}: ${baseMessage}` : baseMessage;
  return message.slice(0, 1000);
}

async function recordSourceScanSuccess(sourceName, itemCount) {
  try {
    const now = new Date();
    await Source.updateOne(
      { name: sourceName },
      {
        $set: {
          lastScanAt: now,
          lastSuccessAt: now,
          lastItemCount: Math.max(0, Number(itemCount) || 0),
          consecutiveErrors: 0,
          lastErrorMessage: '',
          healthStatus: 'healthy'
        }
      }
    );
  } catch (healthError) {
    console.error(`[KAYNAK SAĞLIK KAYDI] ${sourceName}:`, healthError.message);
  }
}

async function recordSourceScanError(sourceName, error) {
  try {
    const source = await Source.findOne({ name: sourceName }).select('consecutiveErrors');
    if (!source) return;

    const errorCount = Math.max(0, Number(source.consecutiveErrors) || 0) + 1;
    const now = new Date();
    await Source.updateOne(
      { _id: source._id },
      {
        $set: {
          lastScanAt: now,
          lastErrorAt: now,
          lastErrorMessage: getSourceErrorMessage(error),
          consecutiveErrors: errorCount,
          lastItemCount: 0,
          healthStatus: errorCount >= 3 ? 'error' : 'warning'
        }
      }
    );
  } catch (healthError) {
    console.error(`[KAYNAK HATA KAYDI] ${sourceName}:`, healthError.message);
  }
}

async function fetchRssFeed(sourceName, rawUrl, categoryName = 'Gündem', lang = 'tr') {
  const url = rawUrl ? rawUrl.trim() : '';
  if (!url) {
    const error = new Error('Kaynak URL adresi boş.');
    await recordSourceScanError(sourceName, error);
    return { success: false, count: 0, error: getSourceErrorMessage(error) };
  }

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 8000
    });

    let rawXml = response.data;
    if (typeof rawXml === 'string') {
      rawXml = rawXml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[a-fA-F0-9]+);)/g, '&amp;');
    }

    const parser = new xml2js.Parser({ explicitArray: false, trim: true });
    const result = await parser.parseStringPromise(rawXml);
    const channel = result.rss ? result.rss.channel : (result.feed || {});
    const items = channel.item || channel.entry || [];
    const itemList = (Array.isArray(items) ? items : [items]).filter(Boolean).slice(0, 30);

    let count = 0;
    for (const item of itemList) {
      const rawTitle = extractText(item.title);
      if (!rawTitle) continue;

      const rawLink = typeof item.link === 'string'
        ? item.link
        : (item.link?.$.href || extractText(item.link));
      const rawGuid = extractText(item.guid) || rawLink || rawTitle;
      const rawDesc = extractText(item.description || item.summary || '');

      const rawDateStr = item.pubDate || item['dc:date'] || item.published || item.updated;
      let parsedDate = new Date();
      if (rawDateStr) {
        const dateValue = new Date(rawDateStr);
        if (!isNaN(dateValue.getTime())) parsedDate = dateValue;
      }

      if (!rawGuid || !rawLink) continue;

      let finalTitle = rawTitle;
      let finalDesc = rawDesc;
      let isTranslated = false;

      if (lang === 'en') {
        finalTitle = await translateToTurkish(rawTitle);
        if (rawDesc) finalDesc = await translateToTurkish(rawDesc);
        isTranslated = true;
      }

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
            isTranslated
          },
          $setOnInsert: {
            guid: String(rawGuid),
            views: 0,
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
      count += 1;
    }

    await recordSourceScanSuccess(sourceName, count);
    console.log(`[RSS Tamam] ${sourceName}: ${count} haber işlendi.`);
    return { success: true, count };
  } catch (error) {
    await recordSourceScanError(sourceName, error);
    console.log(`[${sourceName} - RSS Hatası]: ${error.message}`);
    return { success: false, count: 0, error: getSourceErrorMessage(error) };
  }
}

async function scrapeHtmlSite(sourceName, siteUrl, categoryName = 'Gündem', customSelector = '', lang = 'tr') {
  if (!siteUrl) {
    const error = new Error('Kaynak URL adresi boş.');
    await recordSourceScanError(sourceName, error);
    return { success: false, count: 0, error: getSourceErrorMessage(error) };
  }

  try {
    const response = await axios.get(siteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 8000
    });

    const $ = cheerio.load(response.data);
    const parsedUrl = new URL(siteUrl);
    const origin = parsedUrl.origin;
    const scrapedList = [];
    const seenLinks = new Set();
    const targetSelector = customSelector && customSelector.trim()
      ? customSelector
      : 'article a, .news-item a, .card a, h2 a, h3 a, a[href*="/haber/"], a[href*="/son-dakika/"], a[href*=".html"]';

    $(targetSelector).each((index, element) => {
      if (scrapedList.length >= 30) return false;
      const title = $(element).text().replace(/\s+/g, ' ').trim() || $(element).attr('title') || '';
      let href = $(element).attr('href');
      if (!title || title.length < 15 || !href) return;

      try {
        href = new URL(href, origin).toString();
      } catch (urlError) {
        return;
      }

      if (seenLinks.has(href)) return;
      seenLinks.add(href);
      scrapedList.push({ guid: href, title, link: href, pubDate: new Date() });
    });

    let count = 0;
    for (const item of scrapedList) {
      let finalTitle = item.title;
      let isTranslated = false;
      if (lang === 'en') {
        finalTitle = await translateToTurkish(item.title);
        isTranslated = true;
      }

      await News.updateOne(
        { guid: item.guid },
        {
          $set: {
            title: finalTitle,
            link: item.link,
            description: '',
            pubDate: item.pubDate,
            source: sourceName,
            category: categoryName,
            lang: lang || 'tr',
            isTranslated
          },
          $setOnInsert: {
            guid: item.guid,
            views: 0,
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
      count += 1;
    }

    await recordSourceScanSuccess(sourceName, count);
    console.log(`[HTML Tamam] ${sourceName}: ${count} haber işlendi.`);
    return { success: true, count };
  } catch (error) {
    await recordSourceScanError(sourceName, error);
    console.log(`[${sourceName} - HTML Hatası]: ${error.message}`);
    return { success: false, count: 0, error: getSourceErrorMessage(error) };
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
// =====================================================
// YASAL METİN YÖNETİMİ — KVKK
// =====================================================

const ALLOWED_LEGAL_SLUGS = new Set([
  'kvkk'
]);

const UNFINISHED_LEGAL_FIELDS = [
  '[E-POSTA ADRESİNİ YAZIN]',
  '[KVKK BAŞVURU E-POSTA ADRESİNİ YAZIN]',
  '[TEBLİGATA ELVERİŞLİ İLETİŞİM ADRESİNİ YAZIN]'
];

function getSafeLegalSlug(rawSlug) {
  const slug = String(rawSlug || '')
    .trim()
    .toLocaleLowerCase('tr-TR');

  return ALLOWED_LEGAL_SLUGS.has(slug) ? slug : null;
}

function hasUnfinishedLegalFields(content) {
  const normalizedContent = String(content || '')
    .toLocaleUpperCase('tr-TR');

  return UNFINISHED_LEGAL_FIELDS.some(field =>
    normalizedContent.includes(field.toLocaleUpperCase('tr-TR'))
  );
}


// ZİYARETÇİYE AÇIK — Yalnızca yayımlanan metni döndürür
app.get('/api/legal/:slug', async (req, res) => {
  try {
    const slug = getSafeLegalSlug(req.params.slug);

    if (!slug) {
      return res.status(404).json({
        success: false,
        message: 'Yasal metin bulunamadı.'
      });
    }

    const page = await LegalPage.findOne({
      slug,
      isPublished: true
    })
      .select('slug title content publishedAt updatedAt')
      .lean();

    if (!page) {
      return res.status(404).json({
        success: false,
        message: 'Yasal metin henüz yayımlanmadı veya yayından kaldırıldı.'
      });
    }

    return res.json({
      success: true,
      data: page
    });
  } catch (error) {
    console.error('[YASAL METİN OKUMA HATASI]', error);

    return res.status(500).json({
      success: false,
      message: 'Yasal metin şu anda yüklenemiyor.'
    });
  }
});


// YÖNETİCİYE ÖZEL — Taslak dâhil mevcut metni döndürür
app.get(
  '/api/admin/legal/:slug',
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const slug = getSafeLegalSlug(req.params.slug);

      if (!slug) {
        return res.status(404).json({
          success: false,
          message: 'Yasal metin türü bulunamadı.'
        });
      }

      const page = await LegalPage.findOne({
        slug
      }).lean();

      return res.json({
        success: true,
        data: page || null
      });
    } catch (error) {
      console.error('[YASAL METİN ADMIN OKUMA HATASI]', error);

      return res.status(500).json({
        success: false,
        message: 'Yasal metin yönetim paneline yüklenemedi.'
      });
    }
  }
);


// YÖNETİCİYE ÖZEL — Kaydetme, yayınlama ve yayından kaldırma
app.put(
  '/api/admin/legal/:slug',
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const slug = getSafeLegalSlug(req.params.slug);

      if (!slug) {
        return res.status(404).json({
          success: false,
          message: 'Yasal metin türü bulunamadı.'
        });
      }

      const title = String(req.body.title || '').trim();
      const content = String(req.body.content || '').trim();
      const isPublished = req.body.isPublished === true;

      if (!title) {
        return res.status(400).json({
          success: false,
          message: 'Metin başlığı zorunludur.'
        });
      }

      if (!content) {
        return res.status(400).json({
          success: false,
          message: 'Yasal metin alanı boş bırakılamaz.'
        });
      }

      if (title.length > 200) {
        return res.status(400).json({
          success: false,
          message: 'Başlık en fazla 200 karakter olabilir.'
        });
      }

      if (content.length > 100000) {
        return res.status(400).json({
          success: false,
          message: 'Yasal metin izin verilen uzunluğu aşıyor.'
        });
      }

      if (isPublished && hasUnfinishedLegalFields(content)) {
        return res.status(400).json({
          success: false,
          message:
            'Metinde doldurulmamış e-posta veya tebligat adresi alanları var. Bu alanları tamamlamadan metni yayımlayamazsınız.'
        });
      }

      const existingPage = await LegalPage.findOne({
        slug
      });

      const wasPublished = existingPage?.isPublished === true;
      const now = new Date();

      const page = await LegalPage.findOneAndUpdate(
        {
          slug
        },
        {
          $set: {
            title,
            content,
            isPublished,
            updatedBy:
              req.user.fullname ||
              req.user.username ||
              'Yönetici',
            updatedAt: now,
            publishedAt:
              isPublished && !wasPublished
                ? now
                : existingPage?.publishedAt || null
          },
          $setOnInsert: {
            slug,
            createdAt: now
          }
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true
        }
      );

      let message = 'KVKK Aydınlatma Metni taslak olarak kaydedildi.';

      if (isPublished) {
        message = wasPublished
          ? 'KVKK Aydınlatma Metni güncellendi ve yayında tutuldu.'
          : 'KVKK Aydınlatma Metni kaydedildi ve yayımlandı.';
      } else if (wasPublished) {
        message = 'KVKK Aydınlatma Metni yayından kaldırıldı.';
      }

      return res.json({
        success: true,
        message,
        data: page
      });
    } catch (error) {
      console.error('[YASAL METİN KAYDETME HATASI]', error);

      if (error?.code === 11000) {
        return res.status(409).json({
          success: false,
          message: 'Bu yasal metin için zaten bir kayıt bulunuyor.'
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Yasal metin kaydedilemedi.'
      });
    }
  }
);
// =====================================================
// GERÇEK ZİYARETÇİ VE SAYFA GÖRÜNTÜLEME ANALİTİĞİ
// IP adresi kaydedilmez.
// =====================================================

const VISITOR_ONLINE_MINUTES = 5;

function getIstanbulDay(dateValue = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateValue);
}

function shiftDay(dayValue, dayAmount) {
  const parts = String(dayValue).split('-').map(Number);

  if (
    parts.length !== 3 ||
    parts.some(part => !Number.isInteger(part))
  ) {
    return getIstanbulDay();
  }

  const shiftedDate = new Date(
    Date.UTC(parts[0], parts[1] - 1, parts[2] + dayAmount)
  );

  return shiftedDate.toISOString().slice(0, 10);
}

function isLikelyBot(userAgentValue) {
  const userAgent = String(userAgentValue || '').toLowerCase();

  if (!userAgent) {
    return false;
  }

  const botPattern =
    /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegrambot|discordbot|preview|headless|lighthouse|pagespeed|curl|wget|python-requests|axios|postmanruntime/i;

  return botPattern.test(userAgent);
}

function getCleanVisitorPath(pathValue) {
  let cleanPath = String(pathValue || '/')
    .trim()
    .slice(0, 500);

  if (!cleanPath.startsWith('/')) {
    cleanPath = '/';
  }

  return cleanPath;
}

function getSafeVisitorId(visitorIdValue) {
  const visitorId = String(visitorIdValue || '').trim();

  if (
    visitorId.length < 16 ||
    visitorId.length > 100 ||
    !/^[a-zA-Z0-9_-]+$/.test(visitorId)
  ) {
    return null;
  }

  return visitorId;
}

async function getVisitorPeriodStats(startDay, endDay) {
  const result = await DailyVisit.aggregate([
    {
      $match: {
        day: {
          $gte: startDay,
          $lte: endDay
        },
        isBot: false
      }
    },
    {
      $group: {
        _id: null,
        uniqueVisitors: {
          $addToSet: '$visitorId'
        },
        pageViews: {
          $sum: '$pageViews'
        }
      }
    },
    {
      $project: {
        _id: 0,
        uniqueVisitors: {
          $size: '$uniqueVisitors'
        },
        pageViews: 1
      }
    }
  ]);

  return result[0] || {
    uniqueVisitors: 0,
    pageViews: 0
  };
}


// ZİYARETÇİ SİNYALİ
// event: "pageview" veya "heartbeat"
app.post('/api/visitor/track', async (req, res) => {
  try {
    const visitorId = getSafeVisitorId(req.body.visitorId);
    const event =
      req.body.event === 'heartbeat'
        ? 'heartbeat'
        : 'pageview';

    if (!visitorId) {
      return res.status(400).json({
        success: false,
        message: 'Geçersiz ziyaretçi kimliği.'
      });
    }

    const now = new Date();
    const day = getIstanbulDay(now);
    const userAgent = String(
      req.get('user-agent') || ''
    ).slice(0, 500);

    const updateOperation = {
  $set: {
    lastSeenAt: now,
    lastPath: getCleanVisitorPath(req.body.path),
    userAgent,
    isBot: isLikelyBot(userAgent)
  },
  $setOnInsert: {
    visitorId,
    day,
    firstSeenAt: now
  }
};

if (event === 'pageview') {
  updateOperation.$inc = {
    pageViews: 1
  };
} else {
  updateOperation.$setOnInsert.pageViews = 0;
}

    await DailyVisit.updateOne(
      {
        visitorId,
        day
      },
      updateOperation,
      {
        upsert: true,
        runValidators: true
      }
    );

    return res.json({
      success: true
    });
  } catch (error) {
    console.error('[ZİYARETÇİ KAYIT HATASI]', error);

    if (error?.code === 11000) {
      return res.json({
        success: true
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Ziyaretçi kaydı oluşturulamadı.'
    });
  }
});


// YÖNETİCİYE ÖZEL ZİYARETÇİ RAPORU
app.get(
  '/api/admin/visitor-analytics',
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const now = new Date();
      const today = getIstanbulDay(now);
      const last7DaysStart = shiftDay(today, -6);
      const last30DaysStart = shiftDay(today, -29);
      const currentYearStart = `${today.slice(0, 4)}-01-01`;

      const onlineThreshold = new Date(
        now.getTime() -
        VISITOR_ONLINE_MINUTES * 60 * 1000
      );

      const [
        onlineVisitors,
        todayStats,
        last7DaysStats,
        last30DaysStats,
        currentYearStats,
        dailyChart
      ] = await Promise.all([
       DailyVisit.distinct('visitorId', {
  isBot: false,
  lastSeenAt: {
    $gte: onlineThreshold
  }
}).then(visitorIds => visitorIds.length),

        getVisitorPeriodStats(today, today),

        getVisitorPeriodStats(
          last7DaysStart,
          today
        ),

        getVisitorPeriodStats(
          last30DaysStart,
          today
        ),

        getVisitorPeriodStats(
          currentYearStart,
          today
        ),

        DailyVisit.aggregate([
          {
            $match: {
              day: {
                $gte: last30DaysStart,
                $lte: today
              },
              isBot: false
            }
          },
          {
            $group: {
              _id: '$day',
              uniqueVisitors: {
                $addToSet: '$visitorId'
              },
              pageViews: {
                $sum: '$pageViews'
              }
            }
          },
          {
            $project: {
              _id: 0,
              day: '$_id',
              uniqueVisitors: {
                $size: '$uniqueVisitors'
              },
              pageViews: 1
            }
          },
          {
            $sort: {
              day: 1
            }
          }
        ])
      ]);

      const dailyMap = new Map(
        dailyChart.map(item => [
          item.day,
          item
        ])
      );

      const completedDailyChart = [];

      for (let index = 29; index >= 0; index -= 1) {
        const day = shiftDay(today, -index);

        completedDailyChart.push(
          dailyMap.get(day) || {
            day,
            uniqueVisitors: 0,
            pageViews: 0
          }
        );
      }

      return res.json({
        success: true,
        generatedAt: now,
        onlineWindowMinutes: VISITOR_ONLINE_MINUTES,
        data: {
          online: {
            uniqueVisitors: onlineVisitors
          },
          today: todayStats,
          last7Days: last7DaysStats,
          last30Days: last30DaysStats,
          currentYear: currentYearStats,
          dailyChart: completedDailyChart
        }
      });
    } catch (error) {
      console.error('[ZİYARETÇİ ANALİTİK HATASI]', error);

      return res.status(500).json({
        success: false,
        message: 'Ziyaretçi analitiği oluşturulamadı.'
      });
    }
  }
);

// ÇEVİRİ MOTORU
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

// =====================================================
// REKLAM API'LERİ
// =====================================================


function getSafeAdPosition(rawPosition) {
  const position = String(rawPosition || '')
    .trim()
    .toLowerCase();

  return AD_POSITIONS.includes(position)
    ? position
    : null;
}

function getSafeAdType(rawType) {
  return rawType === 'code'
    ? 'code'
    : 'custom';
}

function normalizeOptionalHttpUrl(rawUrl) {
  const value = String(rawUrl || '').trim();

  if (!value) {
    return '';
  }

  try {
    const parsedUrl = new URL(value);

    if (
      parsedUrl.protocol !== 'http:' &&
      parsedUrl.protocol !== 'https:'
    ) {
      return null;
    }

    return parsedUrl.toString();
  } catch (error) {
    return null;
  }
}

const PUBLIC_AD_FIELDS = [
  'position',
  'type',
  'code',
  'imageUrl',
  'targetUrl',
  'title',
  'isActive',
  'isVisible',
  'updatedAt'
].join(' ');

// ZİYARETÇİYE AÇIK
// Yalnızca aktif ve görünür reklamları döndürür.
app.get('/api/ads', async (req, res) => {
  try {
    const ads = await Ad.find({
      isActive: true,
      isVisible: true
    })
      .select(PUBLIC_AD_FIELDS)
      .lean();

    const adMap = new Map(
      ads.map(ad => [ad.position, ad])
    );

    const orderedAds = AD_POSITIONS
      .map(position => adMap.get(position))
      .filter(Boolean);

    return res.json(orderedAds);
  } catch (error) {
    console.error('[REKLAM LİSTESİ HATASI]', error);

    return res.status(500).json({
      success: false,
      message: 'Reklamlar yüklenemedi.'
    });
  }
});

// ZİYARETÇİYE AÇIK
// Reklam aktif ve görünür değilse kapalı yanıt verir.
app.get('/api/ads/:position', async (req, res) => {
  try {
    const position = getSafeAdPosition(
      req.params.position
    );

    if (!position) {
      return res.status(404).json({
        success: false,
        message: 'Geçersiz reklam konumu.'
      });
    }

    const ad = await Ad.findOne({
      position,
      isActive: true,
      isVisible: true
    })
      .select(PUBLIC_AD_FIELDS)
      .lean();

    if (!ad) {
      return res.json({
        position,
        isActive: false,
        isVisible: false
      });
    }

    return res.json(ad);
  } catch (error) {
    console.error('[REKLAM OKUMA HATASI]', error);

    return res.status(500).json({
      success: false,
      message: 'Reklam yüklenemedi.'
    });
  }
});

// ANA YÖNETİCİYE ÖZEL
// Pasif ve görünmeyenler dâhil altı reklam alanını döndürür.
app.get(
  '/api/admin/ads',
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const ads = await Ad.find().lean();

      const adMap = new Map(
        ads.map(ad => [ad.position, ad])
      );

      const completedAds = AD_POSITIONS.map(position => {
        return adMap.get(position) || {
          position,
          type: 'custom',
          code: '',
          imageUrl: '',
          targetUrl: '',
          title: AD_DEFAULT_TITLES[position],
          isActive: false,
          isVisible: false
        };
      });

      return res.json({
        success: true,
        data: completedAds
      });
    } catch (error) {
      console.error(
        '[ADMIN REKLAM LİSTESİ HATASI]',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Reklam yönetim bilgileri yüklenemedi.'
      });
    }
  }
);

async function saveAdHandler(req, res) {
  try {
    const position = getSafeAdPosition(
      req.params.position
    );

    if (!position) {
      return res.status(400).json({
        success: false,
        message: 'Geçersiz reklam konumu.'
      });
    }

    const body = req.body || {};

    const existingAd = await Ad.findOne({
      position
    });

    const type = getSafeAdType(body.type);
    const code = String(body.code || '').trim();
    const title = String(body.title || '').trim();

    const imageUrl = normalizeOptionalHttpUrl(
      body.imageUrl
    );

    const targetUrl = normalizeOptionalHttpUrl(
      body.targetUrl
    );

    const isActive =
      typeof body.isActive === 'boolean'
        ? body.isActive
        : existingAd?.isActive === true;

    const isVisible =
      typeof body.isVisible === 'boolean'
        ? body.isVisible
        : existingAd?.isVisible === true;

    if (imageUrl === null) {
      return res.status(400).json({
        success: false,
        message:
          'Görsel adresi http:// veya https:// ile başlamalıdır.'
      });
    }

    if (targetUrl === null) {
      return res.status(400).json({
        success: false,
        message:
          'Hedef bağlantı http:// veya https:// ile başlamalıdır.'
      });
    }

    if (title.length > 200) {
      return res.status(400).json({
        success: false,
        message:
          'Reklam başlığı en fazla 200 karakter olabilir.'
      });
    }

    if (code.length > 100000) {
      return res.status(400).json({
        success: false,
        message:
          'Reklam kodu izin verilen uzunluğu aşıyor.'
      });
    }

    // Ekrana verilecek reklamda içerik zorunludur.
    if (isActive && isVisible) {
      if (type === 'code' && !code) {
        return res.status(400).json({
          success: false,
          message:
            'Kod reklamını ekrana vermek için reklam kodu girmelisiniz.'
        });
      }

      if (type === 'custom' && !imageUrl) {
        return res.status(400).json({
          success: false,
          message:
            'Görsel reklamı ekrana vermek için görsel adresi girmelisiniz.'
        });
      }
    }

    const now = new Date();

    const updatedAd = await Ad.findOneAndUpdate(
      {
        position
      },
      {
        $set: {
          type,
          code,
          imageUrl,
          targetUrl,
          title:
            title ||
            existingAd?.title ||
            AD_DEFAULT_TITLES[position],
          isActive,
          isVisible,
          updatedBy:
            req.user?.fullname ||
            req.user?.username ||
            'Yönetici',
          updatedAt: now
        },
        $setOnInsert: {
          position,
          createdAt: now
        }
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    return res.json({
      success: true,
      message:
        isActive && isVisible
          ? 'Reklam kaydedildi ve ekrana verildi.'
          : isActive
            ? 'Reklam aktif fakat görünmez olarak kaydedildi.'
            : 'Reklam pasif olarak kaydedildi.',
      ad: updatedAd
    });
  } catch (error) {
    console.error(
      '[REKLAM KAYDETME HATASI]',
      error
    );

    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message:
          'Bu reklam konumu için zaten bir kayıt bulunuyor.'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Reklam kaydedilemedi.'
    });
  }
}

// Yeni güvenli yönetim adresi
app.put(
  '/api/admin/ads/:position',
  authMiddleware,
  adminOnlyMiddleware,
  saveAdHandler
);

// Eski admin paneli için geçici uyumluluk.
// Admin paneli güncellendikten sonra kaldırılabilir.
app.post(
  '/api/ads/:position',
  authMiddleware,
  adminOnlyMiddleware,
  saveAdHandler
);
// =====================================================
// MANUEL KAYNAK TARAMA
// Yalnızca ana yönetici, POST isteğiyle başlatabilir.
// =====================================================

let isManualSyncRunning = false;

app.post(
  '/api/sync',
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    if (isManualSyncRunning) {
      return res.status(409).json({
        success: false,
        message:
          'Manuel kaynak taraması zaten devam ediyor.'
      });
    }

    isManualSyncRunning = true;

    res.json({
      success: true,
      message:
        'Kaynak tarama işlemi güvenli şekilde arka planda başlatıldı.'
    });

    try {
      await syncAllSources();
    } catch (error) {
      console.error(
        '[MANUEL TARAMA HATASI]',
        error
      );
    } finally {
      isManualSyncRunning = false;
    }
  }
);


// =====================================================
// KAYNAKLARI SIFIRLAMA
// Yalnızca ana yönetici, POST ve açık onay ile kullanabilir.
// =====================================================

let isSourceResetRunning = false;

app.post(
  '/api/reset-sources',
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      if (req.body.confirm !== 'RESET_SOURCES') {
        return res.status(400).json({
          success: false,
          message:
            'Sıfırlama işlemi için confirm alanına RESET_SOURCES yazılmalıdır.'
        });
      }

      if (isSourceResetRunning) {
        return res.status(409).json({
          success: false,
          message:
            'Kaynak sıfırlama işlemi zaten devam ediyor.'
        });
      }

      isSourceResetRunning = true;

      res.json({
        success: true,
        message:
          'Kaynak sıfırlama işlemi yetkili yönetici tarafından başlatıldı.'
      });

      try {
        await Source.deleteMany({});
        await News.deleteMany({});
        await Category.deleteMany({});

        for (const categoryName of defaultCategories) {
          await Category.updateOne(
            {
              name: categoryName
            },
            {
              $setOnInsert: {
                name: categoryName
              }
            },
            {
              upsert: true
            }
          );
        }

        for (const source of initialSources) {
          await Source.updateOne(
            {
              name: source.name
            },
            {
              $set: source
            },
            {
              upsert: true
            }
          );
        }

        console.log(
          `[KAYNAK SIFIRLAMA] İşlem ${req.user.username} tarafından gerçekleştirildi.`
        );

        await syncAllSources();
      } catch (error) {
        console.error(
          '[KAYNAK SIFIRLAMA HATASI]',
          error
        );
      } finally {
        isSourceResetRunning = false;
      }
    } catch (error) {
      isSourceResetRunning = false;

      console.error(
        '[SIFIRLAMA İSTEĞİ HATASI]',
        error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message:
            'Kaynak sıfırlama işlemi başlatılamadı.'
        });
      }
    }
  }
);


// HABERLER API
app.get('/api/news', async (req, res) => {
  try {
    const {
      category,
      source,
      sources,
      search,
      sort,
      page = '1',
      limit = '100'
    } = req.query;

    const twentyFourHoursAgo = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    );

    const filter = {
      pubDate: {
        $gte: twentyFourHoursAgo,
        $lte: new Date()
      }
    };

    if (category && category !== 'Tümü') {
      filter.category = category;
    }

    const activeSrc = source || sources;
    if (activeSrc && activeSrc !== 'Tümü') {
      const srcList = activeSrc
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 100);

      if (srcList.length > 0) {
        filter.source = { $in: srcList };
      }
    }

    if (search && search.trim()) {
      const safeSearch = search
        .trim()
        .slice(0, 100)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      filter.$or = [
        { title: { $regex: safeSearch, $options: 'i' } },
        { description: { $regex: safeSearch, $options: 'i' } }
      ];
    }

    const requestedPage = Number.parseInt(page, 10);
    const requestedLimit = Number.parseInt(limit, 10);
    const currentPage = Number.isInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
    const pageSize = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 100;

    let sortObj = { pubDate: -1, _id: -1 };
    if (sort === 'rating') {
      sortObj = { views: -1, pubDate: -1, _id: -1 };
    }

    const total = await News.countDocuments(filter);
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

    const news = await News.find(filter)
      .sort(sortObj)
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize)
      .lean();

    return res.json({
      success: true,
      data: news,
      pagination: {
        page: currentPage,
        limit: pageSize,
        total,
        totalPages,
        hasMore: currentPage < totalPages
      },
      periodHours: 24
    });
  } catch (err) {
    console.error('Haber getirme API hatası:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Haberler şu anda yüklenemiyor.',
      data: []
    });
  }
});

// Okunma / Tıklanma Sayacı
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

// Analitik
app.get('/api/analytics', async (req, res) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const filter24h = { pubDate: { $gte: twentyFourHoursAgo } };

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

// KATEGORİLER
app.get('/api/categories', async (req, res) => {
  try {
    let cats = await Category.find().sort({ name: 1 });
    if (!cats || cats.length === 0) {
      for (const c of defaultCategories) {
        await Category.create({ name: c }).catch(() => {});
      }
      cats = await Category.find().sort({ name: 1 });
    }
    const catList = cats.map(c => c.name);
    res.json(catList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.delete('/api/categories/:name', authMiddleware, async (req, res) => {
  try {
    const { name } = req.params;
    await Category.findOneAndDelete({ name });
    res.json({ success: true, message: 'Kategori silindi' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// KAYNAKLAR
app.get('/api/sources', async (req, res) => {
  try {
    let sources = await Source.find()
      .select('name type url selector category lang isActive createdAt')
      .sort({ name: 1 });
    if (!sources || sources.length === 0) {
      await Source.insertMany(initialSources);
      sources = await Source.find()
        .select('name type url selector category lang isActive createdAt')
        .sort({ name: 1 });
    }
    res.json(sources);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/sources-health', authMiddleware, async (req, res) => {
  try {
    const sources = await Source.find().sort({ name: 1 }).lean();
    res.json({ success: true, data: sources });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Kaynak sağlık bilgileri alınamadı.' });
  }
});

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

app.post('/api/admin/sources/:id/test', authMiddleware, async (req, res) => {
  try {
    const source = await Source.findById(req.params.id);
    if (!source) {
      return res.status(404).json({ success: false, message: 'Kaynak bulunamadı.' });
    }

    const result = source.type === 'html'
      ? await scrapeHtmlSite(source.name, source.url, source.category, source.selector, source.lang)
      : await fetchRssFeed(source.name, source.url, source.category, source.lang);

    const refreshedSource = await Source.findById(source._id).lean();
    return res.status(result.success ? 200 : 422).json({
      success: result.success,
      message: result.success
        ? `${source.name} başarıyla test edildi. ${result.count} haber işlendi.`
        : `${source.name} testinde hata oluştu: ${result.error}`,
      data: refreshedSource
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Kaynak testi tamamlanamadı.' });
  }
});

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

app.delete('/api/sources/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await Source.findByIdAndDelete(id);
    res.json({ success: true, message: 'Kaynak silindi' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Talepler
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

app.get('/api/requests', authMiddleware, async (req, res) => {
  try {
    const requests = await Request.find().sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/requests/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await Request.findByIdAndDelete(id);
    res.json({ success: true, message: 'Talep silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Personel
app.get(
  '/api/users',
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(
  '/api/users',
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
  try {
    const { username, password, fullname, role } = req.body;
    if (!username || !password || !fullname) {
      return res.status(400).json({ success: false, message: 'Tüm alanları doldurunuz.' });
    }
    if (String(password).length < 12) {
  return res.status(400).json({
    success: false,
    message:
      'Yeni kullanıcı şifresi en az 12 karakter olmalıdır.'
  });
}
    const exist = await User.findOne({ username: username.trim() });
    if (exist) return res.status(400).json({ success: false, message: 'Bu kullanıcı adı zaten alınmış.' });

    const hashedPassword = await bcrypt.hash(
  password,
  12
);
    await User.create({
      username: username.trim(),
      password: hashedPassword,
      fullname: fullname.trim(),
      role: role === 'admin'
  ? 'admin'
  : 'staff'
    });
    res.json({ success: true, message: 'Personel oluşturuldu.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete(
  '/api/users/:id',
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
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

// Şifre Değiştir
app.post('/api/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 12) {
      return res.status(400).json({ success: false, message: 'Yeni şifre en az 12 karakter olmalıdır.' });
    }
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: 'Mevcut şifreniz hatalı.' });

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ success: true, message: 'Şifreniz başarıyla güncellendi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Giriş Yap
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

app.listen(PORT, () => {
  console.log(`Haber Takip Portalı http://localhost:${PORT} adresinde yayında!`);
});
