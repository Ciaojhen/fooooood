// FooooooD 食譜本 — 前端（原生 JS，hash 路由）
// 資料存在雲端（Supabase），用 Google 帳號登入後電腦和手機自動同步；
// 另外在本機（IndexedDB）留一份快取，沒網路時也能看食譜。
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uuid = () =>
  crypto.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) =>
    ((c === 'x' ? Math.random() * 16 : (Math.random() * 4) | 8) | 0).toString(16));
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const app = $('#app');

// ---------- Supabase ----------
const CFG = window.FOOD_CONFIG || {};
const configured = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_KEY);
const sb = configured
  ? supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
const BUCKET = 'recipe-images';
let user = null;

function friendly(err) {
  const msg = err?.message || String(err);
  if (!navigator.onLine || /fetch|Load failed|network/i.test(msg)) return '沒有網路，請連線後再試';
  return msg;
}

const cloud = {
  async list() {
    const { data, error } = await sb.from('recipes').select('data');
    if (error) throw error;
    return data.map((row) => row.data);
  },
  async save(r) {
    const { error } = await sb.from('recipes').upsert({ id: r.id, data: r, updated_at: r.updatedAt });
    if (error) throw error;
  },
  async remove(id) {
    const { error } = await sb.from('recipes').delete().eq('id', id);
    if (error) throw error;
  },
  async uploadImage(blob) {
    const ext = { 'image/png': 'png', 'image/webp': 'webp' }[blob.type] || 'jpg';
    const path = `${user.id}/${uuid()}.${ext}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
    if (error) throw error;
    return path;
  },
  async downloadImage(path) {
    const { data, error } = await sb.storage.from(BUCKET).download(path);
    if (error) throw error;
    return data;
  },
  async removeImages(paths) {
    if (!paths.length) return;
    const { error } = await sb.storage.from(BUCKET).remove(paths);
    if (error) throw error;
  },
  async listImages() {
    const { data, error } = await sb.storage.from(BUCKET).list(user.id, { limit: 1000 });
    if (error) throw error;
    return data.filter((f) => !f.name.startsWith('.')).map((f) => ({ path: `${user.id}/${f.name}`, createdAt: f.created_at }));
  },
};

// ---------- 本機 IndexedDB ----------
function openIdb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' }); // { id, type, data: ArrayBuffer }
      if (!db.objectStoreNames.contains('shopping')) db.createObjectStore('shopping', { keyPath: 'id' }); // v2：購物清單
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(dbPromise, store, mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
function idbStore(name) {
  let dbPromise;
  const db = () => (dbPromise ??= openIdb(name));
  return {
    allRecipes: () => tx(db(), 'recipes', 'readonly', (s) => s.getAll()),
    putRecipe: (r) => tx(db(), 'recipes', 'readwrite', (s) => s.put(r)),
    deleteRecipe: (id) => tx(db(), 'recipes', 'readwrite', (s) => s.delete(id)),
    replaceRecipes: (list) => tx(db(), 'recipes', 'readwrite', (s) => { s.clear(); list.forEach((r) => s.put(r)); }),
    getImage: (id) => tx(db(), 'images', 'readonly', (s) => s.get(id)),
    putImage: (img) => tx(db(), 'images', 'readwrite', (s) => s.put(img)),
    deleteImage: (id) => tx(db(), 'images', 'readwrite', (s) => s.delete(id)),
    imageIds: () => tx(db(), 'images', 'readonly', (s) => s.getAllKeys()),
    allShopping: () => tx(db(), 'shopping', 'readonly', (s) => s.getAll()),
    putShopping: (items) => tx(db(), 'shopping', 'readwrite', (s) => { items.forEach((i) => s.put(i)); }),
    deleteShopping: (ids) => tx(db(), 'shopping', 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); }),
    replaceShopping: (items) => tx(db(), 'shopping', 'readwrite', (s) => { s.clear(); items.forEach((i) => s.put(i)); }),
    async clear() {
      for (const name of ['recipes', 'images', 'shopping']) await tx(db(), name, 'readwrite', (s) => s.clear());
    },
    async destroy() {
      (await db()).close();
      dbPromise = null;
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = resolve;
      });
    },
  };
}
const cache = idbStore('fooooood-cloud'); // 雲端資料的本機快取
const legacy = idbStore('fooooood'); // 舊版（只存在手機裡）的資料，登入後可以搬上雲端

function sanitize(input, existing) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const num = (v) => {
    const n = Number(v);
    return v !== '' && v != null && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? uuid(),
    title: str(input.title, 100) || '未命名料理',
    image: typeof input.image === 'string' && input.image.length <= 200 ? input.image : null,
    category: str(input.category, 30),
    tags: Array.isArray(input.tags) ? input.tags.map((t) => str(t, 20)).filter(Boolean).slice(0, 20) : [],
    servings: num(input.servings),
    prepMinutes: num(input.prepMinutes),
    cookMinutes: num(input.cookMinutes),
    ingredients: Array.isArray(input.ingredients)
      ? input.ingredients.map((i) => ({ name: str(i?.name, 60), amount: str(i?.amount, 30) })).filter((i) => i.name)
      : [],
    steps: Array.isArray(input.steps) ? input.steps.map((s) => str(s, 2000)).filter(Boolean) : [],
    notes: str(input.notes, 5000),
    rating: Math.min(5, Math.max(0, Math.round(Number(input.rating) || 0))),
    favorite: Boolean(input.favorite),
    emoji: str(input.emoji, 16),
    cookLog: existing?.cookLog ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

// 先寫雲端，成功後再更新本機快取；沒網路時會丟出錯誤，不會出現兩邊不一致
const api = {
  async create(input) {
    const r = sanitize(input);
    await cloud.save(r);
    await cache.putRecipe(r);
    return r;
  },
  async update(id, input) {
    const existing = findRecipe(id);
    const r = sanitize(input, existing);
    await cloud.save(r);
    await cache.putRecipe(r);
    if (existing.image && existing.image !== r.image) await removeImage(existing.image);
    return r;
  },
  async remove(id) {
    const r = findRecipe(id);
    await cloud.remove(id);
    await cache.deleteRecipe(id);
    if (r?.image) await removeImage(r.image);
  },
  async cooked(id) {
    const r = { ...findRecipe(id) };
    r.cookLog = [...r.cookLog, new Date().toISOString()];
    await cloud.save(r);
    await cache.putRecipe(r);
    return r;
  },
  async upload(blob) {
    const path = await cloud.uploadImage(blob);
    await cache.putImage({ id: path, type: blob.type, data: await blob.arrayBuffer() });
    return { id: path };
  },
};

// ---------- 照片 ----------
const imageUrls = new Map();
async function imageBlob(path) {
  const cached = await cache.getImage(path);
  if (cached) return new Blob([cached.data], { type: cached.type });
  const blob = await cloud.downloadImage(path);
  await cache.putImage({ id: path, type: blob.type, data: await blob.arrayBuffer() });
  return blob;
}
async function imageUrl(path) {
  if (!imageUrls.has(path)) {
    try {
      imageUrls.set(path, URL.createObjectURL(await imageBlob(path)));
    } catch {
      return ''; // 沒網路或照片不存在，下次再試
    }
  }
  return imageUrls.get(path);
}
async function removeImage(path) {
  await cloud.removeImages([path]).catch(() => {}); // 失敗的話之後 cleanupImages 會再清
  await cache.deleteImage(path);
  if (imageUrls.get(path)) URL.revokeObjectURL(imageUrls.get(path));
  imageUrls.delete(path);
}
// 模板裡用 <img data-img="path">，渲染完再補上實際圖片網址
function hydrateImages(root = app) {
  $$('img[data-img]', root).forEach(async (el) => {
    const url = await imageUrl(el.dataset.img);
    if (url) el.src = url;
    else el.outerHTML = placeholder(el.dataset.emoji);
  });
}
// 清掉沒有被任何食譜使用的照片（例如新增時上傳了照片卻按取消）
// 只刪超過一天的，避免刪到另一台裝置正在編輯、還沒儲存的照片
async function cleanupImages() {
  const used = new Set(recipes.map((r) => r.image).filter(Boolean));
  const dayAgo = Date.now() - 86400000;
  const orphans = (await cloud.listImages())
    .filter((f) => !used.has(f.path) && Date.parse(f.createdAt) < dayAgo)
    .map((f) => f.path);
  await cloud.removeImages(orphans);
  for (const id of await cache.imageIds()) if (!used.has(id)) await cache.deleteImage(id);
}

// 上傳前把照片縮到最長邊 1600px，存 JPEG 省空間
async function resizeImage(file, max = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.85));
}

// ---------- 備份 / 匯入 / 舊資料搬家 ----------
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const blobToDataUrl = (blob) =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
const validDate = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

async function exportBackup() {
  const images = {};
  for (const r of recipes) if (r.image) images[r.image] = await blobToDataUrl(await imageBlob(r.image));
  const json = JSON.stringify({ app: 'fooooood', version: 1, exportedAt: new Date().toISOString(), recipes, images });
  const name = `食譜備份-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });

  // iPhone 上會跳出分享選單，可以存到「檔案」、iCloud Drive 或傳 LINE 給自己
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return toast('備份完成 ✅');
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('備份完成 ✅');
}

