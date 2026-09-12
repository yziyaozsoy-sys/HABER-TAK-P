require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  fullname: { type: String, required: true },
  role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

async function main() {
  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGO_URL;

  if (!mongoUri) {
    throw new Error(
      'MongoDB bağlantı değişkeni bulunamadı: MONGODB_URI, MONGO_URI veya MONGO_URL'
    );
  }

  const currentUsername = String(
    process.env.RESET_CURRENT_ADMIN_USERNAME || ''
  ).trim();

  const newUsername = String(
    process.env.RESET_NEW_ADMIN_USERNAME || ''
  ).trim();

  const newFullname = String(
    process.env.RESET_NEW_ADMIN_FULLNAME || 'Sistem Yöneticisi'
  ).trim();

  const newPassword = String(
    process.env.RESET_NEW_ADMIN_PASSWORD || ''
  );

  if (!currentUsername || !newUsername || !newFullname || !newPassword) {
    throw new Error('Gerekli sıfırlama bilgileri eksik.');
  }

  if (newUsername.length < 3) {
    throw new Error('Yeni kullanıcı adı en az 3 karakter olmalıdır.');
  }

  if (newPassword.length < 12) {
    throw new Error('Yeni parola en az 12 karakter olmalıdır.');
  }

  await mongoose.connect(mongoUri);

  const admin = await User.findOne({
    username: currentUsername,
    role: 'admin'
  });

  if (!admin) {
    throw new Error(
      'Belirtilen kullanıcı adına sahip yönetici hesabı bulunamadı.'
    );
  }

  const conflictingUser = await User.findOne({
    username: newUsername,
    _id: { $ne: admin._id }
  });

  if (conflictingUser) {
    throw new Error('Yeni kullanıcı adı başka bir hesap tarafından kullanılıyor.');
  }

  admin.username = newUsername;
  admin.fullname = newFullname;
  admin.password = await bcrypt.hash(newPassword, 12);
  admin.role = 'admin';

  await admin.save();

  console.log('Yönetici giriş bilgileri başarıyla güncellendi.');
  console.log('Kullanıcı adı:', admin.username);
  console.log('Ad soyad:', admin.fullname);
  console.log('Rol:', admin.role);
}

main()
  .catch((error) => {
    console.error('Güncelleme başarısız:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
