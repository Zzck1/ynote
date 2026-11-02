"""Fail-closed egress rules for downloader Python and local media subprocesses."""
import ipaddress,os,socket,subprocess
from pathlib import Path
from backend.provider_profiles import is_public
from backend.network_dns import public_source_addresses

CDNS=('bilibili.com','b23.tv','bilivideo.com','bilivideo.cn','hdslb.com','biliapi.net','biliapi.com',
      'youtube.com','youtu.be','googlevideo.com','ytimg.com','youtubei.googleapis.com',
      'douyin.com','iesdouyin.com','douyinvod.com','douyinpic.com','byteimg.com','bytedance.com','ibytedtos.com','snssdk.com',
      'kuaishou.com','gifshow.com','ksapisrv.com','kwimgs.com','ksyuncdn.com',
      'vimeo.com','vimeocdn.com','twitter.com','x.com','twimg.com','tiktok.com','tiktokcdn.com',
      'xiaohongshu.com','xhslink.com','xhscdn.com')

def install_network():
    original=socket.socket.connect;original_ex=socket.socket.connect_ex
    def checked(address):
        host,port=address[:2]
        if port not in (80,443):raise OSError('下载端口未获批准')
        try:
            direct=ipaddress.ip_address(host)
            # Numeric address must already have been admitted by guarded DNS below.
            if str(direct) not in admitted or not is_public(str(direct)):raise OSError('拒绝直接或受保护网络地址')
            return address
        except ValueError:pass
        if not any(host==d or host.endswith('.'+d) for d in CDNS):raise OSError('来源或 CDN 尚未获批准')
        results=dns(host,port,type=socket.SOCK_STREAM)
        ips=[r[4][0] for r in results]
        if not ips or any(not is_public(i) for i in ips):raise OSError('拒绝受保护网络地址')
        admitted.update(ips);return (ips[0],port,*address[2:])
    real_dns=socket.getaddrinfo
    # Only the opt-in HTTPS DNS resolver may be contacted by its fixed numeric
    # public address. This prevents recursive Fake-IP DNS inside the guard.
    admitted={'8.8.8.8'} if os.environ.get('YNOTE_PROXY_DNS_VERIFY')=='1' else set()
    def dns(host,port,*args,**kwargs):
        if isinstance(host,bytes):host=host.decode('ascii')
        if str(host) in admitted and port in (80,443,'80','443'):
            return real_dns(host,port,*args,**kwargs)
        if port not in (80,443,'80','443') or not any(host==d or host.endswith('.'+d) for d in CDNS):raise OSError('下载目标未获批准')
        rows=real_dns(host,port,*args,**kwargs)
        if rows and any(not is_public(r[4][0]) for r in rows):
            ips=public_source_addresses(host,int(port),resolver=lambda *_:rows,doh_endpoint='https://8.8.8.8/resolve')
            rows=[row for ip in ips for row in real_dns(ip,port,*args,**kwargs)]
        if not rows or any(not is_public(r[4][0]) for r in rows):raise OSError('拒绝受保护网络地址')
        admitted.update(r[4][0] for r in rows);return rows
    socket.getaddrinfo=dns
    socket.socket.connect=lambda s,address:original(s,checked(address))
    socket.socket.connect_ex=lambda s,address:original_ex(s,checked(address))

def install_process():
    original=subprocess.Popen
    class Restricted(original):
        def __init__(self,args,*a,**kw):
            self._ynote_job=None
            if kw.get('shell') or not isinstance(args,(list,tuple)):raise ValueError('禁用 shell 与命令字符串')
            args=list(args);name=Path(str(args[0])).name.lower()
            if name in ('ffmpeg','ffmpeg.exe','ffprobe','ffprobe.exe'):
                allowed='mov,matroska,webm,avi,mp3,wav,flac,ogg,aac,image2,jpeg_pipe,png_pipe'
                if name.startswith('ffprobe'):
                    args[1:1]=['-protocol_whitelist','file,pipe','-format_whitelist',allowed]
                else:
                    for i in reversed([i for i,x in enumerate(args) if x=='-i']):args[i:i]=['-protocol_whitelist','file,pipe','-format_whitelist',allowed]
                tools=Path(os.environ.get('YNOTE_TOOLS_DIR',str(Path(__file__).resolve().parent.parent/'tools')))
                args[0]=str(tools/('ffmpeg.exe' if name.startswith('ffmpeg') else 'ffprobe.exe'))
            super().__init__(args,*a,**kw)
            if os.name=='nt':
                from .processes import WindowsJob
                try:self._ynote_job=WindowsJob(self)
                except OSError:
                    super().kill();super().wait();raise
        def terminate(self):
            if self._ynote_job:self._ynote_job.terminate()
            else:super().terminate()
        kill=terminate
        def wait(self,*a,**kw):
            result=super().wait(*a,**kw)
            if self._ynote_job:self._ynote_job.close()
            return result
    subprocess.Popen=Restricted