// 把一道外來的食譜（備份檔或舊版資料）存到雲端，保留原本的 id、做菜紀錄和建立時間
async function saveImported(raw, imageBlobData) {
  const image = imageBlobData ? (await api.upload(imageBlobData)).id : null;
  const r = sanitize({ ...raw, image }, {
    id: isUuid(raw.id) ? raw.id : uuid(),
    cookLog: Array.isArray(raw.cookLog) ? raw.cookLog.filter(validDate) : [],
    createdAt: validDate(raw.createdAt) ? raw.createdAt : undefined,
  });
  if (validDate(raw.updatedAt)) r.updatedAt = raw.updatedAt;
  const old = findRecipe(r.id);
  await cloud.save(r);
  await cache.putRecipe(r);
  if (old?.image && old.image !== r.image) await removeImage(old.image);
}

async function importBackup(file) {
  const data = JSON.parse(await file.text());
  const list = Array.isArray(data) ? data : data?.recipes; // 也接受舊版電腦版的 recipes.json
  if (!Array.isArray(list)) throw new Error('這不是食譜備份檔');
  const images = data.images || {};
  let count = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const dataUrl = images[raw.image];
    const blob = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') ? await (await fetch(dataUrl)).blob() : null;
    await saveImported(raw, blob);
    count++;
  }
  await refresh();
  return count;
}

let legacyCount = 0;
async function checkLegacy() {
  legacyCount = (await legacy.allRecipes()).length;
  if (legacyCount && (location.hash || '#/') === '#/') renderList();
}
async function migrateLegacy() {
  for (const raw of await legacy.allRecipes()) {
    const img = raw.image ? await legacy.getImage(raw.image) : null;
    await saveImported(raw, img ? new Blob([img.data], { type: img.type }) : null);
  }
  await legacy.destroy();
  legacyCount = 0;
  await refresh();
}

