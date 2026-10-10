// AuthCore - Băm mật khẩu & ký phiên đăng nhập (token)
// Dùng chung cho trình duyệt và Google Apps Script. KHÔNG sửa bản trong google_apps_script_prod.js -
// chạy `python tools/build_gas_backend.py` để sinh lại.
//
// Định dạng mật khẩu lưu trên máy chủ: $kdf1$<số vòng>$<muối>$<hex>
//   = băm lặp có muối của "inner", với inner là dạng băm cũ ($sha256$...) hoặc chuỗi cũ bất kỳ
//   -> nâng cấp được toàn bộ mật khẩu cũ mà không cần biết mật khẩu gốc.
var AuthCore = (function () {
  var LEGACY_SALT = "SMASH_PRO_SECURE_SALT_2026";
  var KDF_ITER = 2000;
  var WEAK = ['admin', 'admin123', '123456', '1234567', '12345678', '123456789', '1234567890', 'password',
    'password123', '111111', '000000', '123123', 'abc123', 'qwerty', '666666', '888888'];

  // SHA-256 (giữ NGUYÊN thuật toán của bản cũ trong storage.js để mật khẩu đã lưu vẫn khớp)
  function sha256(ascii) {
    if (!ascii) return "";
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    var maxWord = Math.pow(2, 32);
    var i, j;
    var result = '';
    var words = [];
    var asciiBitLength = ascii.length * 8;
    var hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    var k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    words[asciiBitLength >> 5] |= 0x80 << (24 - asciiBitLength % 32);
    words[(((asciiBitLength + 64) >> 9) << 4) + 15] = asciiBitLength;
    for (i = 0; i < ascii.length; i++) {
      words[i >> 2] |= ascii.charCodeAt(i) << (24 - (i % 4) * 8);
    }
    for (j = 0; j < words.length; j += 16) {
      var w = words.slice(j, j + 16);
      var oldHash = hash.slice(0);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? (w[i] || 0) : (
              w[i - 16]
              + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
              + w[i - 7]
              + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
            ) | 0
          );
        var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0, a, hash[1], hash[2], (hash[3] + temp1) | 0, hash[4], hash[5], hash[6]];
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j >= 0; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  function utf8(s) {
    return unescape(encodeURIComponent(String(s)));
  }
  function hexToBin(hex) {
    var out = '';
    for (var i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return out;
  }
  function toHex(s) {
    var b = utf8(s), out = '';
    for (var i = 0; i < b.length; i++) out += (b.charCodeAt(i) < 16 ? '0' : '') + b.charCodeAt(i).toString(16);
    return out;
  }
  function fromHex(hex) {
    return decodeURIComponent(escape(hexToBin(hex)));
  }

  // HMAC-SHA256 chuẩn (RFC 2104) trên chuỗi byte
  function hmac(key, msg) {
    var k = utf8(key);
    if (k.length > 64) k = hexToBin(sha256(k));
    while (k.length < 64) k += String.fromCharCode(0);
    var ipad = '', opad = '';
    for (var i = 0; i < 64; i++) {
      ipad += String.fromCharCode(k.charCodeAt(i) ^ 0x36);
      opad += String.fromCharCode(k.charCodeAt(i) ^ 0x5c);
    }
    return sha256(opad + hexToBin(sha256(ipad + utf8(msg))));
  }

  // So sánh không lộ thời gian (tránh dò từng ký tự)
  function safeEqual(a, b) {
    a = String(a); b = String(b);
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function canonical(pwd) {
    return '$sha256$' + sha256(String(pwd).trim());
  }

  // Các dạng mật khẩu cũ từng được lưu (để khớp & nâng cấp)
  function legacyCandidates(pwd) {
    var input = String(pwd).trim();
    var h1 = 5381, h2 = 0;
    var legacySalted = LEGACY_SALT + '::' + input + '::' + (input.length * 31);
    for (var i = 0; i < legacySalted.length; i++) {
      var c = legacySalted.charCodeAt(i);
      h1 = ((h1 << 5) + h1) ^ c;
      h2 = (c + (h2 << 6) + (h2 << 16) - h2) >>> 0;
    }
    var pad8 = function (s) { while (s.length < 8) s = '0' + s; return s; };
    return [
      canonical(input),
      '$sha256$' + sha256(LEGACY_SALT + '::' + input),
      '$sha256$' + pad8(Math.abs(h1).toString(16)) + pad8(Math.abs(h2).toString(16)),
      input
    ];
  }

  function isKdf(stored) {
    return /^\$kdf1\$\d+\$[0-9a-f]+\$[0-9a-f]{64}$/.test(String(stored || ''));
  }

  function kdf(inner, salt, iter) {
    var h = String(inner);
    for (var i = 0; i < iter; i++) h = sha256(salt + '$' + i + '$' + h);
    return '$kdf1$' + iter + '$' + salt + '$' + h;
  }

  function newSalt(seed) {
    return sha256(String(seed) + ':' + Math.random() + ':' + Date.now()).slice(0, 24);
  }

  // inner: dạng băm cũ hoặc chuẩn ($sha256$...). Trả về chuỗi lưu trữ an toàn.
  function wrap(inner, seed) {
    return kdf(inner, newSalt(seed || inner), KDF_ITER);
  }

  // Chuỗi mật khẩu đang lưu kiểu cũ (bất kỳ dạng nào) -> bọc nguyên văn, verify() vẫn khớp nhờ legacyCandidates
  function wrapLegacy(stored, seed) {
    return isKdf(stored) ? String(stored) : wrap(String(stored), seed);
  }

  // Giá trị client gửi lên (đã băm $sha256$ hoặc văn bản thô) -> chuỗi lưu trữ an toàn
  function protect(value, seed) {
    var v = String(value || '');
    if (!v) return '';
    if (isKdf(v)) return v;
    return wrap(/^\$sha256\$[0-9a-f]{64}$/.test(v) ? v : canonical(v), seed);
  }

  // Kiểm tra mật khẩu. upgrade = true khi nên lưu lại dạng chuẩn mới.
  function verify(stored, pwd) {
    stored = String(stored || '');
    if (!stored || !String(pwd || '').trim()) return { ok: false };
    var cands = legacyCandidates(pwd);
    if (isKdf(stored)) {
      var p = stored.split('$'); // ['', 'kdf1', iter, salt, hex]
      var iter = Number(p[2]), salt = p[3];
      for (var i = 0; i < cands.length; i++) {
        if (safeEqual(kdf(cands[i], salt, iter), stored)) return { ok: true, upgrade: i > 0 || iter !== KDF_ITER };
      }
      return { ok: false };
    }
    for (var j = 0; j < cands.length; j++) {
      if (safeEqual(cands[j], stored)) return { ok: true, upgrade: true };
    }
    return { ok: false };
  }

  function isWeakPassword(pwd, user) {
    var p = String(pwd || '').trim();
    var lower = p.toLowerCase();
    if (p.length < 6) return true;
    if (WEAK.indexOf(lower) !== -1) return true;
    if (user) {
      var digits = p.replace(/\D/g, '');
      if (user.username && lower === String(user.username).toLowerCase()) return true;
      if (user.phone && digits.length === p.length && digits === String(user.phone).replace(/\D/g, '')) return true;
    }
    return false;
  }

  // Token = hex(payload JSON) + "." + HMAC(secret, hex). Payload: { u, pv, exp, mc }
  function signToken(payload, secret) {
    var body = toHex(JSON.stringify(payload));
    return body + '.' + hmac(secret, body);
  }
  function readToken(token) {
    try {
      var body = String(token || '').split('.')[0];
      return body ? JSON.parse(fromHex(body)) : null;
    } catch (e) { return null; }
  }
  function verifyToken(token, secret, now) {
    var parts = String(token || '').split('.');
    if (parts.length !== 2 || !/^[0-9a-f]+$/.test(parts[0])) return null;
    if (!safeEqual(hmac(secret, parts[0]), parts[1])) return null;
    var payload = readToken(token);
    if (!payload || !payload.u || !(Number(payload.exp) > (now || Date.now()))) return null;
    return payload;
  }

  return {
    sha256: sha256,
    hmac: hmac,
    canonical: canonical,
    legacyCandidates: legacyCandidates,
    isKdf: isKdf,
    wrapLegacy: wrapLegacy,
    protect: protect,
    verify: verify,
    isWeakPassword: isWeakPassword,
    signToken: signToken,
    readToken: readToken,
    verifyToken: verifyToken,
    KDF_ITER: KDF_ITER
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AuthCore;
