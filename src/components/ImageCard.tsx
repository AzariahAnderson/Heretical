import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { getImg } from '../db'
export default function ImageCard({ id, prompt }: { id?: string; prompt?: string }) {
  const [src, setSrc] = useState<string>(); const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (id) getImg(id).then(setSrc) }, [id])
  useEffect(() => { if (!src && ref.current) { const t = gsap.to(ref.current, { opacity: .45, repeat: -1, yoyo: true, duration: .9, ease: 'sine.inOut' }); return () => { t.kill() } } }, [src])
  useEffect(() => { if (src && ref.current) gsap.fromTo(ref.current, { opacity: 0, scale: .96, filter: 'blur(14px)' }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: .8, ease: 'power3.out' }) }, [src])
  return <div className="imgcard" ref={ref}>
    {src ? <><img src={src} alt={prompt} />
      <a className="pill dl" href={src} download={`heretical-${id}.png`}>Download</a></> : <div className="imgskel">Conjuring image…</div>}
  </div>
}
