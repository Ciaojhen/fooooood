// FooooooD 食譜本 — 前端（原生 JS，hash 路由）
// 所有資料都存在這支手機 / 這個瀏覽器的 IndexedDB 裡，不會上傳到任何伺服器
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uuid = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const app = $('#app');

// ---------- 本機資料庫（IndexedDB） ----------
let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('fooooood', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('recipes', { keyPath: 'id' });
      req.result.createObjectStore('images', { keyPath: 'id' }); // { id, type, data: ArrayBuffer }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
const db = {
  allRecipes: () => tx('recipes', 'readonly', (s) => s.getAll()),
  putRecipe: (r) => tx('recipes', 'readwrite', (s) => s.put(r)),
  deleteRecipe: (id) => tx('recipes', 'readwrite', (s) => s.delete(id)),
  getImage: (id) => tx('images', 'readonly', (s) => s.get(id)),
  putImage: (img) => tx('images', 'readwrite', (s) => s.put(img)),
  deleteImage: (id) => tx('images', 'readwrite', (s) => s.delete(id)),
  allImages: () => tx('images', 'readonly', (s) => s.getAll()),
  imageIds: () => tx('images', 'readonly', (s) => s.getAllKeys()),
};

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
    image: typeof input.image === 'string' && input.image.length <= 64 ? input.image : null,
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
    cookLog: existing?.cookLog ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

const api = {
  list: db.allRecipes,
  async create(input) {
    const r = sanitize(input);
    await db.putRecipe(r);
    return r;
  },
  async update(id, input) {
    const existing = findRecipe(id);
    const r = sanitize(input, existing);
    await db.putRecipe(r);
    if (existing.image && existing.image !== r.image) await removeImage(existing.image);
    return r;
  },
  async remove(id) {
    const r = findRecipe(id);
    await db.deleteRecipe(id);
    if (r?.image) await removeImage(r.image);
  },
  async cooked(id) {
    const r = { ...findRecipe(id) };
    r.cookLog = [...r.cookLog, new Date().toISOString()];
    await db.putRecipe(r);
    return r;
  },
  async upload(blob) {
    const id = uuid();
    await db.putImage({ id, type: blob.type, data: await blob.arrayBuffer() });
    return { id };
  },
};

// ---------- 照片 ----------
const imageUrls = new Map();
async function imageUrl(id) {
  if (!imageUrls.has(id)) {
    const img = await db.getImage(id);
    imageUrls.set(id, img ? URL.createObjectURL(new Blob([img.data], { type: img.type })) : '');
  }
  return imageUrls.get(id);
}
async function removeImage(id) {
  await db.deleteImage(id);
  if (imageUrls.get(id)) URL.revokeObjectURL(imageUrls.get(id));
  imageUrls.delete(id);
}
// 模板裡用 <img data-img="id">，渲染完再補上實際圖片網址
function hydrateImages(root = app) {
  $$('img[data-img]', root).forEach(async (el) => {
    const url = await imageUrl(el.dataset.img);
    if (url) el.src = url;
    else el.replaceWith(Object.assign(document.createElement('div'), { className: 'placeholder', textContent: '🍽️' }));
  });
}
// 清掉沒有被任何食譜使用的照片（例如新增時上傳了照片卻按取消）
async function cleanupImages() {
  const used = new Set(recipes.map((r) => r.image).filter(Boolean));
  for (const id of await db.imageIds()) if (!used.has(id)) await db.deleteImage(id);
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

// ---------- 備份 ----------
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
const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : Infinity);

async function exportBackup() {
  const images = {};
  const used = new Set(recipes.map((r) => r.image));
  for (const img of await db.allImages())
    if (used.has(img.id)) images[img.id] = await blobToDataUrl(new Blob([img.data], { type: img.type }));
  const json = JSON.stringify({ app: 'fooooood', version: 1, exportedAt: new Date().toISOString(), recipes, images });
  const name = `食譜備份-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });

  // iPhone 上會跳出分享選單，可以存到「檔案」、iCloud Drive 或傳 LINE 給自己
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      markBackedUp();
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  markBackedUp();
}
function markBackedUp() {
  store.set('lastBackup', new Date().toISOString());
  toast('備份完成 ✅');
  if (location.hash === '#/settings') renderSettings();
}

async function importBackup(file) {
  const data = JSON.parse(await file.text());
  const list = Array.isArray(data) ? data : data?.recipes; // 也接受舊版電腦版的 recipes.json
  if (!Array.isArray(list)) throw new Error('這不是食譜備份檔');
  const images = data.images || {};
  const validDate = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));
  let count = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    let image = null;
    const dataUrl = images[raw.image];
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
      const blob = await (await fetch(dataUrl)).blob();
      image = raw.image;
      await db.putImage({ id: image, type: blob.type, data: await blob.arrayBuffer() });
    }
    const r = sanitize({ ...raw, image }, {
      id: typeof raw.id === 'string' && raw.id.length <= 64 ? raw.id : uuid(),
      cookLog: Array.isArray(raw.cookLog) ? raw.cookLog.filter(validDate) : [],
      createdAt: validDate(raw.createdAt) ? raw.createdAt : undefined,
    });
    if (validDate(raw.updatedAt)) r.updatedAt = raw.updatedAt;
    await db.putRecipe(r);
    count++;
  }
  await refresh();
  return count;
}

// ---------- 狀態 ----------
let recipes = [];
const filters = { q: '', category: '', favOnly: false, sort: 'updated' };

async function refresh() {
  recipes = await api.list();
}
const findRecipe = (id) => recipes.find((r) => r.id === id);
const categories = () => [...new Set(recipes.map((r) => r.category).filter(Boolean))].sort();
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- 小工具 ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
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
const photo = (id, alt = '') => (id ? `<img data-img="${esc(id)}" alt="${esc(alt)}" />` : '<div class="placeholder">🍽️</div>');

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
  const [, page, id] = (location.hash.slice(1) || '/').split('/');
  window.scrollTo(0, 0);
  if (page === 'new') return renderForm();
  if (page === 'settings') return renderSettings();
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
  if (isIOS() && !isStandalone() && !store.get('hideInstall')) {
    out.push(`
      <div class="banner" data-dismiss="hideInstall">
        <span>📲 <b>加到主畫面</b>就能像 App 一樣使用：用 Safari 點下方 <b>分享</b> ${SHARE_ICON} → <b>加入主畫面</b></span>
        <button class="icon-btn" aria-label="關閉">✕</button>
      </div>`);
  }
  const days = daysSince(store.get('lastBackup'));
  if (recipes.length >= 3 && days > 30 && (store.get('hideBackupUntil') || '') < new Date().toISOString()) {
    out.push(`
      <div class="banner warn" data-dismiss="hideBackupUntil">
        <span>💾 ${days === Infinity ? '你還沒有備份過食譜' : `已經 ${days} 天沒備份了`}，資料只存在這支手機裡，<a href="#/settings">現在備份</a></span>
        <button class="icon-btn" aria-label="稍後提醒">✕</button>
      </div>`);
  }
  return out.join('');
}
function bindBanners() {
  $$('.banner').forEach((b) =>
    $('.icon-btn', b).addEventListener('click', () => {
      const key = b.dataset.dismiss;
      store.set(key, key === 'hideBackupUntil' ? new Date(Date.now() + 7 * 86400000).toISOString() : '1');
      b.remove();
    }),
  );
}

// ---------- 列表頁 ----------
function renderList() {
  document.title = 'FooooooD 食譜本';
  if (!recipes.length) {
    app.innerHTML = `
      ${banners()}
      <div class="empty">
        <div class="big">📖</div>
        <h2>你的食譜本還是空的</h2>
        <p>把你最拿手的那道菜記下來吧！</p>
        <a class="btn primary" href="#/new">＋ 新增第一道食譜</a>
        <p class="small-print">有備份檔？到 <a href="#/settings">⚙️ 備份</a> 匯入</p>
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
      <button class="chip ${filters.favOnly ? 'active' : ''}" data-fav>❤️ 我的最愛</button>
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
          ${photo(r.image)}
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
  document.title = `${r.title} · FooooooD`;
  let servings = r.servings;
  const lastCooked = r.cookLog.at(-1);

  app.innerHTML = `
    <a href="#/" class="back">← 回到食譜本</a>
    <section class="detail-hero">
      <div class="photo">${photo(r.image, r.title)}</div>
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
          <button class="btn" id="fav">${r.favorite ? '❤️ 已收藏' : '🤍 加入最愛'}</button>
          <a class="btn" href="#/edit/${r.id}">✏️ 編輯</a>
          <button class="btn danger" id="del">🗑 刪除</button>
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
        ingredients: [], steps: [], notes: '', rating: 0, favorite: false };
  if (!draft.ingredients.length) draft.ingredients.push({ name: '', amount: '' });
  if (!draft.steps.length) draft.steps.push('');
  document.title = `${editing ? '編輯' : '新增'}食譜 · FooooooD`;

  app.innerHTML = `
    <a href="${editing ? `#/recipe/${r.id}` : '#/'}" class="back">← 取消</a>
    <form class="form" autocomplete="off">
      <h1>${editing ? '編輯食譜' : '新增食譜'}</h1>

      <div class="field">
        <span class="label">成品照片</span>
        <label class="photo-drop" id="drop">
          <input type="file" accept="image/*" hidden id="file" />
          <span id="drop-text">📷 點擊拍照或選擇照片</span>
        </label>
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
    $$('img, .placeholder, .remove', drop).forEach((el) => el.remove());
    $('#drop-text').hidden = Boolean(draft.image);
    if (!draft.image) return;
    drop.insertAdjacentHTML('beforeend',
      `${photo(draft.image)}<button type="button" class="btn small remove">✕ 移除照片</button>`);
    hydrateImages(drop);
    $('.remove', drop).onclick = (e) => { e.preventDefault(); draft.image = null; renderPhoto(); };
  };
  const handleFile = async (file) => {
    if (!file?.type.startsWith('image/')) return toast('請選擇圖片檔');
    $('#drop-text').textContent = '⏳ 處理中…';
    try {
      draft.image = (await api.upload(await resizeImage(file))).id;
    } catch (err) {
      toast(`照片處理失敗：${err.message}`);
    }
    $('#drop-text').textContent = '📷 點擊拍照或選擇照片';
    renderPhoto();
  };
  $('#file').onchange = (e) => handleFile(e.target.files[0]);
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
      toast(`儲存失敗：${err.message}`);
      $('#save').disabled = false;
    }
  });
  if (!editing && !isIOS()) $('#title').focus();
}

