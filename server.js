require('dotenv').config();
const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

// ── 安全設定 ──
// 每個 IP 每小時最多 20 次請求（防止濫用 API）
const rateLimit = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  if (!rateLimit.has(ip)) rateLimit.set(ip, { count: 0, reset: now + hour });
  const entry = rateLimit.get(ip);
  if (now > entry.reset) { entry.count = 0; entry.reset = now + hour; }
  entry.count++;
  return entry.count <= 20;
}
// 定期清理舊紀錄
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit) {
    if (now > entry.reset) rateLimit.delete(ip);
  }
}, 10 * 60 * 1000);

app.use(cors());

// 安全 HTTP 標頭
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 上線改為 20MB 節省資源
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('不支援的檔案格式'));
  }
});

// 確認 API Key 存在
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ 缺少 ANTHROPIC_API_KEY，請設定環境變數');
  process.exit(1);
}
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── 字型 ──
const FONTS_DIR = path.join(__dirname, 'fonts');
const FONT_REGULAR = path.join(FONTS_DIR, 'NotoSansTC-Regular.ttf');
const FONT_BOLD    = path.join(FONTS_DIR, 'NotoSansTC-Bold.ttf');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) return resolve();
    console.log(`下載字型：${path.basename(dest)} ...`);
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { try { fs.unlinkSync(dest); } catch(e){} reject(err); });
  });
}

async function ensureFonts() {
  if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR);
  await downloadFile(
    'https://github.com/google/fonts/raw/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf',
    FONT_REGULAR
  );
  if (!fs.existsSync(FONT_BOLD)) fs.copyFileSync(FONT_REGULAR, FONT_BOLD);
}