// ---------- 購物清單 ----------
// 先改本機、馬上更新畫面，再把變更排進「待同步」佇列送到雲端。
// 超市裡訊號不好時也能打勾，恢復連線後會自動補送。
let shopping = [];
const toRow = (i) => ({
  id: i.id, name: i.name, amount: i.amount, done: i.done, recipe_id: i.recipeId || null,
  recipe_title: i.recipeTitle, created_at: i.createdAt, updated_at: i.updatedAt,
});
const fromRow = (r) => ({
  id: r.id, name: r.name, amount: r.amount, done: r.done, recipeId: r.recipe_id,
  recipeTitle: r.recipe_title, createdAt: r.created_at, updatedAt: r.updated_at,
});
const outbox = {
  get: () => { try { return JSON.parse(store.get('shopOutbox') || '[]'); } catch { return []; } },
  set: (ops) => store.set('shopOutbox', JSON.stringify(ops)),
};
let flushing = null;
let shopSyncError = ''; // 最近一次同步失敗的原因，顯示在購物清單頁
// 同一時間只送一批，避免順序錯亂。
// 注意：要用 .finally() 清旗標——佇列是空的時候 async 函式會同步跑完，
// 如果在函式裡清，會發生在設定旗標之前，旗標就永遠卡住了
function flushOutbox() {
  flushing ??= sendOutbox().finally(() => { flushing = null; });
  return flushing;
}
async function sendOutbox() {
  try {
    let ops;
    while ((ops = outbox.get()).length) {
      const op = ops[0];
      const { error } = op.type === 'upsert'
        ? await sb.from('shopping_items').upsert(op.items.map(toRow))
        : await sb.from('shopping_items').delete().in('id', op.ids);
      if (error) throw error;
      outbox.set(outbox.get().slice(1));
    }
    shopSyncError = '';
  } catch (err) {
    shopSyncError = friendly(err);
    throw err;
  } finally {
    updateCartBadge();
    if (location.hash === '#/cart') renderSyncNote();
  }
}
async function syncShopping() {
  await flushOutbox();
  const { data, error } = await sb.from('shopping_items').select('*').order('created_at');
  if (error) throw error;
  if (outbox.get().length) return false; // 同步途中又有新變更，這次先不覆蓋
  const list = data.map(fromRow);
  const changed = JSON.stringify(list) !== JSON.stringify(sortShopping(shopping));
  shopping = list;
  await cache.replaceShopping(list);
  updateCartBadge();
  return changed;
}
const sortShopping = (list) => [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
async function shopChange(op) {
  if (op.type === 'upsert') {
    const byId = new Map(op.items.map((i) => [i.id, i]));
    shopping = [...shopping.filter((i) => !byId.has(i.id)), ...op.items];
    await cache.putShopping(op.items);
  } else {
    const ids = new Set(op.ids);
    shopping = shopping.filter((i) => !ids.has(i.id));
    await cache.deleteShopping(op.ids);
  }
  shopping = sortShopping(shopping);
  outbox.set([...outbox.get(), op]);
  updateCartBadge();
  flushOutbox().catch(() => {}); // 沒網路就先留在佇列裡
}
const shop = {
  add(entries) {
    if (!entries.length) return;
    const now = new Date().toISOString();
    const items = entries.map((e, n) => ({
      id: uuid(), name: e.name.trim().slice(0, 60), amount: (e.amount || '').trim().slice(0, 30), done: false,
      recipeId: e.recipeId || null, recipeTitle: e.recipeTitle || '',
      createdAt: new Date(Date.parse(now) + n).toISOString(), updatedAt: now, // +n 毫秒保持加入順序
    }));
    return shopChange({ type: 'upsert', items });
  },
  toggle(id) {
    const item = shopping.find((i) => i.id === id);
    return shopChange({ type: 'upsert', items: [{ ...item, done: !item.done, updatedAt: new Date().toISOString() }] });
  },
  remove: (ids) => shopChange({ type: 'delete', ids }),
};
// 「雞蛋 10顆」→ 名稱「雞蛋」、數量「10顆」；最後一段有數字才當作數量
function parseShopInput(text) {
  const m = text.trim().match(/^(.+?)\s+(\S*\d\S*)$/);
  return m ? { name: m[1], amount: m[2] } : { name: text.trim(), amount: '' };
}
function updateCartBadge() {
  const n = shopping.filter((i) => !i.done).length;
  const badge = $('#cart-badge');
  if (!badge) return;
  badge.textContent = n > 99 ? '99+' : n;
  badge.hidden = !n;
}

// ---------- 狀態 ----------
let recipes = [];
const filters = { q: '', category: '', favOnly: false, sort: 'updated' };

async function refresh() {
  recipes = await cache.allRecipes();
}
// 從雲端抓最新資料；有變動就回傳 true
async function syncFromCloud() {
  const list = await cloud.list();
  const key = (arr) => JSON.stringify([...arr].sort((a, b) => a.id.localeCompare(b.id)));
  const changed = key(list) !== key(recipes);
  recipes = list;
  await cache.replaceRecipes(list);
  lastSync = Date.now();
  return changed;
}
let lastSync = 0;
const findRecipe = (id) => recipes.find((r) => r.id === id);
const categories = () => [...new Set(recipes.map((r) => r.category).filter(Boolean))].sort();
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isEditing = () => /^#\/(new|edit)/.test(location.hash);

// ---------- 小工具 ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}
function fmtMin(n) {
  if (!n) return '';
  const h = Math.floor(n / 60), m = n % 60;
  return [h && `${h} 小時`, m && `${m} 分`].filter(Boolean).join(' ');
}
const totalMin = (r) => (r.prepMinutes || 0) + (r.cookMinutes || 0);
const stars = (n) => `<span class="stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
const fmtDate = (iso) => new Date(iso).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
const SHARE_ICON = `<svg class="share-icon" viewBox="0 0 24 24" aria-label="分享圖示"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M8 10H6v10h12V10h-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const GOOGLE_ICON = `<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
const placeholder = (emoji) =>
  emoji ? `<div class="placeholder chosen">${esc(emoji)}</div>` : '<div class="placeholder">🍽️</div>';
const photo = (id, alt = '', emoji = '') =>
  id ? `<img data-img="${esc(id)}" data-emoji="${esc(emoji)}" alt="${esc(alt)}" />` : placeholder(emoji);
// 黑白線條圖示（顏色跟著文字色，淺色模式是黑、深色模式是白）
const svgIcon = (paths, fill = 'none') =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const HEART_PATH = '<path d="M12 20.5s-7.5-4.6-9.2-9.3C1.6 7.8 3.9 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.4 0 5.7 3.3 4.5 6.7-1.7 4.7-9.2 9.3-9.2 9.3z"/>';
const ICONS = {
  heart: svgIcon(HEART_PATH),
  heartFilled: svgIcon(HEART_PATH, 'currentColor'),
  pencil: svgIcon('<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/><path d="M14.5 5.5l3 3"/>'),
  trash: svgIcon('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7"/>'),
};

// 從畫面下方滑出的選單（像 iPhone 的動作選單）
function actionSheet(options) {
  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.innerHTML = `
    <div class="sheet" role="dialog">
      <div class="sheet-group">${options.map((o, i) => `<button type="button" data-i="${i}" class="${o.danger ? 'danger' : ''}">${o.label}</button>`).join('')}</div>
      <div class="sheet-group"><button type="button" class="cancel">取消</button></div>
    </div>`;
  const close = () => el.remove();
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn && e.target !== el) return;
    close();
    // 在同一次點擊裡呼叫，iPhone 才允許打開相機 / 相簿 / 鍵盤
    if (btn?.dataset.i) options[btn.dataset.i].onSelect();
  });
  document.body.append(el);
}

// 叫出手機鍵盤讓使用者挑一個 emoji
function emojiPrompt(onPick) {
  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.innerHTML = `
    <div class="sheet emoji-sheet" role="dialog">
      <div class="sheet-group">
        <p>選一個 emoji 當封面</p>
        <input class="emoji-input" inputmode="text" autocomplete="off" aria-label="輸入 emoji" />
        <p class="hint">點鍵盤左下角的 😀 或 🌐 切換到 emoji 鍵盤</p>
      </div>
      <div class="sheet-group"><button type="button" class="cancel">取消</button></div>
    </div>`;
  const input = $('.emoji-input', el);
  const close = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('.cancel')) close(); });
  input.addEventListener('input', () => {
    const chars = window.Intl?.Segmenter
      ? [...new Intl.Segmenter().segment(input.value)].map((s) => s.segment)
      : [...input.value];
    const emoji = chars.reverse().find((c) => /\p{Extended_Pictographic}/u.test(c));
    if (emoji) { close(); onPick(emoji); }
    else input.value = '';
  });
  document.body.append(el);
  input.focus();
}

// 份量縮放：把開頭的數字（含分數）乘上倍率，例如 "200g" → "400g"、"1/2 杯" → "1 杯"
function scaleAmount(amount, factor) {
  if (factor === 1) return amount;
  const m = amount.match(/^(\d+(?:\.\d+)?)(?:\/(\d+))?(.*)$/);
  if (!m) return amount;
  const value = (m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1])) * factor;
  return `${Math.round(value * 100) / 100}${m[3]}`;
}

// ---------- 路由 ----------
async function route() {
  if (!user) return renderLogin();
  const [, page, id] = (location.hash.slice(1) || '/').split('/');
  window.scrollTo(0, 0);
  if (page === 'new') return renderForm();
  if (page === 'settings') return renderSettings();
  if (page === 'cart') return renderCart();
  if (page === 'edit') return findRecipe(id) ? renderForm(findRecipe(id)) : notFound();
  if (page === 'recipe') return findRecipe(id) ? renderDetail(findRecipe(id)) : notFound();
  renderList();
}
function notFound() {
  app.innerHTML = `<div class="empty"><div class="big">🤔</div><h2>找不到這道食譜</h2><a class="btn" href="#/">回到食譜本</a></div>`;
}

// ---------- 提示橫幅 ----------
function banners() {
  const out = [];
  if (legacyCount) {
    out.push(`
      <div class="banner warn">
        <span>📦 這台裝置上有 <b>${legacyCount} 道</b>舊版的食譜（只存在本機），要上傳到雲端同步嗎？</span>
        <button class="btn small primary" id="migrate">上傳</button>
      </div>`);
  }
  if (isIOS() && !isStandalone() && !store.get('hideInstall')) {
    out.push(`
      <div class="banner" data-dismiss="hideInstall">
        <span>📲 <b>加到主畫面</b>就能像 App 一樣使用：用 Safari 點下方 <b>分享</b> ${SHARE_ICON} → <b>加入主畫面</b></span>
        <button class="icon-btn" aria-label="關閉">✕</button>
      </div>`);
  }
  return out.join('');
}
function bindBanners() {
  $$('.banner[data-dismiss]').forEach((b) =>
    $('.icon-btn', b).addEventListener('click', () => {
      store.set(b.dataset.dismiss, '1');
      b.remove();
    }),
  );
  $('#migrate')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '上傳中…';
    try {
      const n = legacyCount;
      await migrateLegacy();
      toast(`已上傳 ${n} 道食譜到雲端 ✅`);
    } catch (err) {
      toast(`上傳失敗：${friendly(err)}`);
    }
    renderList();
  });
}

// ---------- 登入頁 ----------
function renderLogin() {
  document.title = 'Eat, Pray, Not Burn';
  app.innerHTML = `
    <div class="login">
      <img src="icons/icon-192.png" alt="" class="login-logo" />
      <h1>Eat, Pray, Not Burn</h1>
      <p>記錄你做菜的每一道食譜<br />電腦和手機自動同步</p>
      <button class="btn google" id="google">${GOOGLE_ICON} 使用 Google 帳號登入</button>
      <p class="small-print">只有你自己看得到你的食譜</p>
    </div>`;
  $('#google').onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } },
    });
    if (error) toast(`登入失敗：${friendly(error)}`);
  };
}
function renderNotConfigured() {
  app.innerHTML = `
    <div class="empty">
      <div class="big">🔧</div>
      <h2>還沒連上雲端資料庫</h2>
      <p>請在 <code>config.js</code> 填入 Supabase 的 Project URL 和 Publishable key。</p>
    </div>`;
}

// ---------- 列表頁 ----------
function renderList() {
  document.title = 'Eat, Pray, Not Burn';
  if (!recipes.length) {
    app.innerHTML = `
      ${banners()}
      <div class="empty">
        <div class="big">📖</div>
        <h2>你的食譜本還是空的</h2>
        <p>把你最拿手的那道菜記下來吧！</p>
        <a class="btn primary" href="#/new">＋ 新增第一道食譜</a>
        <p class="small-print">有備份檔？到 <a href="#/settings">⚙️ 設定</a> 匯入</p>
      </div>`;
    bindBanners();
    return;
  }
  const cats = categories();
  if (filters.category && !cats.includes(filters.category)) filters.category = '';
  app.innerHTML = `
    ${banners()}
    <div class="toolbar">
      <input class="search" type="search" placeholder="🔍 搜尋料理、食材、標籤…" value="${esc(filters.q)}" />
      <select id="sort" aria-label="排序">
        <option value="updated">最近更新</option>
        <option value="created">最新加入</option>
        <option value="cooked">最常做</option>
        <option value="rating">評分最高</option>
        <option value="time">最快完成</option>
      </select>
    </div>
    <div class="chips">
      <button class="chip ${!filters.category && !filters.favOnly ? 'active' : ''}" data-cat="">全部</button>
      <button class="chip ${filters.favOnly ? 'active' : ''}" data-fav title="我的最愛" aria-label="我的最愛">❤️</button>
      ${cats.map((c) => `<button class="chip ${filters.category === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <div class="grid"></div>`;

  bindBanners();
  $('#sort').value = filters.sort;
  $('.search').addEventListener('input', (e) => { filters.q = e.target.value; renderGrid(); });
  $('#sort').addEventListener('change', (e) => { filters.sort = e.target.value; renderGrid(); });
  $$('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      if ('fav' in chip.dataset) { filters.favOnly = !filters.favOnly; }
      else { filters.category = chip.dataset.cat; if (!chip.dataset.cat) filters.favOnly = false; }
      renderList();
    }),
  );
  renderGrid();
}

