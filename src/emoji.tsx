import { useState, type ReactNode } from 'react'
const RE = /(\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic}|\ufe0f)*)/gu
const url = (e: string) => `https://fonts.gstatic.com/s/e/notoemoji/latest/${[...e].map(c => c.codePointAt(0)!.toString(16)).filter(c => c !== 'fe0f').join('_')}/512.webp`
function Em({ e }: { e: string }) {
  const [bad, setBad] = useState(false)
  return bad ? <>{e}</> : <img className="emoji" src={url(e)} alt={e} onError={() => setBad(true)} />
}
export const withEmoji = (n: ReactNode): ReactNode =>
  typeof n === 'string' ? n.split(RE).map((p, i) => i % 2 ? <Em key={i} e={p} /> : p)
  : Array.isArray(n) ? n.map((x, i) => <span key={i} style={{ display: 'contents' }}>{withEmoji(x)}</span>) : n