// ── 健康檢查（Railway 需要）──
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── 主要 API ──
app.post('/api/generate', (req, res, next) => {
  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: '請求太頻繁，請一小時後再試' });
  }
  next();
}, upload.fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'images', maxCount: 10 }
]), async (req, res) => {
  // 設定 90 秒逾時（AI 分析需要時間）
  req.setTimeout(90000);
  res.setTimeout(90000);

  try {
    const designerName = (req.body.designerName || '設計師').slice(0, 50); // 限制長度
    const pdfFile = req.files['pdf']?.[0];
    const imageFiles = req.files['images'] || [];

    if (!pdfFile) return res.status(400).json({ error: '請上傳 PDF 檔案' });

    const messageContent = [];
    messageContent.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfFile.buffer.toString('base64') }
    });
    for (const img of imageFiles.slice(0, 5)) { // 最多 5 張圖片送給 AI
      messageContent.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimetype, data: img.buffer.toString('base64') }
      });
    }
    messageContent.push({
      type: 'text',
      text: `你是一位專業的室內設計提案撰寫師。請根據以上 PDF 說明文件和設計圖片，為設計師「${designerName}」撰寫一份完整的設計提案報告。

請嚴格按照以下 JSON 格式回覆，不要有任何其他文字：
{
  "projectName": "專案名稱",
  "designerName": "${designerName}",
  "date": "今日日期（格式：YYYY/MM/DD）",
  "executiveSummary": "執行摘要（2-3段，說明設計理念與核心價值）",
  "designConcept": "設計概念說明（詳細描述設計風格、理念、靈感來源）",
  "spaceAnalysis": "空間分析（說明各區域規劃與功能配置）",
  "materialSelection": "材料與色彩計畫（說明主要材料、色調選擇與原因）",
  "timeline": [
    {"phase": "階段名稱", "duration": "時間", "description": "說明"}
  ],
  "budget": "預算概估與說明",
  "conclusion": "結語（感謝與期望）"
}`
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: messageContent }]
    });

    let proposalData;
    try {
      const text = response.content[0].text;
      proposalData = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (e) {
      return res.status(500).json({ error: 'AI 回應解析失敗，請再試一次' });
    }

    const pdfBuffer = await generateProposalPDF(proposalData, imageFiles);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''proposal_${encodeURIComponent(designerName)}.pdf`,
      'Content-Length': pdfBuffer.length
    });
    res.send(pdfBuffer);

  } catch (err) {
    console.error('[generate error]', err.message);
    if (err.status === 529 || err.message?.includes('overloaded')) {
      return res.status(503).json({ error: 'AI 服務暫時繁忙，請稍後再試' });
    }
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// multer 錯誤處理
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === '不支援的檔案格式') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ── PDF 產生 ──
function generateProposalPDF(data, imageFiles) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('TC', FONT_REGULAR);
    doc.registerFont('TC-Bold', FONT_BOLD);

    const W = doc.page.width - 120;
    const GOLD = '#C8A96E';
    const DARK = '#1a1a1a';
    const GRAY = '#444444';
    const LIGHT = '#888888';

    // 封面
    doc.rect(0, 0, doc.page.width, doc.page.height).fill('#0f0f11');
    doc.rect(60, 80, 4, 60).fill(GOLD);
    doc.font('Helvetica-Bold').fontSize(28).fillColor('#ffffff')
      .text('DESIGN', 75, 82).text('PROPOSAL', 75, 116);
    doc.font('TC').fontSize(13).fillColor(GOLD)
      .text(data.projectName || '設計提案', 75, 170);
    doc.font('TC').fontSize(10).fillColor('#aaaaaa')
      .text(`設計師：${data.designerName}`, 75, 200)
      .text(`日期：${data.date}`, 75, 220);
    if (imageFiles.length > 0) {
      try {
        doc.image(imageFiles[0].buffer, 60, 300, { width: W, height: 220, cover: [W, 220] });
        doc.rect(60, 300, W, 220).fillOpacity(0.35).fill('#000000');
        doc.fillOpacity(1);
      } catch (e) {}
    }
    doc.rect(60, doc.page.height - 60, W, 0.5).fill(GOLD);
    doc.font('Helvetica').fontSize(9).fillColor('#555555')
      .text('Confidential — For Client Use Only', 60, doc.page.height - 44);

    // 內容頁
    doc.addPage();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');
    let y = 60;

    const sectionTitle = (title) => {
      y += 18;
      doc.rect(60, y, 3, 18).fill(GOLD);
      doc.font('TC-Bold').fontSize(13).fillColor(DARK).text(title, 70, y + 1);
      y += 32;
    };
    const bodyText = (text) => {
      if (!text) return;
      doc.font('TC').fontSize(10).fillColor(GRAY).text(text, 60, y, { width: W, lineGap: 5 });
      y += doc.heightOfString(text, { width: W, lineGap: 5 }) + 18;
    };
    const checkPageBreak = (needed = 80) => {
      if (y + needed > doc.page.height - 80) {
        doc.addPage();
        doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');
        y = 60;
      }
    };

    doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD).text('DESIGN PROPOSAL', 60, y);
    doc.font('TC').fontSize(8).fillColor(LIGHT)
      .text(data.projectName || '', 200, y, { align: 'right', width: W - 140 });
    y += 22;
    doc.rect(60, y, W, 0.5).fill('#dddddd');
    y += 16;

    sectionTitle('執行摘要'); bodyText(data.executiveSummary);
    checkPageBreak(); sectionTitle('設計概念'); bodyText(data.designConcept);

    if (imageFiles.length > 0) {
      checkPageBreak(220);
      sectionTitle('設計圖片');
      const cols = Math.min(imageFiles.length, 2);
      const imgW = (W - 12) / cols;
      const imgH = 150;
      for (let i = 0; i < Math.min(imageFiles.length, 4); i++) {
        const col = i % cols, row = Math.floor(i / cols);
        const x = 60 + col * (imgW + 12), iy = y + row * (imgH + 12);
        try {
          doc.image(imageFiles[i].buffer, x, iy, { width: imgW, height: imgH, cover: [imgW, imgH] });
          doc.rect(x, iy, imgW, imgH).lineWidth(0.5).strokeColor('#dddddd').stroke();
        } catch (e) {}
      }
      y += Math.ceil(Math.min(imageFiles.length, 4) / cols) * (imgH + 12) + 8;
    }

    checkPageBreak(); sectionTitle('空間規劃分析'); bodyText(data.spaceAnalysis);
    checkPageBreak(); sectionTitle('材料與色彩計畫'); bodyText(data.materialSelection);

    if (data.timeline?.length) {
      checkPageBreak(120);
      sectionTitle('執行時程');
      data.timeline.forEach((item, i) => {
        checkPageBreak(55);
        doc.rect(60, y, 26, 26).fill(GOLD);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff')
          .text(String(i + 1), 60, y + 8, { width: 26, align: 'center' });
        doc.font('TC-Bold').fontSize(10).fillColor(DARK).text(item.phase, 94, y + 2);
        doc.font('TC').fontSize(9).fillColor(GOLD).text(item.duration, 94, y + 16);
        doc.font('TC').fontSize(9).fillColor(GRAY).text(item.description, 94, y + 28, { width: W - 40 });
        y += 52;
      });
    }

    checkPageBreak(); sectionTitle('預算概估'); bodyText(data.budget);
    checkPageBreak(); sectionTitle('結語'); bodyText(data.conclusion);

    const footerY = doc.page.height - 52;
    doc.rect(60, footerY, W, 0.5).fill('#dddddd');
    doc.font('TC').fontSize(8).fillColor(LIGHT)
      .text(`© ${new Date().getFullYear()} ${data.designerName}　本提案內容屬於機密資料`, 60, footerY + 10);
    doc.font('Helvetica').fontSize(8).fillColor(GOLD)
      .text('Proposal', 60, footerY + 10, { align: 'right', width: W });

    doc.end();
  });
}

// ── 啟動 ──
ensureFonts()
  .then(() => {
    console.log('✅ 字型就緒');
    app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('⚠️  字型下載失敗：', err.message);
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  });