function renderGrid() {
  const q = filters.q.trim().toLowerCase();
  const sorters = {
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    cooked: (a, b) => b.cookLog.length - a.cookLog.length,
    rating: (a, b) => b.rating - a.rating,
    time: (a, b) => (totalMin(a) || Infinity) - (totalMin(b) || Infinity),
  };
  const list = recipes
    .filter((r) => !filters.category || r.category === filters.category)
    .filter((r) => !filters.favOnly || r.favorite)
    .filter((r) => !q || [r.title, r.category, r.notes, ...r.tags, ...r.ingredients.map((i) => i.name)]
      .join(' ').toLowerCase().includes(q))
    .sort(sorters[filters.sort]);

  $('.grid').innerHTML = list.length
    ? list.map((r) => `
      <a class="card" href="#/recipe/${r.id}">
        <div class="card-img">
          ${photo(r.image, '', r.emoji)}
          ${r.favorite ? '<span class="card-fav">❤️</span>' : ''}
        </div>
        <div class="card-body">
          <div class="card-title">${esc(r.title)}</div>
          <div class="card-meta">
            ${r.rating ? stars(r.rating) : ''}
            ${totalMin(r) ? `<span>⏱ ${fmtMin(totalMin(r))}</span>` : ''}
            ${r.cookLog.length ? `<span>🔥 ${r.cookLog.length} 次</span>` : ''}
          </div>
        </div>
      </a>`).join('')
    : `<div class="empty" style="grid-column:1/-1"><div class="big">🔎</div><p>沒有符合條件的食譜</p></div>`;
  hydrateImages($('.grid'));
}

