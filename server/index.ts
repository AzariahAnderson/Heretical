import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { streamSSE } from 'hono/streaming'

type P = { base: string; keys: string[]; models: string[] }
const k = (...n: string[]) => n.map(x => process.env[x]).filter(Boolean) as string[]
const PROVIDERS: Record<string, P> = {
  groq: { base: 'https://api.groq.com/openai/v1', keys: k('GROQ_API_KEY', 'GROQ_API_KEY_FALLBACK'), models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'] },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', keys: k('GEMINI_API_KEY'), models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  openrouter: { base: 'https://openrouter.ai/api/v1', keys: k('OPENROUTER_API_KEY'), models: ['meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat-v3.1:free'] },
  venice: { base: 'https://api.venice.ai/api/v1', keys: k('VENICE_API_KEY', 'VENICE_API_KEY_FALLBACK'), models: ['venice-uncensored', 'llama-3.3-70b'] },
  pollinations: { base: 'https://text.pollinations.ai/openai', keys: k('POLLINATIONS_API_KEY', 'POLLINATIONS_API_KEY_FALLBACK'), models: ['openai', 'mistral'] },
  huggingface: { base: 'https://router.huggingface.co/v1', keys: k('HF_TOKEN'), models: ['meta-llama/Llama-3.3-70B-Instruct'] },
  mistral: { base: 'https://api.mistral.ai/v1', keys: k('MISTRAL_API_KEY'), models: ['mistral-large-latest'] },
  cerebras: { base: 'https://api.cerebras.ai/v1', keys: k('CEREBRAS_API_KEY'), models: ['llama-3.3-70b'] },
}
const MAXTOK = Number(process.env.MAX_OUTPUT_TOKENS) || 1024
const TURNS = Number(process.env.HISTORY_TURNS) || 12
const LIMIT = Number(process.env.LOCAL_RATE_LIMIT) || 8
const SYS = (process.env.SYSTEM_PROMPT || `You are HERETICAL, a highly capable assistant that is especially strong at software engineering. Be direct, accurate and warm; skip filler, flattery and needless caveats. Lead with the answer, then the reasoning. Break hard problems into steps and check your work. If you are unsure, say so instead of guessing. For code: give complete, runnable code in fenced blocks tagged with the language, name files when there are several, use modern idioms, handle errors, and explain only the non-obvious choices. For web demos, put everything in one self-contained html block so it can be previewed. Use headings only in long answers. Use emoji sparingly, only where natural.`)

const hits = new Map<string, number[]>()
const app = new Hono()

app.get('/api/models', c => c.json(Object.entries(PROVIDERS).filter(([, p]) => p.keys.length)
  .flatMap(([id, p]) => p.models.map(m => ({ id: `${id}:${m}`, provider: id, name: m.split('/').pop() })))))

app.post('/api/chat', async c => {
  const ip = c.req.header('x-forwarded-for') || 'local', now = Date.now()
  const h = (hits.get(ip) || []).filter(t => now - t < 60000)
  if (h.length >= LIMIT) return c.json({ error: 'Slow down — rate limit reached.' }, 429)
  hits.set(ip, [...h, now])
  const { model, messages, persona } = await c.req.json<{ model: string; messages: { role: string; content: string }[]; persona?: string }>()
  const [pid, ...rest] = String(model).split(':'); const p = PROVIDERS[pid]
  if (!p?.keys.length) return c.json({ error: 'Model unavailable.' }, 400)
  const mk = (m: string) => JSON.stringify({ model: m, stream: true, max_tokens: Math.max(MAXTOK, 2048),
    messages: [{ role: 'system', content: SYS + (persona ? `\nUser persona/instructions: ${String(persona).slice(0, 1500)}` : '') }, ...messages.slice(-TURNS * 2)] })
  return streamSSE(c, async s => {
    let res: Response | undefined, err = ''
    const cands = [[pid, rest.join(':')], ...Object.entries(PROVIDERS).filter(([id, q]) => id !== pid && q.keys.length).map(([id, q]) => [id, q.models[0]])].slice(0, 3)
    outer: for (const [cid, cm] of cands) for (const key of PROVIDERS[cid].keys) {
      res = await fetch(`${PROVIDERS[cid].base}/chat/completions`, { method: 'POST', body: mk(cm), headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } }).catch(() => undefined)
      if (res?.ok) break outer
      err = res ? `${res.status} ${(await res.text()).slice(0, 200)}` : 'network error'
    }
    if (!res?.ok || !res.body) return void (await s.writeSSE({ data: JSON.stringify({ e: err || 'failed' }) }))
    const rd = res.body.getReader(), dec = new TextDecoder(); let buf = ''
    for (;;) {
      const { done, value } = await rd.read(); if (done) break
      buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop()!
      for (const l of lines) {
        if (!l.startsWith('data:')) continue; const d = l.slice(5).trim(); if (!d || d === '[DONE]') continue
        try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) await s.writeSSE({ data: JSON.stringify({ t }) }) } catch {}
      }
    }
    await s.writeSSE({ data: JSON.stringify({ done: true }) })
  })
})

