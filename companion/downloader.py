from .network_guard import install_network,install_process
install_network();install_process()
import sys,yt_dlp
from urllib.parse import urlsplit
from copy import deepcopy

def prefer_standard_bilibili_cdn(play_info):
    """Use publisher-provided HTTPS backups instead of peer CDN ports.

    Keep the egress guard unchanged; never rewrite a signed URL or admit an
    arbitrary host supplied by video metadata.
    """
    data = deepcopy(play_info)
    def allowed(url):
        try:
            parsed = urlsplit(url)
            host = parsed.hostname or ''
            return (parsed.scheme == 'https' and parsed.port in (None, 443)
                    and not parsed.username and not parsed.password
                    and any(host == d or host.endswith('.' + d) for d in ('bilivideo.com', 'bilivideo.cn')))
        except (ValueError, TypeError):
            return False
    def visit(node):
        if isinstance(node, dict):
            backups = node.get('backupUrl') or node.get('backup_url') or []
            if isinstance(backups, str): backups = [backups]
            for key in ('baseUrl', 'base_url', 'url'):
                if key in node and not allowed(node[key]):
                    replacement = next((url for url in backups if allowed(url)), None)
                    if replacement: node[key] = replacement
            for value in node.values(): visit(value)
        elif isinstance(node, list):
            for value in node: visit(value)
    visit(data)
    return data

from yt_dlp.extractor.bilibili import BilibiliBaseIE
_extract_formats = BilibiliBaseIE.extract_formats
def _standard_cdn_formats(self, play_info):
    return _extract_formats(self, prefer_standard_bilibili_cdn(play_info))
BilibiliBaseIE.extract_formats = _standard_cdn_formats

if __name__=='__main__':
    yt_dlp.main(['--no-js-runtimes','--no-plugin-dirs','--proxy','','--no-cache-dir',*sys.argv[1:]])