// ---------- 詳細頁 ----------
function renderDetail(r) {
  document.title = `${r.title} · Eat, Pray, Not Burn`;
  let servings = r.servings;
  const lastCooked = r.cookLog.at(-1);

  app.innerHTML = `
    <div class="detail-top">
      <a href="#/" class="back">← 回到食譜本</a>
      <div class="detail-tools">
        <button class="tool" id="fav" title="${r.favorite ? '從最愛移除' : '加入最愛'}" aria-label="${r.favorite ? '從最愛移除' : '加入最愛'}" aria-pressed="${r.favorite}">${r.favorite ? ICONS.heartFilled : ICONS.heart}</button>
        <a class="tool" href="#/edit/${r.id}" title="編輯" aria-label="編輯">${ICONS.pencil}</a>
        <button class="tool" id="del" title="刪除" aria-label="刪除">${ICONS.trash}</button>
      </div>
    </div>
    <section class="detail-hero">
      <div class="photo">${photo(r.image, r.title, r.emoji)}</div>
      <div>
        <h1>${esc(r.title)}</h1>
        ${r.rating ? stars(r.rating) : ''}
        <div class="tag-row">
          ${r.category ? `<span class="tag">📂 ${esc(r.category)}</span>` : ''}
          ${r.tags.map((t) => `<span class="tag"># ${esc(t)}</span>`).join('')}
        </div>
        <div class="facts">
          ${r.prepMinutes ? `<div class="fact"><small>準備</small><b>${fmtMin(r.prepMinutes)}</b></div>` : ''}
          ${r.cookMinutes ? `<div class="fact"><small>烹調</small><b>${fmtMin(r.cookMinutes)}</b></div>` : ''}
          ${r.servings ? `<div class="fact"><small>份量</small><b>${r.servings} 人份</b></div>` : ''}
          <div class="fact"><small>做過</small><b>${r.cookLog.length} 次</b></div>
        </div>
        <div class="actions">
          <button class="btn primary" id="cooked">🔥 今天做了這道</button>
        </div>
        ${lastCooked ? `<div class="cooklog">上次做：${fmtDate(lastCooked)}</div>` : ''}
      </div>
    </section>
    <section class="detail-body">
      <div class="panel">
        <h2>食材
          ${r.servings ? `<span class="scaler"><button id="less" aria-label="減少份量">−</button><span id="serv"></span><button id="more" aria-label="增加份量">＋</button></span>` : ''}
        </h2>
        <p class="hint">點一下可以打勾，備料時很好用</p>
        <ul class="ing-list">${r.ingredients.length ? '' : '<li style="cursor:default">（還沒有填食材）</li>'}</ul>
        ${r.ingredients.length ? '<button class="btn small to-cart" id="to-cart">🛒 食材加入購物清單</button>' : ''}
      </div>
      <div class="panel">
        <h2>步驟</h2>
        <p class="hint">完成一步就點一下</p>
        <ol class="step-list">
          ${r.steps.map((s) => `<li>${esc(s)}</li>`).join('') || '<li style="padding-left:0">（還沒有填步驟）</li>'}
        </ol>
        ${r.notes ? `<h2 style="margin-top:24px">📝 筆記 / 小撇步</h2><div class="notes">${esc(r.notes)}</div>` : ''}
      </div>
    </section>`;
  hydrateImages();

  const renderIngredients = () => {
    const factor = r.servings ? servings / r.servings : 1;
    if (r.servings) $('#serv').textContent = `${servings} 人份`;
    if (!r.ingredients.length) return;
    $('.ing-list').innerHTML = r.ingredients
      .map((i) => `<li><span>${esc(i.name)}</span><span class="amt">${esc(scaleAmount(i.amount, factor))}</span></li>`)
      .join('');
  };
  renderIngredients();

  $('.ing-list').addEventListener('click', (e) => e.target.closest('li')?.classList.toggle('done'));
  $('#to-cart')?.addEventListener('click', async () => {
    // 照目前選的份量換算；清單裡已經有、還沒買的同名食材就跳過
    const factor = r.servings ? servings / r.servings : 1;
    const pending = new Set(shopping.filter((i) => !i.done).map((i) => i.name));
    const toAdd = r.ingredients.filter((i) => !pending.has(i.name));
    await shop.add(toAdd.map((i) => ({ name: i.name, amount: scaleAmount(i.amount, factor), recipeId: r.id, recipeTitle: r.title })));
    const skipped = r.ingredients.length - toAdd.length;
    toast(toAdd.length ? `🛒 已加入 ${toAdd.length} 項${skipped ? `（${skipped} 項已在清單中）` : ''}` : '這些食材都已經在購物清單裡了');
  });
  $('.step-list').addEventListener('click', (e) => e.target.closest('li')?.classList.toggle('done'));
  if (r.servings) {
    $('#less').onclick = () => { if (servings > 1) { servings--; renderIngredients(); } };
    $('#more').onclick = () => { servings++; renderIngredients(); };
  }
  $('#cooked').onclick = async () => {
    const updated = await api.cooked(r.id);
    await refresh();
    toast(`🎉 太棒了！這道菜你已經做了 ${updated.cookLog.length} 次`);
    renderDetail(findRecipe(r.id));
  };
  $('#fav').onclick = async () => {
    const updated = await api.update(r.id, { ...r, favorite: !r.favorite });
    await refresh();
    toast(updated.favorite ? '已加入最愛 ❤️' : '已從最愛移除');
    renderDetail(findRecipe(r.id));
  };
  $('#del').onclick = async () => {
    if (!confirm(`確定要刪除「${r.title}」嗎？刪除後無法復原。`)) return;
    await api.remove(r.id);
    await refresh();
    toast('已刪除');
    location.hash = '#/';
  };
}

// ---------- 新增 / 編輯表單 ----------
function renderForm(r) {
  const editing = Boolean(r);
  const draft = r
    ? structuredClone(r)
    : { title: '', image: null, category: '', tags: [], servings: 2, prepMinutes: '', cookMinutes: '',
        ingredients: [], steps: [], notes: '', rating: 0, favorite: false, emoji: '' };
  if (!draft.ingredients.length) draft.ingredients.push({ name: '', amount: '' });
  if (!draft.steps.length) draft.steps.push('');
  document.title = `${editing ? '編輯' : '新增'}食譜 · Eat, Pray, Not Burn`;

  app.innerHTML = `
    <a href="${editing ? `#/recipe/${r.id}` : '#/'}" class="back">← 取消</a>
    <form class="form" autocomplete="off">
      <h1>${editing ? '編輯食譜' : '新增食譜'}</h1>

      <div class="field">
        <span class="label">封面</span>
        <button type="button" class="photo-drop" id="drop">
          <span id="drop-text">📷 點一下加入照片或 emoji</span>
        </button>
        <input type="file" accept="image/*" capture="environment" hidden id="file-camera" />
        <input type="file" accept="image/*" hidden id="file-library" />
      </div>

      <div class="field">
        <label for="title">料理名稱 *</label>
        <input id="title" required maxlength="100" placeholder="例如：媽媽的紅燒肉" value="${esc(draft.title)}" />
      </div>

      <div class="row">
        <div class="field">
          <label for="category">分類</label>
          <input id="category" list="cat-list" maxlength="30" placeholder="主菜、湯品…" value="${esc(draft.category)}" />
          <datalist id="cat-list">${[...new Set(['主菜', '配菜', '湯品', '甜點', '早餐', '飲品', ...categories()])]
            .map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        </div>
        <div class="field">
          <label for="tags">標籤（用逗號分隔）</label>
          <input id="tags" placeholder="台式, 下飯" value="${esc(draft.tags.join(', '))}" />
        </div>
      </div>

      <div class="row three">
        <div class="field"><label for="servings">份量（人份）</label><input id="servings" type="number" inputmode="numeric" min="1" value="${draft.servings ?? ''}" /></div>
        <div class="field"><label for="prep">準備（分鐘）</label><input id="prep" type="number" inputmode="numeric" min="0" value="${draft.prepMinutes ?? ''}" /></div>
        <div class="field"><label for="cook">烹調（分鐘）</label><input id="cook" type="number" inputmode="numeric" min="0" value="${draft.cookMinutes ?? ''}" /></div>
      </div>

      <div class="field">
        <span class="label">食材</span>
        <div class="dyn-list" id="ings"></div>
        <div><button type="button" class="btn small" id="add-ing">＋ 新增食材</button></div>
      </div>

      <div class="field">
        <span class="label">步驟</span>
        <div class="dyn-list" id="steps"></div>
        <div><button type="button" class="btn small" id="add-step">＋ 新增步驟</button></div>
      </div>

      <div class="field">
        <label for="notes">筆記 / 小撇步</label>
        <textarea id="notes" placeholder="火候、替代食材、下次想改進的地方…">${esc(draft.notes)}</textarea>
      </div>

      <div class="row">
        <div class="field">
          <span class="label">評分</span>
          <div class="star-input" id="rating">
            ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} 顆星">★</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <span class="label">收藏</span>
          <label class="check"><input type="checkbox" id="favorite" ${draft.favorite ? 'checked' : ''} /> 加入我的最愛</label>
        </div>
      </div>

      <div class="form-actions">
        <a class="btn" href="${editing ? `#/recipe/${r.id}` : '#/'}">取消</a>
        <button type="submit" class="btn primary" id="save">💾 儲存食譜</button>
      </div>
    </form>`;

  // --- 照片 ---
  const drop = $('#drop');
  const renderPhoto = () => {
    $$('img, .placeholder', drop).forEach((el) => el.remove());
    $('#drop-text').hidden = Boolean(draft.image || draft.emoji);
    if (draft.image) {
      drop.insertAdjacentHTML('beforeend', photo(draft.image));
      hydrateImages(drop);
    } else if (draft.emoji) {
      drop.insertAdjacentHTML('beforeend', placeholder(draft.emoji));
    }
  };
  const handleFile = async (file) => {
    if (!file?.type.startsWith('image/')) return toast('請選擇圖片檔');
    $('#drop-text').textContent = '⏳ 處理中…';
    try {
      draft.image = (await api.upload(await resizeImage(file))).id;
      draft.emoji = '';
    } catch (err) {
      toast(`照片處理失敗：${friendly(err)}`);
    }
    $('#drop-text').textContent = '📷 點一下加入照片或 emoji';
    renderPhoto();
  };
  $$('#file-camera, #file-library').forEach((input) => {
    input.onchange = (e) => { handleFile(e.target.files[0]); e.target.value = ''; };
  });
  drop.addEventListener('click', () =>
    actionSheet([
      { label: '📷 拍照', onSelect: () => $('#file-camera').click() },
      { label: '🖼️ 從相簿選擇', onSelect: () => $('#file-library').click() },
      { label: '😀 選擇 emoji', onSelect: () => emojiPrompt((emoji) => { draft.emoji = emoji; draft.image = null; renderPhoto(); }) },
      ...(draft.image || draft.emoji
        ? [{ label: '移除封面', danger: true, onSelect: () => { draft.image = null; draft.emoji = ''; renderPhoto(); } }]
        : []),
    ]),
  );
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); handleFile(e.dataTransfer.files[0]); });
  renderPhoto();

  // --- 食材列 ---
  const renderIngs = (focusIndex) => {
    $('#ings').innerHTML = draft.ingredients.map((i, idx) => `
      <div class="dyn-row" data-i="${idx}">
        <input class="ing-name" placeholder="食材" value="${esc(i.name)}" data-k="name" enterkeyhint="next" />
        <input class="ing-amt" placeholder="份量 (300g)" value="${esc(i.amount)}" data-k="amount" enterkeyhint="next" />
        <button type="button" class="icon-btn" data-del title="移除">✕</button>
      </div>`).join('');
    if (focusIndex != null) $(`#ings [data-i="${focusIndex}"] .ing-name`)?.focus();
  };
  $('#ings').addEventListener('input', (e) => {
    const idx = e.target.closest('.dyn-row').dataset.i;
    draft.ingredients[idx][e.target.dataset.k] = e.target.value;
  });
  $('#ings').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return; // 避免注音選字時觸發
    e.preventDefault();
    const idx = Number(e.target.closest('.dyn-row').dataset.i);
    draft.ingredients.splice(idx + 1, 0, { name: '', amount: '' });
    renderIngs(idx + 1);
  });
  $('#ings').addEventListener('click', (e) => {
    if (!e.target.closest('[data-del]')) return;
    draft.ingredients.splice(e.target.closest('.dyn-row').dataset.i, 1);
    if (!draft.ingredients.length) draft.ingredients.push({ name: '', amount: '' });
    renderIngs();
  });
  $('#add-ing').onclick = () => { draft.ingredients.push({ name: '', amount: '' }); renderIngs(draft.ingredients.length - 1); };
  renderIngs();

  // --- 步驟列 ---
  const renderSteps = (focusIndex) => {
    $('#steps').innerHTML = draft.steps.map((s, idx) => `
      <div class="dyn-row" data-i="${idx}">
        <span class="num">${idx + 1}.</span>
        <textarea placeholder="描述這一步要做什麼…">${esc(s)}</textarea>
        <button type="button" class="icon-btn" data-del title="移除">✕</button>
      </div>`).join('');
    if (focusIndex != null) $(`#steps [data-i="${focusIndex}"] textarea`)?.focus();
  };
  $('#steps').addEventListener('input', (e) => { draft.steps[e.target.closest('.dyn-row').dataset.i] = e.target.value; });
  $('#steps').addEventListener('click', (e) => {
    if (!e.target.closest('[data-del]')) return;
    draft.steps.splice(e.target.closest('.dyn-row').dataset.i, 1);
    if (!draft.steps.length) draft.steps.push('');
    renderSteps();
  });
  $('#add-step').onclick = () => { draft.steps.push(''); renderSteps(draft.steps.length - 1); };
  renderSteps();

  // --- 評分 ---
  const renderStars = () => $$('#rating button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) <= draft.rating));
  $('#rating').addEventListener('click', (e) => {
    const n = Number(e.target.dataset.n);
    if (!n) return;
    draft.rating = draft.rating === n ? 0 : n; // 再點一次同一顆星可以清除
    renderStars();
  });
  renderStars();

  // --- 儲存 ---
  $('.form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      ...draft,
      title: $('#title').value,
      category: $('#category').value,
      tags: $('#tags').value.split(/[,，、]/).map((t) => t.trim()).filter(Boolean),
      servings: $('#servings').value,
      prepMinutes: $('#prep').value,
      cookMinutes: $('#cook').value,
      notes: $('#notes').value,
      favorite: $('#favorite').checked,
    };
    $('#save').disabled = true;
    try {
      const saved = editing ? await api.update(r.id, payload) : await api.create(payload);
      await refresh();
      toast('已儲存 ✅');
      location.hash = `#/recipe/${saved.id}`;
    } catch (err) {
      toast(`儲存失敗：${friendly(err)}`);
      $('#save').disabled = false;
    }
  });
  if (!editing && !isIOS()) $('#title').focus();
}

