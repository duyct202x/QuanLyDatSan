import requests
import json
import time
import sys
from clean_cloud_prod import sync_pure_prod

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

if __name__ == "__main__":
    print("Executing restoration with pure clean user state...")
    sync_pure_prod()
