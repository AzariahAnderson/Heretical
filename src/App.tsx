import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { useStore, type Chat, type Msg } from './store'
import { putImg } from './db'
import Markdown from './components/Markdown'
import Select from './components/Select'
import Modal from './components/Modal'
import ImageCard from './components/ImageCard'
import Workspace from './components/Workspace'
import Logo from './components/Logo'
import { Ws } from './ws'

type M = { id: string; provider: string; name: string }
const SUGGEST = ['Explain a hard concept simply', 'Write a TypeScript debounce hook', 'Plan my week 🗓️', 'Debug my code 🐛', '/image a neon dragon over a rainy city']
const PERSONAS = ['Concise senior engineer', 'Patient teacher', 'Blunt editor', 'Creative co-writer']
const RATIOS = [['square', '1:1'], ['wide', '16:9'], ['tall', '9:16']]

function Bubble({ m, live, last, onRegen, onEdit }: { m: Msg; live?: boolean; last?: boolean; onRegen: () => void; onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null); const [ok, setOk] = useState(false)
  useEffect(() => { gsap.from(ref.current, { y: 14, opacity: 0, duration: .45, ease: 'power3.out' }) }, [])
  useEffect(() => {
    if (!live) return; const l = ref.current?.querySelector('.md > :last-child')
    if (l) gsap.fromTo(l, { opacity: .35 }, { opacity: 1, duration: .5, ease: 'sine.out', overwrite: true })
  }, [m.content, live])
  if (m.role === 'user') return <div className="row user"><div className="ubub" ref={ref}>{m.content}
    {last && <div className="acts"><button onClick={onEdit}>Edit</button></div>}</div></div>
  return <div className="row"><div ref={ref}>
    {m.steps?.length ? <div className="steps">{m.steps.map((s, i) => <span key={i} className="pill">{s}</span>)}</div> : null}
    {m.prompt !== undefined ? <ImageCard id={m.img} prompt={m.prompt} /> : <div className="md"><Markdown text={m.content} />{live && <i className="orb" />}</div>}
    {!live && <div className="acts">
      {m.prompt === undefined && <button onClick={() => { navigator.clipboard.writeText(m.content); setOk(true); setTimeout(() => setOk(false), 1200) }}>{ok ? 'Copied' : 'Copy'}</button>}
      {last && <button onClick={onRegen}>Regenerate</button>}</div>}
  </div></div>
}