// ---------- 購物清單頁 ----------
function renderCart() {
  document.title = '購物清單 · Eat, Pray, Not Burn';
  app.innerHTML = `
    <a href="#/" class="back">← 回到食譜本</a>
    <div class="cart">
      <h1>🛒 購物清單</h1>
      <form class="cart-add" autocomplete="off">
        <input id="cart-input" placeholder="要買什麼？例如：雞蛋 10顆" enterkeyhint="done" maxlength="90" />
        <button class="btn primary" aria-label="加入">加入</button>
      </form>
      <p class="sync-note" id="sync-note" hidden></p>
      <div id="cart-list"></div>
    </div>`;
  $('.cart-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#cart-input');
    if (!input.value.trim()) return;
    await shop.add([parseShopInput(input.value)]);
    input.value = '';
    input.focus(); // 連續輸入不用再點一次
    renderCartList();
  });
  $('#cart-list').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-id]');
    if (e.target.closest('.del')) await shop.remove([row.dataset.id]);
    else if (row) await shop.toggle(row.dataset.id);
    else if (e.target.closest('#clear-done')) {
      const done = shopping.filter((i) => i.done);
      if (!confirm(`清除 ${done.length} 項已買的東西？`)) return;
      await shop.remove(done.map((i) => i.id));
    } else return;
    renderCartList();
  });
  renderCartList();
  renderSyncNote();
}
function renderCartList() {
  const todo = shopping.filter((i) => !i.done);
  const done = shopping.filter((i) => i.done);
  const row = (i) => `
    <li data-id="${i.id}" class="${i.done ? 'done-item' : ''}">
      <span class="check-circle" aria-hidden="true">${i.done ? '✓' : ''}</span>
      <span class="item-text">
        <span class="item-name">${esc(i.name)}</span>
        ${i.amount ? `<span class="item-amt">${esc(i.amount)}</span>` : ''}
        ${i.recipeTitle ? `<span class="item-from">${esc(i.recipeTitle)}</span>` : ''}
      </span>
      <button class="icon-btn del" aria-label="刪除 ${esc(i.name)}">✕</button>
    </li>`;
  $('#cart-list').innerHTML = shopping.length
    ? `
      <ul class="cart-items">${todo.map(row).join('') || '<li class="all-done">全部買齊了 🎉</li>'}</ul>
      ${done.length ? `
        <div class="done-header"><span>已買 ${done.length} 項</span><button class="btn small" id="clear-done">清除已買</button></div>
        <ul class="cart-items">${done.map(row).join('')}</ul>` : ''}`
    : `<div class="empty"><div class="big">🧺</div><p>購物清單是空的<br />在上面輸入，或到食譜裡按「🛒 食材加入購物清單」</p></div>`;
}
function renderSyncNote() {
  const n = outbox.get().length;
  const note = $('#sync-note');
  if (!note) return;
  note.hidden = !n;
  note.textContent = shopSyncError === friendly(new Error('fetch'))
    ? `☁️ 目前離線，有 ${n} 筆變更會在恢復連線後自動同步`
    : `⚠️ 有 ${n} 筆變更還沒同步到雲端：${shopSyncError || '同步中…'}`;
}

