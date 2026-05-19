/**
 * MEME COIN SNIPER SERVER
 * DexScreener REST polling — 1-15dk filtresi + smart money analizi
 * SSE ile frontend'e push eder.
 *
 * Deploy: Railway / Render / Fly.io (ücretsiz tier yeterli)
 */

import fetch   from "node-fetch";
import express from "express";
import cors    from "cors";
import { createServer } from "http";

const app  = express();
app.use(cors());
app.use(express.json());

const PORT  = process.env.PORT  || 3001;
const CHAIN = process.env.CHAIN || "solana"; // solana | ethereum | bsc | base

// ─── SSE istemci havuzu ───────────────────────────────────────────────
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}

// ─── Görülen pair cache — tekrar bildirme önleme ───────────────────────
const seen    = new Map();        // pairAddress → lastSeenAt
const SEEN_TTL = 20 * 60 * 1000; // 20 dk sonra tekrar göster

// ─── Analiz motoru ────────────────────────────────────────────────────
function analyzePair(p) {
  const now    = Date.now();
  const ageMs  = p.pairCreatedAt ? now - p.pairCreatedAt : null;
  if (!ageMs) return null;

  const ageMin = ageMs / 60000;
  if (ageMin < 1 || ageMin > 15) return null;   // ← 1-15 dk filtresi

  const liq  = p.liquidity?.usd   || 0;
  const v5   = p.volume?.m5       || 0;
  const v1h  = p.volume?.h1       || 0;
  const b5   = p.txns?.m5?.buys   || 0;
  const s5   = p.txns?.m5?.sells  || 0;
  const b1h  = p.txns?.h1?.buys   || 0;
  const s1h  = p.txns?.h1?.sells  || 0;
  const pc5  = p.priceChange?.m5  || 0;
  const pc1h = p.priceChange?.h1  || 0;
  const tx1h = b1h + s1h;
  const buyR = tx1h > 0 ? b1h / tx1h : 0.5;
  const vpt  = tx1h > 0 ? v1h / tx1h : 0; // TX başına hacim → smart money proxy

  // Likidite skoru
  const liqS = liq > 80000 ? 92 : liq > 40000 ? 82 : liq > 15000 ? 70
             : liq > 5000  ? 55 : 25;

  // Smart money skoru
  let smS = vpt > 8000 ? 92 : vpt > 3000 ? 82 : vpt > 1000 ? 70
          : vpt > 300  ? 55 : 22;
  if (b5 > s5 * 2)   smS = Math.min(smS + 12, 96);
  if (buyR > 0.65)   smS = Math.min(smS +  8, 96);
  if (smS < 55) return null;          // ← Smart money eşiği sağlanmıyor → geç

  // TX çeşitlilik skoru
  let txS = tx1h > 300 ? 88 : tx1h > 100 ? 75 : tx1h > 40 ? 60
          : tx1h > 15  ? 45 : 20;
  if (buyR > 0.80 || buyR < 0.20) txS = Math.max(txS - 18, 10);

  // Momentum skoru
  let momS = (pc5 > 15 && v5 > 500) ? 92 : pc5 > 8 ? 80 : pc5 > 3 ? 68
           : pc5 > 0 ? 55 : 28;
  if (pc1h > 30)  momS = Math.min(momS + 15, 96);
  if (pc1h < -15) momS = Math.max(momS - 20, 10);

  const total = Math.round(liqS * 0.28 + txS * 0.22 + smS * 0.28 + momS * 0.22);
  if (total < 52) return null;

  // Sinyal listesi
  const signals = [];
  if (ageMin < 5)          signals.push({ type: "warn",  text: `Ultra yeni — ${Math.floor(ageMin)}dk` });
  else                     signals.push({ type: "warn",  text: `${Math.floor(ageMin)}dk önce listelendi` });
  if (smS >= 80)           signals.push({ type: "smart", text: "Smart money güçlü" });
  if (liq > 40000)         signals.push({ type: "good",  text: "Derin likidite" });
  if (pc5 > 10)            signals.push({ type: "good",  text: "Pump başladı" });
  if (buyR > 0.70)         signals.push({ type: "good",  text: "Buy baskısı var" });
  if (b5 > s5 * 2.5)       signals.push({ type: "smart", text: "5dk whale alımı" });
  if (vpt > 3000)          signals.push({ type: "smart", text: "Büyük TX boyutu" });
  if (liq < 8000)          signals.push({ type: "bad",   text: "Düşük likidite" });

  return {
    id:      p.pairAddress,
    name:    p.baseToken?.name   || "—",
    ticker:  "$" + (p.baseToken?.symbol || "?"),
    chain:   p.chainId,
    dex:     p.dexId,
    ageMin:  Math.round(ageMin * 10) / 10,
    price:   p.priceUsd ? parseFloat(p.priceUsd) : 0,
    pc5, pc1h,
    liq, v5, v1h, tx1h,
    buyPct:  Math.round(buyR * 100),
    vpt:     Math.round(vpt),
    scores:  { liq: liqS, smart: smS, tx: txS, mom: momS },
    total,
    isHot:   total >= 75 && smS >= 70,
    signals,
    url:     p.url || `https://dexscreener.com/${p.chainId}/${p.pairAddress}`,
    seenAt:  now,
  };
}

