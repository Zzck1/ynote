import json,os,socket,sys
from pathlib import Path
from urllib.parse import urlsplit

def configured_origins(default):
    """The site owner may configure this file before distributing the helper."""
    config=Path(__file__).resolve().parent.parent/'allowed-origins.json'
    if not config.is_file():return tuple(default)
    values=json.loads(config.read_text('utf-8')).get('allowed_origins')
    if not isinstance(values,list) or not values or len(values)>10:raise ValueError('助手网站来源配置无效')
    for origin in values:
        if not isinstance(origin,str):raise ValueError('助手网站来源必须为网址')
        parsed=urlsplit(origin)
        if origin=='http://127.0.0.1:8792':continue
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or parsed.port not in (None,443):raise ValueError('助手网站来源必须为完整 HTTPS origin，不含路径')
    return tuple(dict.fromkeys(values))

def main():
    os.environ['YNOTE_COMPANION_MODE']='1'
    from .network_guard import install_process
    install_process()
    from .server import create_companion,PORT,app_root,ORIGINS
    import uvicorn
    root=app_root();root.mkdir(parents=True,exist_ok=True)
    if sys.stderr is None:sys.stderr=open(root/'companion.log','a',encoding='utf-8')
    if sys.stdout is None:sys.stdout=sys.stderr
    # Acquire port once and hand the same bound socket to uvicorn (no check/use race).
    sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
    if os.name=='nt':sock.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
    try:sock.bind(('127.0.0.1',PORT))
    except OSError:
        from .server import confirm
        if os.name=='nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None,'助手已运行或端口 18790 被占用。请检查状态窗口；不会另开监听端口。','Ynote',0x10)
        return 2
    sock.listen(128)
    app=create_companion(root,origins=configured_origins(ORIGINS))
    config=uvicorn.Config(app,host='127.0.0.1',port=PORT,access_log=False,log_level='warning')
    server=uvicorn.Server(config);server.run(sockets=[sock]);return 0

if __name__=='__main__':sys.exit(main())