// ---------- 帳號與設定頁 ----------
function renderSettings() {
  document.title = '帳號與設定 · Eat, Pray, Not Burn';
  const meta = user.user_metadata || {};
  app.innerHTML = `
    <a href="#/" class="back">← 回到食譜本</a>
    <div class="form">
      <h1>帳號與設定</h1>

      <div class="panel">
        <h2>👤 帳號</h2>
        <div class="account">
          ${meta.avatar_url ? `<img src="${esc(meta.avatar_url)}" alt="" referrerpolicy="no-referrer" />` : ''}
          <div>
            <b>${esc(meta.full_name || meta.name || '')}</b>
            <div class="muted">${esc(user.email)}</div>
          </div>
        </div>
        <p class="muted" style="margin-top:12px">☁️ ${recipes.length} 道食譜已同步到雲端，用同一個 Google 帳號在其他裝置登入就能看到。</p>
        <div class="actions">
          <button class="btn" id="sync">🔄 立即同步</button>
          <button class="btn danger" id="logout">登出</button>
        </div>
      </div>

      <div class="panel">
        <h2>💾 備份檔</h2>
        <p>雲端已經幫你保存資料了。如果想自己另外留一份，可以匯出備份檔；也可以把備份檔匯入到雲端。</p>
        <div class="actions">
          <button class="btn" id="export" ${recipes.length ? '' : 'disabled'}>匯出備份檔</button>
          <label class="btn">匯入備份檔<input type="file" accept="application/json,.json" hidden id="import" /></label>
        </div>
        <p class="hint" style="margin-top:12px">匯入時同一道食譜會以備份檔的內容覆蓋。</p>
      </div>

      ${isStandalone() ? '' : `
      <div class="panel">
        <h2>📲 安裝到主畫面</h2>
        <ol class="install-steps">
          <li>用 <b>Safari</b> 打開這個網址</li>
          <li>點畫面下方的 <b>分享</b> 按鈕 ${SHARE_ICON}</li>
          <li>往下滑，選 <b>加入主畫面</b></li>
          <li>從主畫面的「Eat, Pray, Not Burn」圖示打開，再用 Google 登入一次</li>
        </ol>
      </div>`}
    </div>`;

  $('#sync').onclick = async () => {
    try {
      await syncFromCloud();
      toast('已同步 ✅');
      renderSettings();
    } catch (err) {
      toast(`同步失敗：${friendly(err)}`);
    }
  };
  $('#logout').onclick = async () => {
    if (!confirm('確定要登出嗎？這台裝置上的快取資料會被清除（雲端的資料不受影響）。')) return;
    await sb.auth.signOut({ scope: 'local' }); // 只登出這台裝置
  };
  $('#export').onclick = () => exportBackup().catch((err) => toast(`匯出失敗：${friendly(err)}`));
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    toast('匯入中…');
    try {
      const n = await importBackup(file);
      toast(`已匯入 ${n} 道食譜 ✅`);
      renderSettings();
    } catch (err) {
      toast(`匯入失敗：${friendly(err)}`);
    }
  };
}

