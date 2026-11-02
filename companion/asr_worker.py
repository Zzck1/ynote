"""Isolated CPU medium execution; only invoked with application-owned paths."""
import json,os,subprocess,sys,time
from pathlib import Path

def main():
    model,audio,output,progress,ffmpeg=sys.argv[1:6]
    for name in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[name]=str(min(4,os.cpu_count() or 1))
    os.environ['HF_HUB_OFFLINE']='1'
    def offline(event,args):
        if event in ('socket.connect','socket.getaddrinfo'):raise RuntimeError('本地 ASR 进程禁止网络访问')
    sys.addaudithook(offline)
    from .pcm_audio import install
    install()
    from faster_whisper import WhisperModel
    start=time.monotonic();m=WhisperModel(model,device='cpu',compute_type='int8',cpu_threads=min(4,os.cpu_count() or 1),num_workers=1,local_files_only=True)
    if audio=='--check':Path(output).write_text(json.dumps({'loaded':True,'seconds':time.monotonic()-start}),'utf-8');return
    wav=Path(output).with_suffix('.wav')
    try:
        subprocess.run([ffmpeg,'-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mp3,wav,flac,ogg,aac','-i',audio,'-vn','-ac','1','-ar','16000',str(wav)],check=True,timeout=180,capture_output=True)
        segments,info=m.transcribe(str(wav),beam_size=5,language=None,vad_filter=False,condition_on_previous_text=False,
                                   initial_prompt='请按原话转写，使用自然的逗号、句号、问号等标点。')
        result=[]
        for s in segments:
            if s.text.strip():result.append((round(s.start*1000),round(s.end*1000),s.text.strip()))
            Path(progress).write_text(json.dumps({'processed_ms':round(s.end*1000),'duration_ms':round(info.duration*1000)}),'utf-8')
        if not result:raise ValueError('未识别到语音')
        Path(output).write_text(json.dumps({'segments':result,'language':info.language,'seconds':time.monotonic()-start},ensure_ascii=False),'utf-8')
    finally:wav.unlink(missing_ok=True)

if __name__=='__main__':main()
