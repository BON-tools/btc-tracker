# BTC 雙線監控

依照「日線 MA360 + 週線 MA50」操作原則，自動判斷訊號的網頁儀表板。

- 網址：<https://bon-tools.github.io/btc-tracker/>
- 舊的 Gemini 版本保留在：<https://bon-tools.github.io/btc-tracker/gemini.html>

> 僅供個人紀錄與學習參考，不構成投資建議。合約交易有爆倉風險。

## 網頁內容

- 四個結論：現貨傻瓜法、合約開多、出場警報、浮盈加倉
- 4️⃣ 開多 5 項條件逐項檢查、5️⃣ 出場兩項訊號
- 日線 / 週線 + MACD 走勢圖，標出歷史上的站上、跌破、開多、頂背離
- 強平價檢查器（含加倉模擬）、斐波那契、籌碼參考、歷史復盤
- 參數設定：「站上一陣子」「回撤到線附近」等標準可以自己調

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | 網頁儀表板 |
| `btc-logic.js` | 核心判斷邏輯（網頁與機器人共用） |
| `bot/bot.js` | Telegram 推播機器人（**目前未啟用**） |
| `gemini.html` | 舊的 Gemini 版本 |

## 之後想啟用 Telegram 機器人

目前專案裡沒有排程設定，所以機器人不會執行。要啟用時：

1. 在 Telegram 找 **@BotFather** → `/newbot` → 取得 token；打開新機器人按「開始」。
2. **Settings → Secrets and variables → Actions → New repository secret**：名稱 `TELEGRAM_BOT_TOKEN`，貼上 token。
3. **Add file → Create new file**，檔名 `.github/workflows/btc-monitor.yml`，貼上下面內容後 Commit。
4. **Actions → BTC 監控 → Run workflow**，機器人會傳 Chat ID 給你；把它加成 secret `TELEGRAM_CHAT_ID`，再執行一次就完成。

```yaml
name: BTC 監控

on:
  schedule:
    # 每天 UTC 00:10 = 台灣時間早上 8:10（日K 剛收盤）
    - cron: '10 0 * * *'
  workflow_dispatch: # 可以在 Actions 頁面手動按 Run workflow

permissions:
  contents: write

concurrency:
  group: btc-monitor
  cancel-in-progress: false

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: 檢查訊號並推播
        run: node bot/bot.js
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
          LIQ_PRICE: ${{ vars.LIQ_PRICE }}
          DAILY_SUMMARY: ${{ vars.DAILY_SUMMARY }}
          FORCE_SUMMARY: ${{ github.event_name == 'workflow_dispatch' }}
          DASHBOARD_URL: https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}/

      - name: 儲存今天的狀態
        run: |
          git config user.name "btc-monitor-bot"
          git config user.email "btc-monitor-bot@users.noreply.github.com"
          if [ -d data ]; then git add data; fi
          if git diff --cached --quiet; then
            echo "沒有變化"
          else
            git commit -m "更新監控狀態 $(date -u +%F)"
            git push
          fi
```
