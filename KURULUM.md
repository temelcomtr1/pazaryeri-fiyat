# Pazaryeri Fiyatlandırma — Ücretsiz Kurulum (GitHub Pages + Supabase)

- **GitHub Pages**: Sayfanın yayınlandığı yer (ücretsiz).
- **Supabase**: E-posta ile giriş ve verilerin (ürünler, ayarlar, kullanıcılar) tutulduğu yer (ücretsiz plan).

Toplam 5 adım.

---

## 1. Supabase projesi ve veritabanı

1. https://supabase.com adresine girin, **Start your project** ile (GitHub hesabınızla da olur) kaydolun.
2. **New project**:
   - Name: `pazaryeri-fiyat`
   - Database Password: güçlü bir parola (not alın, uygulama için gerekmez)
   - Region: **Central EU (Frankfurt)** (Türkiye'ye en yakın)
   - **Create new project** → 1-2 dakika hazırlanmasını bekleyin.
3. Sol menüden **SQL Editor** → **New query**.
4. `supabase-kurulum.sql` dosyasını Not Defteri ile açın, **tamamını** kopyalayıp buraya yapıştırın → **Run**.
   "Success. No rows returned" yazmalı.

## 2. Bağlantı bilgilerini config.js'e yazın

1. Supabase'de sol menüden **Project Settings** (dişli) → **API Keys** (veya üstteki **Connect** butonu).
2. İki bilgiyi kopyalayın:
   - **Project URL** — `https://xxxxx.supabase.co` biçiminde (Project Settings → Data API sayfasında da yazar)
   - **anon public** anahtarı — `eyJ...` ile başlayan uzun yazı (**Legacy API Keys** sekmesinde)
3. `config.js` dosyasını Not Defteri ile açıp iki satırı doldurun:
   ```js
   SUPABASE_URL: 'https://xxxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJhbGciOi...',
   ```
   Kaydedin. (**service_role** anahtarını ASLA yazmayın.)

## 3. GitHub'a yükleyin ve Pages'i açın

1. https://github.com → sağ üst **+** → **New repository**
   - Repository name: `pazaryeri-fiyat`
   - **Public** seçin (ücretsiz Pages için gerekli; verileriniz Supabase'de korunur, kodda gizli bilgi yoktur)
   - **Create repository**
2. **uploading an existing file** bağlantısı → klasördeki dosyaların **hepsini** sürükleyin
   (`index.html`, `app.js`, `calc.js`, `config.js`, `style.css` …) → **Commit changes**.
3. Depoda **Settings** → sol menü **Pages**
   - Source: **Deploy from a branch**
   - Branch: **main**, klasör: **/ (root)** → **Save**
4. 1-2 dakika sonra aynı sayfanın üstünde adresiniz çıkar:
   `https://KULLANICI-ADINIZ.github.io/pazaryeri-fiyat/`

## 4. Supabase'e sayfa adresini tanıtın

Supabase → **Authentication** → **URL Configuration**:
- **Site URL**: `https://KULLANICI-ADINIZ.github.io/pazaryeri-fiyat/`
- **Redirect URLs** → Add URL: aynı adres → Save

(Onay ve parola sıfırlama e-postalarındaki bağlantılar bu adrese döner.)

## 5. İlk giriş — yönetici hesabı

1. Sayfanızı açın → **Hesap oluştur** → adınız, e-postanız, parolanız.
2. Gelen onay e-postasındaki bağlantıya tıklayın.
3. Giriş yapın. **İlk kaydolan kişi otomatik olarak yönetici olur** — bu yüzden adresi başkasıyla paylaşmadan önce
   ilk hesabı siz açın.

### Çalışan ekleme
Çalışanlar aynı adresten **Hesap oluştur** ile kaydolur. Siz **Kullanıcılar** sekmesinden **Onayla / aktifleştir**
dersiniz. Onaylanmayan hesap hiçbir veriyi göremez.

---

## Bilmeniz gerekenler

- **Supabase ücretsiz plan**, 7 gün boyunca hiç kullanılmayan projeyi duraklatır. Panelden tek tıkla tekrar açılır;
  her gün kullanılan bir uygulamada sorun olmaz.
- Supabase'in kendi e-posta gönderimi ücretsiz planda **saatte birkaç e-posta** ile sınırlıdır. Birkaç kişilik ekip için
  yeterlidir. Kalabalık kayıt yapılacaksa Authentication → Emails bölümünden kendi SMTP'nizi (ör. Gmail, Brevo) bağlayabilirsiniz.
- Dosyalarda değişiklik yapınca GitHub'da dosyayı tekrar yükleyin; sayfa 1-2 dakikada güncellenir.
- Yedek: Supabase → Table Editor → `products` → **Export to CSV**.
