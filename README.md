# 🎨 AI 設計提案產生器

## 本機開發

### 1. 安裝依賴
```bash
npm install
```

### 2. 設定 .env（本機用）
```
ANTHROPIC_API_KEY=your_api_key_here
PORT=3001
```

### 3. 啟動
```bash
npm start
```
前往 http://localhost:3001

---

## 部署到 Railway（分享給朋友）

### 步驟一：上傳到 GitHub
1. 在 github.com 建立新 repository
2. 上傳所有檔案（不要上傳 .env 和 node_modules）

### 步驟二：部署
1. 前往 railway.app 用 GitHub 登入
2. New Project → Deploy from GitHub repo → 選你的 repo
3. 等待部署完成（約 2-3 分鐘）

### 步驟三：設定環境變數
在 Railway 專案 → Variables 新增：
ANTHROPIC_API_KEY = sk-ant-api03-xxxxx

### 步驟四：取得網址
Settings → Domains → 產生網址後分享給朋友！

## 安全功能
- 每個 IP 每小時限制 20 次請求
- 檔案格式驗證（只接受 PDF / JPG / PNG）
- 檔案大小限制 20MB
- 安全 HTTP 標頭
- API Key 環境變數保護