export default function App() {
  const { chats, active, model, persona, engine, set, upsert, remove } = useStore()
  const [models, setModels] = useState<M[]>([]); const [engines, setEngines] = useState<string[]>([])
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [nav, setNav] = useState(false)
  const [img, setImg] = useState(false); const [ratio, setRatio] = useState('square')
  const [ws, setWs] = useState(false); const [agent, setAgent] = useState(false)
  const [q, setQ] = useState(''); const [modal, setModal] = useState(false); const [renaming, setRenaming] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null); const ctl = useRef<AbortController | null>(null); const ta = useRef<HTMLTextAreaElement>(null)
  const chat = chats.find(c => c.id === active)

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then((m: M[]) => { setModels(m); if (!m.some(x => x.id === useStore.getState().model) && m[0]) set({ model: m[0].id }) })
    fetch('/api/image-engines').then(r => r.json()).then(setEngines)
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); set({ active: null }); ta.current?.focus() } }
    addEventListener('keydown', k); return () => removeEventListener('keydown', k)
  }, [])
  useEffect(() => { scroller.current?.scrollTo({ top: 1e9 }) }, [chat?.messages])
  const shown = useMemo(() => chats.filter(c => !q || (c.title + c.messages.map(m => m.content).join(' ')).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)), [chats, q])

  const patchLast = (id: string, m: Msg) => { const cur = useStore.getState().chats.find(x => x.id === id); if (cur) upsert({ ...cur, messages: [...cur.messages.slice(0, -1), m] }) }

  async function run(c: Chat, asImage: boolean) {
    const prompt = c.messages[c.messages.length - 1].content
    c.messages = [...c.messages, { role: 'assistant', content: '', ...(asImage ? { prompt } : {}) }]
    upsert(c); set({ active: c.id }); setBusy(true); ctl.current = new AbortController()
    if (asImage) {
      try {
        const r = await fetch('/api/image', { method: 'POST', signal: ctl.current.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: prompt.replace(/^\/image\s+/i, ''), engine, ratio }) })
        const j = await r.json(); if (!r.ok) throw new Error(j.error)
        const id = crypto.randomUUID(); await putImg(id, j.image); patchLast(c.id, { role: 'assistant', content: '', prompt, img: id })
      } catch (e: any) { patchLast(c.id, { role: 'assistant', content: `**Image failed:** ${e.message}` }) }
      return setBusy(false)
    }
    if (agent) {
      let acc = '', files = { ...(c.files || {}) }; const steps: string[] = []
      const upd = () => { const cur = useStore.getState().chats.find(x => x.id === c.id)!
        upsert({ ...cur, files, messages: [...cur.messages.slice(0, -1), { role: 'assistant', content: acc, steps: [...steps] }] }) }
      try {
        const res = await fetch('/api/agent', { method: 'POST', signal: ctl.current.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, persona, files, messages: c.messages.slice(0, -1).filter(m => m.prompt === undefined && m.content).map(({ role, content }) => ({ role, content })) }) })
        if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed')
        const rd = res.body.getReader(), dec = new TextDecoder(); let buf = ''
        for (;;) {
          const { done, value } = await rd.read(); if (done) break
          buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop()!
          for (const p of parts) { try { const j = JSON.parse(p.replace(/^data:\s*/, ''))
            if (j.ev === 'file') { files = { ...files, [j.path]: j.content }; steps.push('write ' + j.path); setWs(true) }
            else if (j.ev === 'del') { const { [j.path]: _, ...rest } = files; files = rest; steps.push('delete ' + j.path) }
            else if (j.ev === 'step') steps.push(j.label)
            else if (j.t) acc += j.t; else if (j.e) acc += `\n\n**Error:** ${j.e}`
            upd() } catch {} }
        }
      } catch (e: any) { if (e.name !== 'AbortError') acc += `\n\n**Error:** ${e.message}` }
      upd(); return setBusy(false)
    }
    let acc = '', pending = false
    const flush = () => { pending = false; patchLast(c.id, { role: 'assistant', content: acc }) }
    try {
      const res = await fetch('/api/chat', { method: 'POST', signal: ctl.current.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, persona, messages: c.messages.slice(0, -1).filter(m => m.prompt === undefined && m.content).map(({ role, content }) => ({ role, content })) }) })
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed')
      const rd = res.body.getReader(), dec = new TextDecoder(); let buf = ''
      for (;;) {
        const { done, value } = await rd.read(); if (done) break
        buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop()!
        for (const p of parts) { try { const j = JSON.parse(p.replace(/^data:\s*/, '')); if (j.t) acc += j.t; if (j.e) acc += `\n\n**Error:** ${j.e}` } catch {} }
        if (!pending) { pending = true; requestAnimationFrame(flush) }
      }
    } catch (e: any) { if (e.name !== 'AbortError') acc += `\n\n**Error:** ${e.message}` }
    flush(); setBusy(false)
    if (c.messages.length <= 2 && acc && !acc.includes('**Error:**')) fetch('/api/title', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, text: c.messages[0].content + '\n\n' + acc.slice(0, 500) }) })
      .then(r => r.json()).then(j => { const cur = useStore.getState().chats.find(x => x.id === c.id); if (j.title && cur) upsert({ ...cur, title: j.title }) }).catch(() => {})
  }

  const openCode = (lang: string, code: string) => { if (!chat) return
    const ext = ({ javascript: 'js', typescript: 'ts', python: 'py' } as Record<string, string>)[lang] || lang || 'txt'
    const name = ext === 'html' ? 'index.html' : ext === 'css' ? 'style.css' : ext === 'js' ? 'script.js' : `snippet.${ext}`
    upsert({ ...chat, files: { ...(chat.files || {}), [name]: code } }); setWs(true) }

  function send(t = text) {
    t = t.trim(); if (!t || busy) return; setText(''); if (ta.current) ta.current.style.height = 'auto'
    const c: Chat = chat ? { ...chat } : { id: crypto.randomUUID(), title: t.replace(/^\/image\s+/i, '').slice(0, 40), messages: [] }
    c.messages = [...c.messages, { role: 'user', content: t }]
    run(c, img || /^\/image\s/i.test(t))
  }
  const regen = () => { if (!chat || busy) return; const last = chat.messages[chat.messages.length - 1]
    run({ ...chat, messages: chat.messages.slice(0, -1) }, last.prompt !== undefined) }
  const edit = () => { if (!chat || busy) return; const i = chat.messages.length - 2 >= 0 && chat.messages[chat.messages.length - 1].role === 'assistant' ? chat.messages.length - 2 : chat.messages.length - 1
    setText(chat.messages[i].content); upsert({ ...chat, messages: chat.messages.slice(0, i) }); ta.current?.focus() }
  const exportMd = () => { if (!chat) return; const b = new Blob([chat.messages.map(m => `## ${m.role === 'user' ? 'You' : 'HERETICAL'}\n\n${m.prompt !== undefined ? `*[image: ${m.prompt}]*` : m.content}`).join('\n\n')], { type: 'text/markdown' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${chat.title}.md`; a.click() }

  const [min, setMin] = useState(false)
  const hello = (() => { const h = new Date().getHours(); return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening' })()
  const starters: [string, string][] = [['Write', 'Help me write '], ['Learn', 'Teach me about '], ['Code', 'Write a function that '], ['Create', '/image '], ['Build', 'Build me a ']]
  const composer = <div className="composer"><div className="box">
    <textarea ref={ta} rows={1} value={text} placeholder={img ? 'Describe the image you want…' : chat ? 'Reply to HERETICAL…' : 'How can I help you today?'}
      onChange={e => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 220) + 'px' }}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
    <div className="tools">
      <button className="ibtn" title="Persona & settings" aria-label="Persona and settings" onClick={() => setModal(true)}>＋</button>
      <button className={img ? 'pill on' : 'pill'} onClick={() => setImg(!img)}>Image</button>
      <button className={agent ? 'pill on' : 'pill'} onClick={() => setAgent(!agent)}>Agent</button>
      {img && <>{RATIOS.map(([k, l]) => <button key={k} className={ratio === k ? 'pill on' : 'pill'} onClick={() => setRatio(k)}>{l}</button>)}
        {engines.length > 1 && <Select up value={engine || engines[0]} onChange={v => set({ engine: v })} options={engines.map(e => ({ id: e, label: e }))} />}</>}
      <span className="grow" />
      <Select up value={model} onChange={v => set({ model: v })} options={models.map(m => ({ id: m.id, label: `${m.name} · ${m.provider}` }))} />
      {busy ? <button className="go" onClick={() => ctl.current?.abort()} aria-label="Stop">■</button>
        : <button className="go" onClick={() => send()} disabled={!text.trim()} aria-label="Send">↑</button>}
    </div></div>
    {chat && <p className="fine">HERETICAL can make mistakes. Please double-check responses.</p>}</div>

  return <Ws.Provider value={openCode}><div className="app">
    <aside className={`side${nav ? ' open' : ''}${min ? ' min' : ''}`}>
      <div className="stop"><span className="logo"><Logo /></span><span className="label brand">HERETICAL</span>
        <button className="x collapse" onClick={() => setMin(!min)} aria-label="Toggle sidebar">{min ? '⇥' : '⇤'}</button></div>
      <button className="new" onClick={() => { set({ active: null }); setNav(false) }}><span className="ic">＋</span><span className="label">New chat</span><kbd className="label">Ctrl K</kbd></button>
      <input className="search label" placeholder="Search chats" value={q} onChange={e => setQ(e.target.value)} />
      <div className="list label"><h4>Recents</h4>{shown.map(c => <div key={c.id} className={c.id === active ? 'item on' : 'item'}>
        {renaming === c.id ? <input className="ren" autoFocus defaultValue={c.title} onBlur={e => { upsert({ ...c, title: e.target.value || c.title }); setRenaming(null) }} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          : <button onClick={() => { set({ active: c.id }); setNav(false) }} onDoubleClick={() => setRenaming(c.id)}>{c.pinned ? '◆ ' : ''}{c.title}</button>}
        <button className="x" title="Pin" onClick={() => upsert({ ...c, pinned: !c.pinned })}>◆</button>
        <button className="x" aria-label="Delete" onClick={() => remove(c.id)}>×</button></div>)}
        {!shown.length && <p className="none">No chats yet.</p>}</div>
      <button className="sfoot" onClick={() => setModal(true)}><span className="av">H</span><span className="label">Persona & settings</span></button>
    </aside>
    <main>
      <header><button className="pill burger" onClick={() => setNav(!nav)}>☰</button>
        <b className="title">{chat?.title}</b><span className="grow" />
        {chat && <button className="pill" onClick={exportMd}>Export</button>}
        <button className={ws ? 'pill on' : 'pill'} onClick={() => setWs(!ws)}>Workspace</button></header>
      {!chat ? <div className="home"><h1><span className="logo big"><Logo /></span>{hello}</h1>{composer}
        <div className="chips">{starters.map(([l, t]) => <button key={l} className="pill" onClick={() => { setText(t); if (l === 'Create') setImg(true); if (l === 'Build') setAgent(true); ta.current?.focus() }}>{l}</button>)}</div></div>
        : <><div className="scroll" ref={scroller}><div className="thread">{chat.messages.map((m, i) => <Bubble key={i} m={m} last={i === chat.messages.length - 1 || (i === chat.messages.length - 2 && m.role === 'user')}
            live={busy && i === chat.messages.length - 1 && m.prompt === undefined} onRegen={regen} onEdit={edit} />)}</div></div>{composer}</>}
    </main>
    {modal && <Modal title="Persona & settings" onClose={() => setModal(false)}>
      <p className="hint">Added to the system prompt for every chat.</p>
      <textarea className="area" rows={5} value={persona} onChange={e => set({ persona: e.target.value })} placeholder="How should HERETICAL behave?" />
      <div className="chips">{PERSONAS.map(p => <button key={p} className="pill" onClick={() => set({ persona: p })}>{p}</button>)}</div>
      <button className="pill danger" onClick={() => { if (confirm('Delete all chats?')) { set({ chats: [], active: null }); setModal(false) } }}>Delete all chats</button>
    </Modal>}
    {ws && <Workspace files={chat?.files || {}} onChange={f => chat && upsert({ ...chat, files: f })} onClose={() => setWs(false)} />}
  </div></Ws.Provider>
}