function maybeEmit(pair) {
  if (!pair) return;
  const last = seen.get(pair.id);
  if (last && Date.now() - last < SEEN_TTL) return;  // Daha önce gösterdik
  seen.set(pair.id, Date.now());
  console.log(`[SINYAL] ${pair.ticker} | skor:${pair.total} | smart:${pair.scores.smart} | ${pair.ageMin}dk | liq:$${Math.round(pair.liq)}`);
  broadcast("pair", pair);
}

// ─── REST Polling: çoklu sorgu rotasyonu ─────────────────────────────
const QUERIES = [
  "pepe","doge","cat","inu","moon","rat","frog","pump",
  "baby","king","turbo","chad","wojak","based","bonk",
  "wif","bome","slerf","retard","gigachad"
];
let queryIdx   = 0;
let scanCount  = 0;

async function pollOnce() {
  // Her turda 3 paralel sorgu gönder
  const batch = [0, 1, 2].map(offset => QUERIES[(queryIdx + offset) % QUERIES.length]);
  queryIdx = (queryIdx + 3) % QUERIES.length;

  const fetches = batch.map(q =>
    fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`, {
      headers: { "User-Agent": "sniper-radar/1.0" },
      timeout: 10000,
    })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
  );

  const results = await Promise.allSettled(fetches);
  let found = 0;

  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value?.pairs) continue;
    for (const p of r.value.pairs) {
      if (p.chainId !== CHAIN) continue;
      const analyzed = analyzePair(p);
      if (analyzed) { maybeEmit(analyzed); found++; }
    }
  }

  scanCount++;
  if (scanCount % 10 === 0) {
    console.log(`[TARAMA #${scanCount}] sorgu:${batch.join(",")} | bulunan:${found} | istemci:${clients.size}`);
  }
  broadcast("heartbeat", { scanCount, ts: Date.now() });
}

// ─── HTTP endpoint'leri ───────────────────────────────────────────────

// SSE akışı — frontend buraya bağlanır
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  res.write(`event: status\ndata: ${JSON.stringify({ connected: true, chain: CHAIN })}\n\n`);
  clients.add(res);
  console.log(`[SSE] yeni istemci bağlandı — toplam: ${clients.size}`);

  req.on("close", () => {
    clients.delete(res);
    console.log(`[SSE] istemci ayrıldı — toplam: ${clients.size}`);
  });
});

// Manuel anlık tarama
app.post("/scan", async (req, res) => {
  await pollOnce();
  res.json({ ok: true, scanCount });
});

// Durum
app.get("/health", (_, res) => res.json({
  ok: true, chain: CHAIN, clients: clients.size,
  scanCount, cached: seen.size, uptime: Math.round(process.uptime())
}));

// ─── Başlat ───────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
  console.log(`\n🚀 Sniper sunucu: http://localhost:${PORT}`);
  console.log(`   Zincir : ${CHAIN}`);
  console.log(`   Stream : http://localhost:${PORT}/stream`);
  console.log(`   Sağlık : http://localhost:${PORT}/health\n`);

  // İlk taramayı hemen yap
  pollOnce();

  // Her 10 saniyede polling
  setInterval(pollOnce, 10_000);

  // Cache temizleme — her 5 dakika
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of seen) {
      if (now - v > SEEN_TTL) seen.delete(k);
    }
  }, 5 * 60 * 1000);
});
