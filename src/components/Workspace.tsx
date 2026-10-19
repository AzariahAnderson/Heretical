import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { Hl } from './Code'
import { buildPreview, langOf } from '../ws'
export default function Workspace({ files, onChange, onClose }: { files: Record<string, string>; onChange: (f: Record<string, string>) => void; onClose: () => void }) {
  const names = Object.keys(files); const [tab, setTab] = useState<'preview' | 'code'>('preview'); const [cur, setCur] = useState(names[0] || '')
  const [edit, setEdit] = useState(false); const [key, setKey] = useState(0); const r = useRef<HTMLElement>(null)
  const doc = useMemo(() => buildPreview(files), [files])
  useEffect(() => { gsap.from(r.current, { x: 40, opacity: 0, duration: .45, ease: 'power3.out' }) }, [])
  useEffect(() => { if (!files[cur]) setCur(names[names.length - 1] || '') }, [files])
  const file = files[cur] ?? ''
  const open = () => { const u = URL.createObjectURL(new Blob([doc], { type: 'text/html' })); window.open(u, '_blank') }
  return <aside className="ws" ref={r}>
    <div className="ws-bar">
      {(['preview', 'code'] as const).map(t => <button key={t} className={tab === t ? 'pill on' : 'pill'} onClick={() => setTab(t)}>{t === 'preview' ? 'Preview' : 'Code'}</button>)}
      <span className="grow" />
      {tab === 'preview' && <><button className="pill" onClick={() => setKey(key + 1)}>Reload</button><button className="pill" onClick={open} disabled={!doc}>Open</button></>}
      <button className="x" onClick={onClose} aria-label="Close">×</button></div>
    {!names.length ? <div className="ws-empty"><h3>Nothing here yet</h3><p>Switch on <b>Agent</b> and describe something to build, or press Preview on any code block.</p></div>
      : tab === 'preview'
        ? (doc ? <iframe key={key} title="preview" className="frame" sandbox="allow-scripts allow-forms allow-modals" srcDoc={doc} /> : <div className="ws-empty"><p>No HTML or SVG file to preview yet.</p></div>)
        : <>
          <div className="files">{names.map(n => <span key={n} className={n === cur ? 'file on' : 'file'}><button onClick={() => { setCur(n); setEdit(false) }}>{n}</button>
            <button className="x" onClick={() => { const f = { ...files }; delete f[n]; onChange(f) }} aria-label={`Delete ${n}`}>×</button></span>)}</div>
          <div className="ws-code">
            <div className="ws-tools"><button className="pill" onClick={() => setEdit(!edit)}>{edit ? 'Done' : 'Edit'}</button>
              <button className="pill" onClick={() => navigator.clipboard.writeText(file)}>Copy</button>
              <a className="pill" href={URL.createObjectURL(new Blob([file]))} download={cur}>Download</a></div>
            {edit ? <textarea className="editor" spellCheck={false} value={file} onChange={e => onChange({ ...files, [cur]: e.target.value })} /> : <Hl lang={langOf(cur)} code={file} />}
          </div></>}
  </aside>
}
