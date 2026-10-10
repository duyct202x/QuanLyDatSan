import os
import json
import re

search_dir = r"c:\Users\Dcatrus\Documents\Projects\QuanLyDatSan\scratch"
all_sessions = {}
all_users = {}
all_club_infos = {}
all_rules = []

for root, dirs, files in os.walk(search_dir):
    for f in files:
        if f.endswith('.json') or f.endswith('.py') or f.startswith('f_'):
            full_path = os.path.join(root, f)
            try:
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as fp:
                    content = fp.read()
                    # Check for sessions
                    if 'Vui - khỏe - có ích' in content or 'ses_179041' in content:
                        print(f"Found match in {full_path}")
                        # Try to find JSON chunks
                        for match in re.finditer(r'\{[^{}]*"title"\s*:\s*"Vui[^{}]*\}', content):
                            print("  Session match:", match.group(0))
                    if 'MyNewSecret' in content:
                        print(f"Found MyNewSecret in {full_path}")
                    if 'rule_' in content and 'n/a' in content:
                        print(f"Found n/a rule in {full_path}")
            except Exception as e:
                pass

print("Search completed.")
