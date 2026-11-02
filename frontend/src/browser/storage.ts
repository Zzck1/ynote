let dbPromise: Promise<IDBDatabase> | null = null
export function database() {
  if (!dbPromise) dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ynote-browser-local-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('records')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { dbPromise = null; reject(new Error('浏览器本地存储不可用，请检查存储权限；文件未上传')) }
    request.onblocked = () => { dbPromise = null; reject(new Error('本地数据库被另一页面阻塞，请关闭其他 Ynote 页面后重试')) }
  })
  return dbPromise
}
export async function read<T>(key: string): Promise<T | undefined> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction('records').objectStore('records').get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('无法读取浏览器历史记录'))
  })
}
export async function recordKeys():Promise<IDBValidKey[]>{
 const db=await database()
 return new Promise((resolve,reject)=>{const r=db.transaction('records').objectStore('records').getAllKeys();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('读取本地数据目录失败'))})
}
export async function removeRecords(keys:IDBValidKey[]){
 const db=await database()
 return new Promise<void>((resolve,reject)=>{const tx=db.transaction('records','readwrite'),store=tx.objectStore('records');for(const key of keys)store.delete(key);tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(new Error('删除本地记录失败，未修改模型缓存'))})
}
export async function write(key: string, value: unknown, signal?: AbortSignal) {
  const db = await database()
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite')
    const abort = () => { try { tx.abort() } catch { /* The transaction already completed. */ } }
    signal?.addEventListener('abort', abort, { once: true })
    const cleanup = () => signal?.removeEventListener('abort', abort)
    tx.objectStore('records').put(value, key)
    tx.oncomplete = () => { cleanup(); resolve() }
    tx.onerror = tx.onabort = () => { cleanup(); reject(new Error(signal?.aborted ? '任务已取消；旧结果没有写入' : '浏览器存储失败或空间不足，请导出已有结果并清理存储')) }
  })
}