// ---------- 啟動 ----------
function setUser(u) {
  user = u;
  document.body.classList.toggle('signed-out', !u);
}

async function boot() {
  if (!user) {
    // 登出後清掉本機快取，避免下一個使用這台裝置的人看到
    recipes = [];
    imageUrls.forEach((url) => URL.revokeObjectURL(url));
    imageUrls.clear();
    shopping = [];
    await cache.clear().catch(() => {});
    store.set('cacheUser', '');
    outbox.set([]);
    return renderLogin();
  }
  if (store.get('cacheUser') !== user.id) {
    await cache.clear().catch(() => {});
    store.set('cacheUser', user.id);
    outbox.set([]);
  }
  await refresh(); // 先用快取秒開
  shopping = sortShopping(await cache.allShopping());
  updateCartBadge();
  route();
  try {
    if ((await syncFromCloud()) && !isEditing()) route();
    cleanupImages().catch(() => {});
  } catch (err) {
    toast(`目前離線，顯示的是上次同步的資料`);
  }
  syncShopping().then((changed) => { if (changed && location.hash === '#/cart') renderCartList(); }).catch(() => {});
  checkLegacy().catch(() => {});
}

// 從背景切回來時（例如在電腦上改完、拿起手機），自動抓最新資料
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !user || Date.now() - lastSync < 30000) return;
  try {
    if ((await syncFromCloud()) && !isEditing()) route();
    if ((await syncShopping()) && location.hash === '#/cart') renderCartList();
  } catch {}
});
// 恢復連線時，把離線時的購物清單變更送出去
window.addEventListener('online', () => { if (user) flushOutbox().catch(() => {}); });

// 按鈕操作失敗（例如沒網路）時統一顯示提示
window.addEventListener('unhandledrejection', (e) => toast(`操作失敗：${friendly(e.reason)}`));
window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator) {
  // 有新版 App 裝好時自動重新載入，不用關掉再開
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !isEditing()) location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

(async () => {
  if (!configured) return renderNotConfigured();
  const { data } = await sb.auth.getSession(); // 會順便處理 Google 登入完跳回來的網址
  if (new URLSearchParams(location.search).has('code') || location.search.includes('error')) {
    const err = new URLSearchParams(location.search).get('error_description');
    if (err) toast(`登入失敗：${err}`);
    history.replaceState(null, '', location.pathname + location.hash);
  }
  setUser(data.session?.user ?? null);
  sb.auth.onAuthStateChange((_event, session) => {
    if ((session?.user?.id ?? null) === (user?.id ?? null)) return; // 同一個人（例如 token 更新）不用重來
    setUser(session?.user ?? null);
    boot();
  });
  boot();
})().catch((err) => {
  app.innerHTML = `<div class="empty"><div class="big">⚠️</div><h2>啟動失敗</h2><p>${esc(friendly(err))}</p></div>`;
});
