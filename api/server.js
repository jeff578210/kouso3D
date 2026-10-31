// Mouth Exercises Game — Stats API
// 接收前端遊戲結算統計,寫進 SQL Server。
//
// 啟動:
//   npm install
//   cp .env.example .env  (填好 SQL 連線資訊)
//   npm start
//
// 部署:見 README.md
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');

const app = express();
app.use(express.json({ limit: '64kb' }));

// CORS:預設允許所有來源(內網部署無妨);上線時把 ALLOWED_ORIGINS 改成你的前端網域
const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} 未允許`));
  },
}));

// SQL Server 連線設定(從 .env 讀)
const dbConfig = {
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server:   process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port:     parseInt(process.env.DB_PORT || '1433', 10),
  options: {
    encrypt: (process.env.DB_ENCRYPT || 'true') === 'true',          // Azure SQL 必須 true
    trustServerCertificate: (process.env.DB_TRUST_CERT || 'false') === 'true', // 自簽憑證才 true
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

// 簡易頻率限制:每個 IP 每分鐘最多 N 次,防止有人大量灌資料或掃描紀錄(不需額外套件)
// Azure App Service 的 X-Forwarded-For 是「IP:port」格式,要去掉 port 才能辨識同一個人
function clientIp(req) {
  const raw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));         // [IPv6]:port
  return raw.replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1');           // IPv4:port
}

function rateLimit(maxPerMinute) {
  const hits = new Map(); // ip -> 這一分鐘內的請求時間
  setInterval(() => {
    const cutoff = Date.now() - 60000;
    for (const [ip, times] of hits) {
      const recent = times.filter(t => t > cutoff);
      recent.length ? hits.set(ip, recent) : hits.delete(ip);
    }
  }, 60000).unref();
  return (req, res, next) => {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => t > now - 60000);
    if (recent.length >= maxPerMinute) {
      res.set('Retry-After', '60');
      return res.status(429).json({ ok: false, error: '請求太頻繁,請稍後再試' });
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}

let poolPromise;
async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(dbConfig).then(pool => {
      console.log('✅ SQL Server 連線成功');
      return pool;
    }).catch(err => {
      console.error('❌ SQL Server 連線失敗:', err.message);
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

// 健康檢查 — 部署後可用 curl 驗證
app.get('/api/health', rateLimit(60), async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query('SELECT 1 AS ok');
    res.json({ ok: true, db: r.recordset[0].ok === 1 });
  } catch (e) {
    console.error('健康檢查失敗:', e);
    res.status(503).json({ ok: false, error: '資料庫暫時無法連線' }); // 不把內部錯誤細節回給前端
  }
});

// 收結算統計
app.post('/api/game-stats', rateLimit(30), async (req, res) => {
  const { playerName, mode, difficulty, stats, playedAt } = req.body || {};

  // 基本驗證
  if (!playerName || typeof playerName !== 'string' || playerName.length > 50)
    return res.status(400).json({ ok: false, error: 'playerName 缺少或過長' });
  if (!['tongue', 'mouth', 'voice'].includes(mode))
    return res.status(400).json({ ok: false, error: 'mode 必須是 tongue/mouth/voice' });
  if (!['tutorial', 'easy', 'medium', 'hard'].includes(difficulty))
    return res.status(400).json({ ok: false, error: 'difficulty 必須是 tutorial/easy/medium/hard' });
  if (!stats || typeof stats !== 'object')
    return res.status(400).json({ ok: false, error: 'stats 缺少' });

  // 計算總計
  let totalSuccess = 0, totalFail = 0;
  for (const k in stats) {
    totalSuccess += Number(stats[k]?.success) || 0;
    totalFail    += Number(stats[k]?.fail)    || 0;
  }
  const totalAttempts = totalSuccess + totalFail;
  const achievementRate = totalAttempts > 0 ? +(totalSuccess / totalAttempts * 100).toFixed(2) : 0;

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('PlayerName',      sql.NVarChar(50),  playerName)
      .input('Mode',            sql.NVarChar(20),  mode)
      .input('Difficulty',      sql.NVarChar(20),  difficulty)
      .input('TotalSuccess',    sql.Int,           totalSuccess)
      .input('TotalFail',       sql.Int,           totalFail)
      .input('AchievementRate', sql.Decimal(5, 2), achievementRate)
      .input('PlayedAt',        sql.DateTime2,     isNaN(new Date(playedAt)) ? new Date() : new Date(playedAt))
      .input('RawStatsJson',    sql.NVarChar(sql.MAX), JSON.stringify(stats))
      .query(`
        INSERT INTO GameSessions
          (PlayerName, Mode, Difficulty, TotalSuccess, TotalFail, AchievementRate, PlayedAt, RawStatsJson)
        OUTPUT INSERTED.Id
        VALUES
          (@PlayerName, @Mode, @Difficulty, @TotalSuccess, @TotalFail, @AchievementRate, @PlayedAt, @RawStatsJson);
      `);
    res.json({
      ok: true,
      id: result.recordset[0].Id,
      totalSuccess, totalFail, achievementRate,
    });
  } catch (e) {
    console.error('插入失敗:', e);
    res.status(500).json({ ok: false, error: '寫入失敗,請稍後再試' }); // 不把資料庫錯誤細節回給前端
  }
});

// 查詢:單一玩家的歷史紀錄(「查看我的訓練紀錄」用)。
// 一定要指定玩家,不再提供「不帶名字就回傳所有人紀錄」的查法
app.get('/api/game-stats', rateLimit(60), async (req, res) => {
  const player = (req.query.player || '').toString().trim().slice(0, 50);
  if (!player) return res.status(400).json({ ok: false, error: '缺少 player 參數' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('Limit',  sql.Int,           limit)
      .input('Player', sql.NVarChar(50),  player)
      .query(`
        SELECT TOP (@Limit)
          Id, PlayerName, Mode, Difficulty,
          TotalSuccess, TotalFail, AchievementRate,
          PlayedAt, CreatedAt
        FROM GameSessions
        WHERE PlayerName = @Player
        ORDER BY CreatedAt DESC;
      `);
    res.json({ ok: true, rows: r.recordset });
  } catch (e) {
    console.error('查詢失敗:', e);
    res.status(500).json({ ok: false, error: '查詢失敗,請稍後再試' });
  }
});

// 統一錯誤處理:不把錯誤堆疊回給前端(CORS 拒絕的來源回 403)
app.use((err, req, res, next) => {
  console.error('請求錯誤:', err.message);
  const forbidden = /未允許/.test(err.message || '');
  const status = forbidden ? 403 : (err.status || 500); // 例:格式錯誤的 JSON 由 express 標成 400
  res.status(status).json({ ok: false, error: forbidden ? '來源不被允許' : status < 500 ? '請求格式錯誤' : '伺服器錯誤' });
});

// 注意:Windows App Service (iisnode) 給的 PORT 是具名管道路徑(字串),不是數字。
// 直接傳給 app.listen,Node 兩種型別都吃。
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Mouth Exercises API 啟動於 ${PORT}`));
