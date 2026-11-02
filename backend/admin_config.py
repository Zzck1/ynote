"""Server administrator only. Never include this module in the local assistant."""
import ctypes,getpass,os
from ctypes import wintypes
from pathlib import Path

class Blob(ctypes.Structure):
    _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_byte))]

def key_path():return Path(os.environ['YNOTE_PLATFORM_KEY_FILE']) if os.environ.get('YNOTE_PLATFORM_KEY_FILE') else Path(os.environ['LOCALAPPDATA'])/'YnoteCloud'/'platform-key.dpapi'

def save_key(key):
    if not isinstance(key,str) or not key.strip() or len(key)>4096 or any(c.isspace() for c in key):
        raise ValueError('请输入有效的平台 Key')
    p=key_path();p.parent.mkdir(parents=True,exist_ok=True)
    temporary=p.with_suffix('.tmp')
    temporary.write_bytes(crypt(key.encode('utf-8'),True));temporary.replace(p)

def crypt(data,protect):
    if os.name!='nt':raise RuntimeError('非 Windows 服务器请使用部署平台的 Secret 环境变量')
    buffer=ctypes.create_string_buffer(data);source=Blob(len(data),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_byte)));target=Blob()
    library=ctypes.WinDLL('crypt32',use_last_error=True)
    function=library.CryptProtectData if protect else library.CryptUnprotectData
    function.restype=wintypes.BOOL
    function.argtypes=[ctypes.POINTER(Blob),wintypes.LPCWSTR if protect else ctypes.POINTER(wintypes.LPWSTR),ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
    ok=function(ctypes.byref(source),'Ynote Cloud platform key' if protect else None,None,None,None,1,ctypes.byref(target))
    if not ok:raise RuntimeError('Windows 凭据加密操作失败（错误 '+str(ctypes.get_last_error())+'）；请使用当前 Windows 用户启动后端服务')
    try:return ctypes.string_at(target.data,target.size)
    finally:
        free=ctypes.WinDLL('kernel32',use_last_error=True).LocalFree
        free.argtypes=[ctypes.c_void_p];free.restype=ctypes.c_void_p
        free(target.data)

def read_key():
    p=key_path()
    return crypt(p.read_bytes(),False).decode('utf-8') if p.exists() else ''

if __name__=='__main__':
    key=getpass.getpass('仅在实际后端服务器输入硅基流动平台 Key（不回显）: ').strip()
    if not key:raise SystemExit('未输入密钥，未保存。')
    p=key_path();p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(crypt(key.encode(),True));del key
    print('已使用 Windows 当前用户 DPAPI 加密保存。未验证密钥，未调用模型，平台调用仍需核验模型、价格和参数后启用。')
