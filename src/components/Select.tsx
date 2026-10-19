import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
export default function Select({ value, options, onChange, up }: { up?: boolean; value: string; options: { id: string; label: string }[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false); const menu = useRef<HTMLDivElement>(null)
  useEffect(() => { if (open && menu.current) gsap.fromTo(menu.current, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: .25, ease: 'power3.out' }) }, [open])
  useEffect(() => { const f = () => setOpen(false); if (open) addEventListener('click', f); return () => removeEventListener('click', f) }, [open])
  const cur = options.find(o => o.id === value)
  return <div className="select">
    <button className="pill" onClick={e => { e.stopPropagation(); setOpen(!open) }}>{cur?.label || 'No models'} <span className="chev">▾</span></button>
    {open && <div className={up ? 'menu up' : 'menu'} ref={menu}>{options.map(o =>
      <button key={o.id} className={o.id === value ? 'on' : ''} onClick={() => onChange(o.id)}>{o.label}</button>)}</div>}
  </div>
}
