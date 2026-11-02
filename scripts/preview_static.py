"""Development-only loopback static preview with metadata-only HTTP evidence; no content APIs."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit,unquote
from datetime import datetime,timezone
import argparse,json,threading
parser=argparse.ArgumentParser()
parser.add_argument('--port',type=int,default=8792)
parser.add_argument('--log',type=Path,default=Path(__file__).resolve().parent.parent/'validation/r2/http-static-requests.jsonl')
args=parser.parse_args()
ROOT=(Path(__file__).resolve().parent.parent/'frontend/dist').resolve()
args.log.parent.mkdir(parents=True,exist_ok=True)
lock=threading.Lock()
class Handler(SimpleHTTPRequestHandler):
    extensions_map={**SimpleHTTPRequestHandler.extensions_map,'.mjs':'text/javascript','.js':'text/javascript','.wasm':'application/wasm','.onnx':'application/octet-stream'}
    def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT),**kw)
    def do_GET(self):
        route=unquote(urlsplit(self.path).path)
        if route.startswith('/api/'):
            self.send_error(404,'Static preview has no content APIs');return
        if route in ['/','/settings','/workspace','/notes']:
            self.path='/index.html'
        return super().do_GET()
    def do_POST(self):self.send_error(405,'No uploads or inference on this preview')
    do_PUT=do_POST
    do_PATCH=do_POST
    do_DELETE=do_POST
    def log_request(self,code='-',size='-'):
        path=urlsplit(self.path).path
        safe=path if path.startswith(('/models/','/runtime/','/assets/','/fonts/')) or path in ['/index.html','/browser-offline.js','/offline-files.json'] else '<navigation-or-other>'
        record={'at':datetime.now(timezone.utc).isoformat(),'method':self.command,'resource':safe,'status':code,'scope':'loopback-static-server; no request body recorded'}
        with lock,args.log.open('a',encoding='utf-8') as out:out.write(json.dumps(record,ensure_ascii=False)+'\n')
    def log_message(self,*a):pass
print(f'Ynote static preview http://127.0.0.1:{args.port}; no upload/inference APIs',flush=True)
ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