app.post('/api/title', async c => {
  const { model, text } = await c.req.json<{ model: string; text: string }>()
  const [pid, ...rest] = String(model).split(':'); const p = PROVIDERS[pid]
  for (const key of p?.keys || []) {
    const r = await fetch(`${p.base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: rest.join(':'), max_tokens: 24, messages: [{ role: 'system', content: 'Write a 2-5 word title for this conversation. Reply with the title only: no quotes, no trailing punctuation.' }, { role: 'user', content: String(text).slice(0, 800) }] }) }).catch(() => undefined)
    const t = r?.ok ? ((await r.json()) as any).choices?.[0]?.message?.content : ''
    if (t) return c.json({ title: String(t).replace(/["\n]/g, '').trim().slice(0, 50) })
  }
  return c.json({ title: null })
})
const fn = (name: string, description: string, props: string[]) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties: Object.fromEntries(props.map(k => [k, { type: 'string' }])), required: props } } })
const TOOLS = [fn('write_file', 'Create or overwrite a file with its complete contents', ['path', 'content']), fn('read_file', 'Read a file', ['path']), fn('list_files', 'List all files', []), fn('delete_file', 'Delete a file', ['path'])]
const AGENT = `You are HERETICAL Agent, an autonomous coding agent in a browser workspace with a live preview.
Build complete, polished, working projects with vanilla HTML/CSS/JS (no build step; libraries only from https://cdnjs.cloudflare.com). The entry point is index.html, linking style.css and script.js. Plan in one or two sentences, then call write_file for every file with its full contents, never placeholders. To change a file, read_file first, then write_file the full new version. Handle edge cases and make the design modern and responsive. When finished, reply with a short summary and no tool call.`
app.post('/api/agent', async c => {
  const ip = c.req.header('x-forwarded-for') || 'local', now = Date.now(); const h = (hits.get(ip) || []).filter(t => now - t < 60000)
  if (h.length >= LIMIT) return c.json({ error: 'Slow down — rate limit reached.' }, 429); hits.set(ip, [...h, now])
  const { model, messages, files, persona } = await c.req.json<{ model: string; messages: any[]; files: Record<string, string>; persona?: string }>()
  const [pid, ...rest] = String(model).split(':'); const p = PROVIDERS[pid]
  if (!p?.keys.length) return c.json({ error: 'Model unavailable.' }, 400)
  const fs: Record<string, string> = { ...files }
  return streamSSE(c, async s => {
    const send = (o: object) => s.writeSSE({ data: JSON.stringify(o) })
    const msgs: any[] = [{ role: 'system', content: `${AGENT}${persona ? `\nUser persona: ${String(persona).slice(0, 800)}` : ''}\nFiles now: ${Object.keys(fs).join(', ') || '(none)'}` }, ...messages.slice(-TURNS * 2)]
    for (let i = 0; i < 10; i++) {
      let j: any, err = ''
      for (const key of p.keys) {
        const r = await fetch(`${p.base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: rest.join(':'), messages: msgs, tools: TOOLS, tool_choice: 'auto', max_tokens: Math.max(MAXTOK, 4096) }) }).catch(() => undefined)
        if (r?.ok) { j = await r.json(); break }
        err = r ? `${r.status} ${(await r.text()).slice(0, 200)}` : 'network error'
      }
      const m = j?.choices?.[0]?.message
      if (!m) return void (await send({ e: err || 'Empty response' }))
      msgs.push({ role: 'assistant', content: m.content || null, tool_calls: m.tool_calls })
      if (m.content) await send({ t: m.content + '\n\n' })
      if (!m.tool_calls?.length) break
      for (const tc of m.tool_calls) {
        let a: any = {}; try { a = JSON.parse(tc.function.arguments || '{}') } catch {}
        const path = String(a.path || '').replace(/^\/+/, ''); let out = 'ok'
        if (tc.function.name === 'write_file' && path) { fs[path] = String(a.content ?? ''); await send({ ev: 'file', path, content: fs[path] }) }
        else if (tc.function.name === 'read_file') { out = fs[path] ?? 'File not found'; await send({ ev: 'step', label: 'read ' + path }) }
        else if (tc.function.name === 'list_files') { out = Object.keys(fs).join('\n') || '(empty)'; await send({ ev: 'step', label: 'list files' }) }
        else if (tc.function.name === 'delete_file') { delete fs[path]; await send({ ev: 'del', path }) }
        else out = 'Invalid call'
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: out })
      }
    }
    await send({ done: true })
  })
})

const tryKeys = async (keys: string[], f: (key: string) => Promise<string | undefined>) => {
  for (const key of keys) { try { const r = await f(key); if (r) return r } catch {} } }
const dataUrl = async (r: Response) => `data:${r.headers.get('content-type')?.split(';')[0] || 'image/jpeg'};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`
const IMG: Record<string, (p: string, w: number, h: number) => Promise<string | undefined>> = {
  pollinations: (p, w, h) => tryKeys(PROVIDERS.pollinations.keys, async key => {
    const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?model=flux&width=${w}&height=${h}&nologo=true&seed=${Math.floor(Math.random() * 1e9)}`, { headers: { authorization: `Bearer ${key}` } })
    return r.ok && r.headers.get('content-type')?.startsWith('image') ? dataUrl(r) : undefined }),
  venice: (p, w, h) => tryKeys(PROVIDERS.venice.keys, async key => {
    const r = await fetch('https://api.venice.ai/api/v1/image/generate', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'flux-dev', prompt: p, width: Math.min(w, 1280), height: Math.min(h, 1280), format: 'webp', safe_mode: false }) })
    const j: any = r.ok ? await r.json() : null; return j?.images?.[0] ? `data:image/webp;base64,${j.images[0]}` : undefined }),
  huggingface: (p) => tryKeys(PROVIDERS.huggingface.keys, async key => {
    const r = await fetch('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ inputs: p }) })
    return r.ok ? dataUrl(r) : undefined }),
}
app.get('/api/image-engines', c => c.json(Object.keys(IMG).filter(k => PROVIDERS[k].keys.length)))
app.post('/api/image', async c => {
  const { prompt, engine, ratio } = await c.req.json<{ prompt: string; engine?: string; ratio?: string }>()
  const [w, h] = ratio === 'wide' ? [1344, 768] : ratio === 'tall' ? [768, 1344] : [1024, 1024]
  const order = [engine, ...Object.keys(IMG)].filter((x, i, a): x is string => !!x && !!IMG[x] && PROVIDERS[x].keys.length > 0 && a.indexOf(x) === i)
  for (const e of order) { const image = await IMG[e](String(prompt).slice(0, 1500), w, h).catch(() => undefined); if (image) return c.json({ image, engine: e }) }
  return c.json({ error: 'Every image engine failed. Try a different prompt.' }, 502)
})

if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist' }))
  app.get('*', serveStatic({ path: './dist/index.html' }))
}
serve({ fetch: app.fetch, port: Number(process.env.PORT) || 8787 }, i => console.log(`HERETICAL on :${i.port}`))
