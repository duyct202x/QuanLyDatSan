// Giả lập môi trường Google Apps Script (SpreadsheetApp, LockService, CacheService...) trong trình duyệt
// để chạy NGUYÊN VĂN resources/inputs/google_apps_script_prod.js trong kiểm thử.
(function () {
  function FakeRange(sheet, row, col, nRows, nCols) {
    this.getValues = function () {
      var out = [];
      for (var r = 0; r < nRows; r++) {
        var line = [];
        for (var c = 0; c < nCols; c++) {
          var v = (sheet._cells[row - 1 + r] || [])[col - 1 + c];
          line.push(v === undefined ? '' : v);
        }
        out.push(line);
      }
      return out;
    };
    this.setValues = function (vals) {
      for (var r = 0; r < vals.length; r++) {
        if (!sheet._cells[row - 1 + r]) sheet._cells[row - 1 + r] = [];
        for (var c = 0; c < vals[r].length; c++) sheet._cells[row - 1 + r][col - 1 + c] = vals[r][c];
      }
      return this;
    };
    this.clearContent = function () {
      for (var r = 0; r < nRows; r++) for (var c = 0; c < nCols; c++) {
        if (sheet._cells[row - 1 + r]) sheet._cells[row - 1 + r][col - 1 + c] = '';
      }
      return this;
    };
    this.setNumberFormat = this.setFontWeight = this.setBackground = this.setFontColor = function () { return this; };
  }

  function FakeSheet(name) {
    this._name = name;
    this._cells = [];
    this._maxCols = 26;
  }
  FakeSheet.prototype.getRange = function (row, col, nRows, nCols) {
    if (typeof row === 'string') return new FakeRange(this, 1, 1, 0, 0);
    return new FakeRange(this, row, col, nRows || 1, nCols || 1);
  };
  FakeSheet.prototype.getLastRow = function () {
    for (var r = this._cells.length - 1; r >= 0; r--) {
      if ((this._cells[r] || []).some(function (v) { return v !== '' && v !== undefined; })) return r + 1;
    }
    return 0;
  };
  FakeSheet.prototype.getLastColumn = function () {
    var m = 0;
    this._cells.forEach(function (row) {
      (row || []).forEach(function (v, i) { if (v !== '' && v !== undefined && i + 1 > m) m = i + 1; });
    });
    return m;
  };
  FakeSheet.prototype.getMaxColumns = function () { return this._maxCols; };
  FakeSheet.prototype.insertColumnsAfter = function (after, n) { this._maxCols += n; };
  FakeSheet.prototype.appendRow = function (vals) { this._cells[this.getLastRow()] = vals.slice(); };
  FakeSheet.prototype.deleteRows = function (start, n) { this._cells.splice(start - 1, n); };
  FakeSheet.prototype.setFrozenRows = function () {};
  FakeSheet.prototype.getName = function () { return this._name; };

  var sheets = {};
  var props = {};
  var cache = {};

  window.FakeGAS = {
    reset: function () { sheets = {}; props = {}; cache = {}; },
    sheet: function (name) { return sheets[name]; },
    // Ghi sheet v1 (JSON nguyên khối) như hệ thống cũ để kiểm thử chuyển đổi dữ liệu
    // opts.chunks: chia JSON thành nhiều ô (giống v1 thật); opts.chunkCountCell: giá trị ghi ở D2 (có thể sai)
    seedV1: function (name, data, opts) {
      opts = opts || {};
      var s = new FakeSheet(name);
      var json = JSON.stringify(data);
      var n = opts.chunks || 1, size = Math.ceil(json.length / n);
      s._cells[0] = ['DATA_JSON', 'LAST_UPDATED', 'REVISION', 'CHUNK_COUNT'];
      for (var i = 0; i < n; i++) {
        s._cells[1 + i] = [json.substring(i * size, (i + 1) * size)];
      }
      s._cells[1][1] = 'x';
      s._cells[1][2] = 7;
      s._cells[1][3] = opts.chunkCountCell !== undefined ? opts.chunkCountCell : n;
      sheets[name] = s;
    },
    setProp: function (k, v) { props[k] = String(v); },
    dropCache: function () { cache = {}; }
  };

  window.SpreadsheetApp = {
    getActiveSpreadsheet: function () {
      return {
        getSheetByName: function (n) { return sheets[n] || null; },
        getSheets: function () { return Object.keys(sheets).map(function (k) { return sheets[k]; }); },
        insertSheet: function (n) { sheets[n] = new FakeSheet(n); return sheets[n]; }
      };
    },
    flush: function () {}
  };
  window.LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } };
  window.CacheService = {
    getScriptCache: function () {
      return {
        get: function (k) { return k in cache ? cache[k] : null; },
        put: function (k, v) { cache[k] = String(v); }
      };
    }
  };
  window.PropertiesService = {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return k in props ? props[k] : null; },
        setProperty: function (k, v) { props[k] = String(v); }
      };
    }
  };
  window.ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: function (s) { return { setMimeType: function () { return this; }, getContent: function () { return s; } }; }
  };
  window.Utilities = {
    formatDate: function (d) { return d.toISOString(); },
    getUuid: function () { return crypto.randomUUID(); }
  };
  window.Logger = { log: function () {} };
  window.__triggers = [];
  window.ScriptApp = {
    getProjectTriggers: function () { return window.__triggers.slice(); },
    deleteTrigger: function (t) { window.__triggers = window.__triggers.filter(function (x) { return x !== t; }); },
    newTrigger: function (fn) {
      return { timeBased: function () { return { everyMinutes: function () { return { create: function () {
        var t = { getHandlerFunction: function () { return fn; } };
        window.__triggers.push(t);
        return t;
      } }; } }; } };
    }
  };
  window.__mails = [];
  window.MailApp = {
    getRemainingDailyQuota: function () { return 100; },
    sendEmail: function (to, subject, body) { window.__mails.push({ to: to, subject: subject, body: body }); }
  };

  // Máy chủ giả: định tuyến fetch của các thiết bị tới doGet/doPost
  window.fakeServerFetch = function (url, init) {
    var u = new URL(url);
    var parameter = {};
    u.searchParams.forEach(function (v, k) { parameter[k] = v; });
    var method = (init && init.method) || 'GET';
    window.__requests = (window.__requests || 0) + 1;
    var out = method === 'POST'
      ? doPost({ parameter: parameter, postData: { contents: init.body } })
      : doGet({ parameter: parameter });
    var body = out.getContent();
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve(JSON.parse(body)); },
      text: function () { return Promise.resolve(body); }
    });
  };
})();
