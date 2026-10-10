#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Sinh resources/inputs/google_apps_script_prod.js = gas_server_v2.js + js/sync-core.js + js/auth-core.js
(Apps Script không import được tệp ngoài, nên SyncCore/AuthCore phải được nhúng nguyên văn.)
Chạy: python tools/build_gas_backend.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "resources", "inputs", "gas_server_v2.js")
CORE = os.path.join(ROOT, "js", "sync-core.js")
AUTH = os.path.join(ROOT, "js", "auth-core.js")
OUT = os.path.join(ROOT, "resources", "inputs", "google_apps_script_prod.js")


def main():
    with open(SERVER, encoding="utf-8") as f:
        server = f.read().rstrip() + "\n"
    parts = [server]
    for path in (CORE, AUTH):
        with open(path, encoding="utf-8") as f:
            code = f.read()
        # Bỏ dòng export CommonJS (không có `module` trong Apps Script)
        code = "\n".join(l for l in code.splitlines() if not l.startswith("if (typeof module")).rstrip() + "\n"
        rel = os.path.relpath(path, ROOT).replace("\\", "/")
        parts.append(
            "\n// ======================================================================\n"
            f"// SINH TỰ ĐỘNG từ {rel} (python tools/build_gas_backend.py). Không sửa tay.\n"
            "// ======================================================================\n" + code
        )
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("".join(parts))
    print(f"Đã sinh {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
