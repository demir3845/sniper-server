# Meme Coin Sniper Server

DexScreener WebSocket + REST polling ile 1–15 dakikalık yeni coinleri yakalar,
smart money analizi yapar, SSE (Server-Sent Events) ile browser'a push eder.

## Mimari

```
DexScreener WS (token-profiles)
        +
DexScreener REST polling (her 15sn)
        ↓
  Node.js server.js
  • 1-15dk filtresi
  • Smart money analizi
  • SSE broadcast
        ↓
  client.html (browser)
  • Canlı kart akışı
  • Ses uyarısı (HOT coin)
```

---

## Yerel Kurulum (Test için)

```bash
# 1. Klasöre gir
cd sniper-server

# 2. Paketleri yükle
npm install

# 3. Çalıştır (varsayılan: Solana)
npm start

# Farklı zincir için:
CHAIN=ethereum npm start
```

Sunucu `http://localhost:3001` adresinde çalışır.
`client.html` dosyasını doğrudan tarayıcıda aç.

---

## Railway Deploy (Ücretsiz, 7/24)

### Adım 1 — GitHub reposu oluştur
```bash
git init
git add .
git commit -m "sniper server"
# GitHub'da yeni repo aç, push et
git remote add origin https://github.com/KULLANICI_ADI/sniper-server.git
git push -u origin main
```

### Adım 2 — Railway'e deploy et
1. https://railway.app adresine git → "New Project"
2. "Deploy from GitHub repo" → repoyu seç
3. Railway otomatik `npm start` çalıştırır

### Adım 3 — Zincir ayarla (Environment Variables)
Railway dashboard → Variables:
```
CHAIN=solana
PORT=3001
```

### Adım 4 — Public URL al
Railway → Settings → Networking → "Generate Domain"
URL şöyle görünür: `https://sniper-server-production-xxxx.up.railway.app`

### Adım 5 — client.html güncelle
`client.html` içindeki şu satırı bul:
```js
const SERVER_URL = "http://localhost:3001";
```
Railway URL'in ile değiştir:
```js
const SERVER_URL = "https://sniper-server-production-xxxx.up.railway.app";
```

`client.html`'i tarayıcıda aç → canlı coin akışı başlar.

---

## API Endpoint'leri

| Endpoint   | Açıklama                              |
|------------|---------------------------------------|
| GET /stream | SSE akışı — frontend buraya bağlanır |
| GET /health | Sunucu sağlık kontrolü               |
| GET /snapshot | Cache durumu                       |
| POST /scan | Manuel tarama tetikle                 |

---

## Skor Ağırlıkları

| Boyut        | Ağırlık | Hesaplama                          |
|-------------|---------|-------------------------------------|
| Likidite    | %28     | USD likidite miktarı               |
| Smart Money | %28     | TX başına hacim + buy baskısı      |
| TX Çeşitlilik | %22   | 1s işlem sayısı + buy/sell oranı  |
| Momentum    | %22     | 5dk/1s fiyat değişimi + hacim      |

**HOT coin:** Toplam ≥ 75 VE Smart Money skoru ≥ 70

---

## Filtreler (server.js içinde değiştirilebilir)

```js
const ageMin = ageMs / 60000;
if (ageMin < 1 || ageMin > 15) return null;   // Yaş filtresi
if (smS < 55) return null;                     // Smart money eşiği
if (total < 52) return null;                   // Min toplam skor
```

---

## Notlar

- DexScreener public API — key gerekmez, dakikada 300 istek limiti var
- Railway ücretsiz tier: 500 saat/ay (tek proje için yeterli)
- Render.com veya Fly.io da kullanılabilir, kurulum aynı
- Telegram bildirimi eklemek için `node-telegram-bot-api` paketi kullanılabilir
