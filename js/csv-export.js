// Csv - Xuất CSV an toàn: bọc dấu nháy, và vô hiệu hóa ô bắt đầu bằng = + - @ (chống chèn công thức khi mở bằng Excel/Sheets)
const Csv = {
  cell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  },

  build(header, rows) {
    return '\uFEFF' + [header].concat(rows).map((r) => r.map((c) => this.cell(c)).join(',')).join('\r\n') + '\r\n';
  },

  download(filename, header, rows) {
    const blob = new Blob([this.build(header, rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

window.Csv = Csv;
