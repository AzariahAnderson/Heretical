// tiny IndexedDB blob store so generated images never hit localStorage limits
const open = () => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('heretical', 1); r.onupgradeneeded = () => r.result.createObjectStore('img'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const tx = async <T,>(m: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => { const d = await open(); return new Promise<T>((res, rej) => { const r = f(d.transaction('img', m).objectStore('img')); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }) }
export const putImg = (id: string, v: string) => tx('readwrite', s => s.put(v, id))
export const getImg = (id: string) => tx<string | undefined>('readonly', s => s.get(id))
