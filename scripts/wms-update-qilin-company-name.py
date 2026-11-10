#!/usr/bin/env python3
"""Persist the QLSZ company name in the production Compose configuration."""
from pathlib import Path
import re
from shutil import copy2

path = Path('.env')
content = path.read_text()
pattern = r'(?m)^[ \t]*(?:export[ \t]+)?XIYA_QILIN_WMS_COMPANY_NAME[ \t]*=.*$'
updated, count = re.subn(pattern, 'XIYA_QILIN_WMS_COMPANY_NAME=QLSZ', content)
if not count:
    updated = content.rstrip('\n') + '\nXIYA_QILIN_WMS_COMPANY_NAME=QLSZ\n'
if updated != content:
    copy2(path, path.with_name('.env.before-qlsz-rename'))
    path.write_text(updated)
print('Production config: XIYA_QILIN_WMS_COMPANY_NAME=QLSZ')