// ---------- 備份與設定頁 ----------
async function renderSettings() {
  document.title = '備份與設定 · FooooooD';
  const last = store.get('lastBackup');
  const persisted = await navigator.storage?.persisted?.();
  app.innerHTML = `
    <a href="#/" class="back">← 回到食譜本</a>
    <div class="form">
      <h1>備份與設定</h1>

      <div class="panel">
        <h2>💾 備份食譜</h2>
        <p>你的 ${recipes.length} 道食譜和照片<b>只存在這支手機裡</b>，不會上傳到任何地方。換手機、刪掉 App 或清除 Safari 資料都會讓資料消失，所以請定期備份。</p>
        <p class="muted">上次備份：${last ? `${fmtDate(last)}（${daysSince(last)} 天前）` : '還沒備份過'}</p>
        <div class="actions">
          <button class="btn primary" id="export" ${recipes.length ? '' : 'disabled'}>匯出備份檔</button>
          <label class="btn">匯入備份檔<input type="file" accept="application/json,.json" hidden id="import" /></label>
        </div>
        <p class="hint" style="margin-top:12px">iPhone 匯出時會跳出分享選單，建議選「儲存到檔案」存到 iCloud Drive。匯入時同一道食譜會以備份檔的內容覆蓋。</p>
      </div>

      ${isStandalone() ? '' : `
      <div class="panel">
        <h2>📲 安裝到主畫面</h2>
        <ol class="install-steps">
          <li>用 <b>Safari</b> 打開這個網址</li>
          <li>點畫面下方的 <b>分享</b> 按鈕 ${SHARE_ICON}</li>
          <li>往下滑，選 <b>加入主畫面</b></li>
          <li>之後從主畫面的「食譜本」圖示打開，就是全螢幕 App，沒網路也能用</li>
        </ol>
      </div>`}

      <div class="panel">
        <h2>ℹ️ 儲存狀態</h2>
        <p class="muted">${persisted
          ? '✅ 系統已同意長期保存這個 App 的資料。'
          : '系統可能在儲存空間不足時清除資料。加入主畫面後會更穩定，但還是建議定期備份。'}</p>
      </div>
    </div>`;

  $('#export').onclick = () => exportBackup().catch((err) => toast(`匯出失敗：${err.message}`));
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const n = await importBackup(file);
      toast(`已匯入 ${n} 道食譜 ✅`);
      renderSettings();
    } catch (err) {
      toast(`匯入失敗：${err.message}`);
    }
  };
}

// ---------- 啟動 ----------
window.addEventListener('hashchange', route);
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
refresh()
  .then(() => { route(); cleanupImages().catch(() => {}); })
  .catch((err) => {
    app.innerHTML = `<div class="empty"><div class="big">⚠️</div><h2>無法開啟資料庫</h2><p>${esc(err?.message)}</p><p>如果是 Safari 無痕模式，請改用一般模式開啟。</p></div>`;
  });
