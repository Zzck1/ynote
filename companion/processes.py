"""Owned Windows Job Objects: terminate a task's descendants without opening PIDs."""
import ctypes,os
from ctypes import wintypes

SIZE=ctypes.c_size_t
class Basic(ctypes.Structure):
    _fields_=[('process_time',ctypes.c_longlong),('job_time',ctypes.c_longlong),('flags',wintypes.DWORD),('minimum',SIZE),('maximum',SIZE),('active',wintypes.DWORD),('affinity',SIZE),('priority',wintypes.DWORD),('scheduling',wintypes.DWORD)]
class IO(ctypes.Structure):
    _fields_=[(x,ctypes.c_ulonglong) for x in ('read','write','other','readbytes','writebytes','otherbytes')]
class Extended(ctypes.Structure):
    _fields_=[('basic',Basic),('io',IO),('process_memory',SIZE),('job_memory',SIZE),('peak_process',SIZE),('peak_job',SIZE)]

class WindowsJob:
    def __init__(self,process):
        self.handle=None
        if os.name!='nt':return
        k=ctypes.WinDLL('kernel32',use_last_error=True)
        k.CreateJobObjectW.argtypes=[ctypes.c_void_p,wintypes.LPCWSTR];k.CreateJobObjectW.restype=wintypes.HANDLE
        k.SetInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD];k.SetInformationJobObject.restype=wintypes.BOOL
        k.AssignProcessToJobObject.argtypes=[wintypes.HANDLE,wintypes.HANDLE];k.AssignProcessToJobObject.restype=wintypes.BOOL
        k.TerminateJobObject.argtypes=[wintypes.HANDLE,wintypes.UINT];k.TerminateJobObject.restype=wintypes.BOOL
        k.CloseHandle.argtypes=[wintypes.HANDLE];k.CloseHandle.restype=wintypes.BOOL
        self.kernel=k;self.handle=k.CreateJobObjectW(None,None)
        info=Extended();info.basic.flags=0x2000
        if not self.handle or not k.SetInformationJobObject(self.handle,9,ctypes.byref(info),ctypes.sizeof(info)) or not k.AssignProcessToJobObject(self.handle,wintypes.HANDLE(int(process._handle))):
            error=ctypes.get_last_error();self.close();raise OSError(error,'无法管理本机任务进程组')
    def terminate(self):
        if self.handle and not self.kernel.TerminateJobObject(self.handle,1):raise ctypes.WinError(ctypes.get_last_error())
    def close(self):
        if self.handle:self.kernel.CloseHandle(self.handle);self.handle=None
