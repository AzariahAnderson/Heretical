import { useEffect, useRef, type ReactNode } from 'react'
import gsap from 'gsap'
export default function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const r = useRef<HTMLDivElement>(null)
  useEffect(() => { gsap.from(r.current, { y: 20, opacity: 0, duration: .35, ease: 'power3.out' }) }, [])
  useEffect(() => { const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', f); return () => removeEventListener('keydown', f) }, [])
  return <div className="scrim" onClick={onClose}><div className="modal" ref={r} onClick={e => e.stopPropagation()}>
    <div className="mh"><h2>{title}</h2><button className="x" onClick={onClose}>×</button></div>{children}</div></div>
}
