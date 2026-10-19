import { createContext } from 'react'
export const Ws = createContext<(lang: string, code: string) => void>(() => {})
export const langOf = (p: string) => ({ js: 'javascript', ts: 'typescript', py: 'python', md: 'markdown', yml: 'yaml', sh: 'bash' } as Record<string, string>)[p.split('.').pop() || ''] || p.split('.').pop() || 'text'
export function buildPreview(f: Record<string, string>) {
  const h = f['index.html'] ?? Object.entries(f).find(([k]) => k.endsWith('.html'))?.[1]
  if (!h) { const s = Object.entries(f).find(([k]) => k.endsWith('.svg'))?.[1]; return s ? `<body style="margin:0;display:grid;place-items:center;height:100vh;background:#161412">${s}` : '' }
  return h.replace(/<link[^>]+href=["']\.?\/?([^"']+\.css)["'][^>]*>/g, (m, p) => f[p] !== undefined ? `<style>${f[p]}</style>` : m)
    .replace(/<script([^>]*?)src=["']\.?\/?([^"']+\.js)["']([^>]*)><\/script>/g, (m, a, p, b) => f[p] !== undefined ? `<script${a}${b}>${f[p].replace(/<\/script/gi, '<\\/script')}</script>` : m)
}
