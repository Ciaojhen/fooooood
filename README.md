# 🍳 Eat, Pray, Not Burn

記錄自己做菜食譜的 iPhone 網頁 App（PWA）。可以加到主畫面、全螢幕使用，沒網路也能開。

## 資料存在哪？

用 Google 帳號登入後，食譜和照片存在 **Supabase** 雲端資料庫，電腦和手機自動同步。
每台裝置也會留一份快取，沒網路時可以看食譜（但新增和修改需要網路）。

- 資料庫設定：`supabase/setup.sql`（新專案在 Supabase 的 SQL Editor 執行一次即可）
- 已經在用的專案要加上購物清單：執行 `supabase/002_shopping.sql`
- 連線設定：`public/config.js`（只放 Project URL 和 Publishable key，**不要放 secret key**）

## 在電腦上預覽

```bash
npm start
```

打開 http://localhost:3000

## 發布到 GitHub Pages

1. 在 GitHub 建一個新的 repository，把這個資料夾推上去（main 分支）
2. 到 repo 的 **Settings → Pages**，Source 選 **GitHub Actions**
3. 等 Actions 跑完，網址會是 `https://<你的帳號>.github.io/<repo 名稱>/`

## 裝到 iPhone

1. 用 **Safari** 打開上面的網址
2. 點下方「分享」→「加入主畫面」

## 更新 App

改完程式推上 GitHub 後，手機上的 App 會在背景下載新版，**下次打開**就會是新版。
如果改了 `sw.js` 裡的檔案清單，記得把 `CACHE` 版本號加一。

## 檔案結構

- `public/` — App 本體（HTML / CSS / JS / 圖示 / Service Worker）
- `public/vendor/supabase.js` — Supabase 函式庫（v2.117.1）
- `supabase/setup.sql` — 資料表、權限、照片空間設定
- `server.js` — 本機預覽用的靜態伺服器
- `tools/make-icons.js` — 產生 App 圖示：`node tools/make-icons.js`
