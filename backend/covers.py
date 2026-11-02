"""Fetch the platform thumbnail explicitly; never substitute video screenshots."""
import os
from pathlib import Path
import subprocess

def download_cover(url, folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    command = [os.sys.executable, '-m', 'companion.downloader' if os.environ.get('YNOTE_COMPANION_MODE') else 'yt_dlp',
               '--ignore-config', '--no-playlist', '--skip-download', '--write-thumbnail',
               '--no-warnings', '--socket-timeout', '15', '--retries', '1',
               '-o', str(folder / 'platform-cover.%(ext)s'), '--', url]
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=50)
    if result.returncode: return None
    return next((p for p in folder.glob('platform-cover.*')
                 if p.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp') and 0 < p.stat().st_size <= 15 * 1024 * 1024), None)
