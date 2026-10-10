import json
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

cache_path = r"c:\Users\Dcatrus\Documents\Projects\QuanLyDatSan\scratch\chrome_privacy_1790420962\Default\Cache\Cache_Data\f_000007"
with open(cache_path, 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()
    print("Content length:", len(content))
    # Look for Vui - khỏe
    idx = content.find('Vui -')
    if idx != -1:
        print("Snippet around 'Vui -':")
        print(content[max(0, idx - 200):min(len(content), idx + 400)])
