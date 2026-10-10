import json
import sys
import io
import time
import requests
import os
from clean_cloud_prod import sync_pure_prod

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

if __name__ == "__main__":
    sync_pure_prod()
