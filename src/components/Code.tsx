import { useContext, useEffect, useState } from 'react'
import { codeToHtml } from 'shiki'
import { Ws } from '../ws'
const THEME = 'tokyo-night'
export function Hl({ lang, code }: { lang: string; code: string }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      const h = await codeToHtml(code, { lang: lang || 'text', theme: THEME }).catch(() => codeToHtml(code, { lang: 'text', theme: THEME }))
      if (live) setHtml(h)
    }, 100)
    return () => { live = false; clearTimeout(t) }
  }, [code, lang])
  return html ? <div className="hl" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="hl"><code>{code}</code></pre>
}
export default function Code({ lang, code }: { lang: string; code: string }) {
  const [ok, setOk] = useState(false); const open = useContext(Ws)
  return <div className="code">
    <div className="code-bar"><span>{lang || 'text'}</span><span className="grow" />
      <button onClick={() => open(lang, code)}>{/^(html|svg)$/.test(lang) ? 'Preview' : 'Open'}</button>
      <button onClick={() => { navigator.clipboard.writeText(code); setOk(true); setTimeout(() => setOk(false), 1200) }}>{ok ? 'Copied' : 'Copy'}</button></div>
    <Hl lang={lang} code={code} />
  </div>
}
