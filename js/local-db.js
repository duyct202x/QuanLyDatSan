// LocalDB - Kho bền vững trên thiết bị cho đồng bộ v2
// - IndexedDB (dung lượng lớn, không giới hạn ~5MB như localStorage): bản ghi đã xác nhận từ máy chủ + meta.
// - Hàng đợi thay đổi chưa gửi (outbox) ghi ĐỒNG BỘ vào localStorage ngay khi lưu (không mất khi đóng tab đột ngột),
//   đồng thời sao lưu vào IndexedDB phòng khi localStorage đầy.
// - Trình duyệt không hỗ trợ IndexedDB: lưu tạm bằng localStorage.
const LocalDB = {
  DB_NAME: 'SMASH_PRO_SYNC_V2',
  DB_VERSION: 1,
  _db: null,
  _fallback: false,

  _ns() {
    return (typeof window !== 'undefined' && window.__SMASH_DEVICE_NS__) || '';
  },

  async open() {
    if (this._db || this._fallback) return;
    if (typeof indexedDB === 'undefined') { this._fallback = true; return; }
    try {
      this._db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(this._ns() + this.DB_NAME, this.DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('records')) db.createObjectStore('records');
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB bị chặn'));
      });
    } catch (e) {
      console.warn('[LocalDB] Không mở được IndexedDB, dùng localStorage:', e);
      this._fallback = true;
    }
  },

  _range(env) {
    return IDBKeyRange.bound(env + '|', env + '|￿');
  },

  _tx(stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Giao dịch IndexedDB bị hủy'));
      result = fn(tx);
    });
  },

  // ---------------- Bản ghi đã xác nhận + meta ----------------
  async loadEnv(env) {
    await this.open();
    if (this._fallback) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(this._ns() + 'SMASH_PRO_STORE_V2_' + env) || 'null'); } catch (e) {}
      return { records: (saved && saved.records) || {}, meta: (saved && saved.meta) || {} };
    }
    const records = {}, meta = {};
    await this._tx(['records', 'meta'], 'readonly', (tx) => {
      const prefix = env.length + 1;
      tx.objectStore('records').openCursor(this._range(env)).onsuccess = (ev) => {
        const cur = ev.target.result;
        if (!cur) return;
        records[cur.key.slice(prefix)] = cur.value;
        cur.continue();
      };
      tx.objectStore('meta').openCursor(this._range(env)).onsuccess = (ev) => {
        const cur = ev.target.result;
        if (!cur) return;
        meta[cur.key.slice(prefix)] = cur.value;
        cur.continue();
      };
    });
    return { records, meta };
  },

  // Ghi nguyên tử: bản ghi thay đổi + meta (lastSeq...) trong CÙNG một giao dịch
  async write(env, { records = {}, meta = {}, replaceAll = false, allRecords = null }) {
    await this.open();
    if (this._fallback) {
      try {
        let saved = JSON.parse(localStorage.getItem(this._ns() + 'SMASH_PRO_STORE_V2_' + env) || 'null') || { records: {}, meta: {} };
        if (replaceAll) saved.records = {};
        Object.assign(saved.records, allRecords || records);
        Object.assign(saved.meta, meta);
        localStorage.setItem(this._ns() + 'SMASH_PRO_STORE_V2_' + env, JSON.stringify(saved));
      } catch (e) {
        console.warn('[LocalDB] Không lưu được kho dự phòng:', e);
      }
      return;
    }
    await this._tx(['records', 'meta'], 'readwrite', (tx) => {
      const rs = tx.objectStore('records');
      if (replaceAll) rs.delete(this._range(env));
      const recs = allRecords || records;
      Object.keys(recs).forEach((rk) => rs.put(recs[rk], env + '|' + rk));
      const ms = tx.objectStore('meta');
      Object.keys(meta).forEach((k) => ms.put(meta[k], env + '|' + k));
    });
  },

  async clearEnv(env) {
    await this.open();
    this.saveOutbox(env, []);
    if (this._fallback) {
      localStorage.removeItem(this._ns() + 'SMASH_PRO_STORE_V2_' + env);
      return;
    }
    await this._tx(['records', 'meta'], 'readwrite', (tx) => {
      tx.objectStore('records').delete(this._range(env));
      tx.objectStore('meta').delete(this._range(env));
    });
  },

  // ---------------- Hàng đợi thay đổi chưa gửi (outbox) ----------------
  _outboxKey(env) {
    return this._ns() + 'SMASH_PRO_OUTBOX_V2_' + env;
  },

  // Đồng bộ (sync) để đảm bảo thao tác đã ghi nhận trước khi hàm saveData trả về
  saveOutbox(env, ops) {
    let lsOk = true;
    try {
      if (ops.length) localStorage.setItem(this._outboxKey(env), JSON.stringify(ops));
      else localStorage.removeItem(this._outboxKey(env));
    } catch (e) {
      lsOk = false;
      console.warn('[LocalDB] localStorage đầy, outbox chỉ lưu trong IndexedDB:', e);
      try { localStorage.removeItem(this._outboxKey(env)); } catch (e2) {}
    }
    if (this._db) {
      this._tx(['meta'], 'readwrite', (tx) => {
        tx.objectStore('meta').put(ops, env + '|outbox');
      }).catch((e) => console.error('[LocalDB] Lỗi lưu outbox vào IndexedDB:', e));
    } else if (!lsOk) {
      console.error('[LocalDB] Không thể lưu outbox bền vững - thay đổi chỉ còn trong bộ nhớ!');
    }
    return lsOk;
  },

  // Hợp nhất outbox từ localStorage và IndexedDB (theo id, giữ thứ tự n)
  loadOutbox(env, idbOutbox) {
    let ls = [];
    try { ls = JSON.parse(localStorage.getItem(this._outboxKey(env)) || '[]'); } catch (e) {}
    const map = new Map();
    [...(Array.isArray(idbOutbox) ? idbOutbox : []), ...(Array.isArray(ls) ? ls : [])].forEach((op) => {
      if (op && op.id) map.set(op.id, op);
    });
    return Array.from(map.values()).sort((a, b) => (a.n || 0) - (b.n || 0));
  }
};

window.LocalDB = LocalDB;
