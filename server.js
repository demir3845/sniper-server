import fetch   from "node-fetch";
import express from "express";
import cors    from "cors";
import { createServer } from "http";
 
const app  = express();
app.use(cors());
app.use(express.json());
 
const PORT  = process.env.PORT  || 3001;
const CHAIN = (process.env.CHAIN || "solana").toLowerCase();
 
const clients = new Set();
 
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  }
}
 
const seen    = new Map();
const SEEN_TTL = 30 * 60 * 1000;
 
function analyzePair(p) {
  const now    = Date.now();
  const ageMs  = p.pairCreatedAt ? now - p.pairCreatedAt : null;
  if (!ageMs) return null;
 
  const ageMin = ageMs / 60000;
  if (ageMin < 0.5 || ageMin > 180) return null; // sadece çok eski ve çok yeni olanları at
 
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
  const vpt  = tx1h > 0 ? v1h / tx1h : 0;
 
  const liqS = liq > 80000 ? 92 : liq > 40000 ? 82 : liq > 15000 ? 70 : liq > 5000 ? 55 : 25;
 
  let smS = vpt > 8000 ? 92 : vpt > 3000 ? 82 : vpt > 1000 ? 70 : vpt > 300 ? 55 : 22;
  if (b5 > s5 * 2)  smS = Math.min(smS + 12, 96);
  if (buyR > 0.65)  smS = Math.min(smS +  8, 96);
 
  let txS = tx1h > 300 ? 88 : tx1h > 100 ? 75 : tx1h > 40 ? 60 : tx1h > 15 ? 45 : 20;
  if (buyR > 0.80 || buyR < 0.20) txS = Math.max(txS - 18, 10);
 
  let momS = (pc5 > 15 && v5 > 500) ? 92 : pc5 > 8 ? 80 : pc5 > 3 ? 68 : pc5 > 0 ? 55 : 28;
  if (pc1h > 30)  momS = Math.min(momS + 15, 96);
  if (pc1h < -15) momS = Math.max(momS - 20, 10);
 
  const total = Math.round(liqS * 0.28 + txS * 0.22 + smS * 0.28 + momS * 0.22);
 
  const signals = [];
  if (ageMin < 5)        signals.push({ type: "warn",  text: `${Math.floor(ageMin)}dk yeni` });
  if (smS >= 80)         signals.push({ type: "smart", text: "Smart money güçlü" });
  if (smS >= 60)         signals.push({ type: "smart", text: "Smart money var" });
  if (liq > 40000)       signals.push({ type: "good",  text: "Derin likidite" });
  if (liq > 10000)       signals.push({ type: "good",  text: "Likidite yeterli" });
  if (pc5 > 10)          signals.push({ type: "good",  text: "Pump başladı" });
  if (buyR > 0.60)       signals.push({ type: "good",  text: "Buy baskısı var" });
  if (b5 > s5 * 2)       signals.push({ type: "smart", text: "5dk whale alımı" });
  if (liq < 5000)        signals.push({ type: "bad",   text: "Düşük likidite" });
 
  return {
    id:     p.pairAddress,
    name:   p.baseToken?.name   || "—",
    ticker: "$" + (p.baseToken?.symbol || "?"),
    chain:  p.chainId,
    dex:    p.dexId,
    ageMin: Math.round(ageMin * 10) / 10,
    price:  p.priceUsd ? parseFloat(p.priceUsd) : 0,
    pc5, pc1h,
    liq, v5, v1h, tx1h,
    buyPct: Math.round(buyR * 100),
    vpt:    Math.round(vpt),
    scores: { liq: liqS, smart: smS, tx: txS, mom: momS },
    total,
    isHot:  total >= 75 && smS >= 70,
    signals,
    url:    p.url || `https://dexscreener.com/${p.chainId}/${p.pairAddress}`,
    seenAt: now,
  };
}
 
function maybeEmit(pair) {
  if (!pair) return;
  const last = seen.get(pair.id);
  if (last && Date.now() - last < SEEN_TTL) return;
  seen.set(pair.id, Date.now());
  console.log(`[+] ${pair.ticker} | skor:${pair.total} | smart:${pair.scores.smart} | ${pair.ageMin}dk`);
  broadcast("pair", pair);
}
 
const QUERIES = [
  "pepe","doge","cat","inu","moon","rat","frog","pump",
  "baby","king","turbo","chad","wojak","based","bonk",
  "wif","bome","slerf","sol","meme","coin","ape","shib"
];
let queryIdx = 0, scanCount = 0;
 
async function pollOnce() {
  const batch = [0,1,2,3].map(o => QUERIES[(queryIdx + o) % QUERIES.length]);
  queryIdx = (queryIdx + 4) % QUERIES.length;
 
  const fetches = batch.map(q =>
    fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`, { timeout: 10000 })
    .then(r => r.ok ? r.json() : null).catch(() => null)
  );
 
  const results = await Promise.allSettled(fetches);
  let found = 0;
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value?.pairs) continue;
    for (const p of r.value.pairs) {
      if (p.chainId !== CHAIN) continue;
      const a = analyzePair(p);
      if (a) { maybeEmit(a); found++; }
    }
  }
 
  scanCount++;
  if (scanCount % 5 === 0) console.log(`[TARAMA #${scanCount}] bulunan:${found} | cache:${seen.size} | istemci:${clients.size}`);
  broadcast("heartbeat", { scanCount, found, ts: Date.now() });
}
 
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();
  res.write(`event: status\ndata: ${JSON.stringify({ connected: true, chain: CHAIN })}\n\n`);
  clients.add(res);
  console.log(`[SSE] bağlandı — toplam: ${clients.size}`);
  req.on("close", () => { clients.delete(res); });
});
 
app.post("/scan", async (req, res) => {
  await pollOnce();
  res.json({ ok: true, scanCount });
});
 
app.get("/health", (_, res) => res.json({
  ok: true, chain: CHAIN, clients: clients.size,
  scanCount, cached: seen.size, uptime: Math.round(process.uptime())
}));
 
createServer(app).listen(PORT, () => {
  console.log(`\n🚀 Sniper sunucu: http://localhost:${PORT} | Zincir: ${CHAIN}\n`);
  pollOnce();
  setInterval(pollOnce, 8000);
  setInterval(() => {
    const now = Date.now();
    for (const [k,v] of seen) if (now - v > SEEN_TTL) seen.delete(k);
  }, 5 * 60 * 1000);
});
