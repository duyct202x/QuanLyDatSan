// Safe - Mã hóa dữ liệu khi chèn vào HTML (chống XSS)
// Quy tắc: MỌI dữ liệu không phải hằng số trong mã (tên, ghi chú, SĐT, tiêu đề, id...) khi chèn vào
// innerHTML / chuỗi HTML phải đi qua một trong các hàm dưới đây:
//   Văn bản hoặc giá trị thuộc tính:  <b>${Safe.html(m.name)}</b>, value="${Safe.html(m.note)}"
//   Tham số chuỗi trong onclick=...:  onclick="Mod.fn(${Safe.js(s.id)})"   (KHÔNG thêm dấu nháy bao ngoài)
//   Đường dẫn src/href:               src="${Safe.url(m.avatar)}"
// Không dùng Safe cho đoạn HTML do chính mã tạo ra (vd: ${rowsHtml}) - chỉ mã hóa dữ liệu bên trong đoạn đó.
const Safe = {
  _map: { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' },

  html(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, (c) => Safe._map[c]);
  },

  // Chuỗi JS (có sẵn dấu nháy) an toàn bên trong thuộc tính sự kiện HTML
  js(value) {
    if (value === null || value === undefined) value = '';
    return Safe.html(JSON.stringify(String(value)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'));
  },

  // Chỉ cho phép http(s), ảnh data:image và đường dẫn tương đối; chặn javascript:, data:text/html...
  url(value, fallback = '') {
    const s = String(value === null || value === undefined ? '' : value).trim();
    if (!s) return Safe.html(fallback);
    if (/^https?:\/\//i.test(s) || /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(s)) return Safe.html(s);
    if (/^(mailto:|tel:)/i.test(s)) return Safe.html(s);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('//')) return Safe.html(s); // đường dẫn tương đối
    return Safe.html(fallback);
  }
};

window.Safe = Safe;
