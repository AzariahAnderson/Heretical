import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { streamSSE } from 'hono/streaming'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type Provider = { base: string; envKeys: string[]; safeModels: string[]; gate?: string; kind: 'openai' | 'gemini' | 'openrouter' }
type CatalogModel = { id: string; provider: string; name: string }
type Json = Record<string, any>

const FREE_ONLY = String(process.env.FREE_ONLY ?? 'true').toLowerCase() !== 'false'
const MAXTOK = Math.max(256, Math.min(Number(process.env.MAX_OUTPUT_TOKENS) || 768, 4096))
const TURNS = Math.max(1, Math.min(Number(process.env.HISTORY_TURNS) || 12, 30))
const LIMIT = Math.max(1, Math.min(Number(process.env.LOCAL_RATE_LIMIT) || 8, 60))
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT?.trim() || `You are HERETICAL, a highly capable assistant especially strong at software engineering. Be direct, accurate and warm; skip filler and needless caveats. Lead with the answer, then explain. Never invent facts or claim to have run code that you did not run. For code, provide complete, runnable examples and handle errors.`

// No paid-only providers are registered. Provider access requires a fresh key and a local free-tier confirmation.
const PROVIDERS: Record<string, Provider> = {
  groq: {
    base: 'https://api.groq.com/openai/v1', envKeys: ['GROQ_API_KEY', 'GROQ_API_KEY_FALLBACK'],
    safeModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    gate: 'GROQ_FREE_PLAN_CONFIRMED', kind: 'openai'
  },
  gemini: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai', envKeys: ['GEMINI_API_KEY', 'GEMINI_API_KEY_FALLBACK'],
    safeModels: ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    gate: 'GEMINI_FREE_TIER_CONFIRMED', kind: 'gemini'
  },
  openrouter: {
    base: 'https://openrouter.ai/api/v1', envKeys: ['OPENROUTER_API_KEY'],
    safeModels: ['openrouter/free'], kind: 'openrouter'
  },
  cerebras: {
    base: 'https://api.cerebras.ai/v1', envKeys: ['CEREBRAS_API_KEY'],
    safeModels: ['gpt-oss-120b', 'zai-glm-4.7'],
    gate: 'CEREBRAS_FREE_PLAN_CONFIRMED', kind: 'openai'
  },
  mistral: {
    base: 'https://api.mistral.ai/v1', envKeys: ['MISTRAL_API_KEY'],
    safeModels: ['mistral-small-latest'], gate: 'MISTRAL_FREE_MODE_CONFIRMED', kind: 'openai'
  }
}

const app = new Hono()
const hits = new Map<string, number[]>()
const modelCache = new Map<string, { at: number; models: string[] }>()
const CACHE_MS = 3 * 60 * 1000

function providerKeys(id: string): string[] {
  const p = PROVIDERS[id]
  if (!p || !FREE_ONLY) return []
  if (p.gate && String(process.env[p.gate] || '').toLowerCase() !== 'true') return []
  if (id === 'openrouter' && String(process.env.OPENROUTER_FREE_ONLY ?? 'true').toLowerCase() === 'false') return []
  return p.envKeys.map(name => process.env[name]?.trim()).filter((v): v is string => Boolean(v))
}
function enabledProviders(): string[] { return Object.keys(PROVIDERS).filter(id => providerKeys(id).length > 0) }
function normalizedModelId(v: unknown): string { return String(v || '').replace(/^models\//, '').trim() }
function priceIsZero(v: unknown): boolean { return v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) === 0 }
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 4500): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try { return await fetch(url, { ...init, signal: controller.signal }) }
  finally { clearTimeout(timer) }
}
function authHeaders(key: string): Record<string, string> { return { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }

async function discoverModels(id: string, force = false): Promise<string[]> {
  const cached = modelCache.get(id)
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.models
  const p = PROVIDERS[id]
  const keys = providerKeys(id)
  if (!p || !keys.length) return []
  let models: string[] = []
  let querySucceeded = false
  for (const key of keys) {
    try {
      if (id === 'openrouter') {
        const res = await fetchWithTimeout(`${p.base}/models`, { headers: { authorization: `Bearer ${key}` } })
        if (!res.ok) continue
        querySucceeded = true
        const data = ((await res.json()) as Json).data || []
        const free = data.filter((m: Json) => typeof m.id === 'string' && m.id.endsWith(':free') &&
          priceIsZero(m.pricing?.prompt) && priceIsZero(m.pricing?.completion))
          .map((m: Json) => String(m.id)).slice(0, 24)
        models = ['openrouter/free', ...free.filter((m: string) => m !== 'openrouter/free')]
        break
      }
      if (id === 'gemini') {
        const res = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': key } })
        if (!res.ok) continue
        querySucceeded = true
        const payload = await res.json() as Json
        const online = (payload.models || []).filter((m: Json) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m: Json) => normalizedModelId(m.name))
        models = p.safeModels.filter(m => online.includes(m))
        break
      }
      const res = await fetchWithTimeout(`${p.base}/models`, { headers: { authorization: `Bearer ${key}` } })
      if (!res.ok) continue
      querySucceeded = true
      const payload = await res.json() as Json
      const online = (payload.data || []).map((m: Json) => normalizedModelId(m.id))
      models = p.safeModels.filter(m => online.includes(m))
      break
    } catch {
      // Try the next configured key before returning the curated free-only catalogue.
    }
  }
  if (models.length === 0 && !querySucceeded) {
    // Network outages should not hide known free candidates; every request still passes provider/model allowlists.
    models = id === 'openrouter' ? ['openrouter/free'] : [...p.safeModels]
  }
  modelCache.set(id, { at: Date.now(), models })
  return models
}
function providerAndModel(raw: unknown): { providerId: string; modelId: string } | undefined {
  const value = String(raw || '')
  const sep = value.indexOf(':')
  if (sep <= 0 || sep === value.length - 1) return undefined
  const providerId = value.slice(0, sep)
  const modelId = value.slice(sep + 1)
  const p = PROVIDERS[providerId]
  if (!p || !providerKeys(providerId).length) return undefined
  if (providerId === 'openrouter') {
    if (modelId !== 'openrouter/free' && !modelId.endsWith(':free')) return undefined
  } else if (!p.safeModels.includes(modelId)) return undefined
  return { providerId, modelId }
}
function rateLimited(c: any): boolean {
  const ip = (c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'local').split(',')[0].trim().slice(0, 100)
  const now = Date.now()
  const recent = (hits.get(ip) || []).filter(t => now - t < 60_000)
  if (recent.length >= LIMIT) { hits.set(ip, recent); return true }
  recent.push(now); hits.set(ip, recent)
  return false
}
function requestMessages(input: unknown, persona?: unknown): ChatMessage[] {
  const arr = Array.isArray(input) ? input : []
  const clean: ChatMessage[] = arr.slice(-TURNS * 2).filter((m: any) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m: any) => ({ role: m.role, content: String(m.content ?? '').slice(0, 24000) }))
    .filter(m => m.content.trim().length > 0)
  const personaText = String(persona || '').trim().slice(0, 1500)
  return [{ role: 'system', content: `${SYSTEM_PROMPT}${personaText ? `\nUser preferences: ${personaText}` : ''}` }, ...clean]
}
function safeErr(text: string, status: number): string {
  let message = text
  try {
    const j = JSON.parse(text)
    message = typeof j.error === 'string' ? j.error : (j.error?.message || j.message || text)
  } catch { /* keep text */ }
  message = String(message || `HTTP ${status}`).replace(/[\r\n\t]+/g, ' ').slice(0, 260)
  return `HTTP ${status}: ${message}`
}
async function makeCompletion(id: string, model: string, messages: any[], opts: Json = {}, signal?: AbortSignal): Promise<{ response?: Response; error?: string }> {
  const p = PROVIDERS[id]
  let error = 'Provider request failed'
  for (const key of providerKeys(id)) {
    try {
      // Keep the timeout/caller abort signal attached to the response body so Stop really cancels streaming.
      const timeoutSignal = AbortSignal.timeout(90_000)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      const res = await fetch(`${p.base}/chat/completions`, {
        method: 'POST', headers: authHeaders(key),
        body: JSON.stringify({ model, messages, max_tokens: MAXTOK, ...opts }),
        signal: requestSignal
      })
      if (res.ok) return { response: res }
      error = safeErr(await res.text().catch(() => ''), res.status)
    } catch (e: any) {
      error = e?.name === 'AbortError' ? 'The provider request timed out or was cancelled.' : 'Network connection to the provider failed.'
      if (signal?.aborted) break
    }
  }
  return { error }
}

async function streamCompletion(res: Response, send: (data: Json) => Promise<void>, signal: AbortSignal): Promise<void> {
  if (!res.body) throw new Error('The provider returned an empty response stream.')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  async function processEvent(event: string): Promise<boolean> {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    if (!data) return false
    if (data === '[DONE]') return true
    try {
      const payload = JSON.parse(data) as Json
      const delta = payload.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) await send({ t: delta })
      else if (Array.isArray(delta)) {
        const text = delta.map((part: Json) => typeof part?.text === 'string' ? part.text : '').join('')
        if (text) await send({ t: text })
      }
      if (payload.error) await send({ e: String(payload.error.message || payload.error).slice(0, 240) })
    } catch { /* Some providers send keep-alive or non-JSON events; ignore them. */ }
    return false
  }
  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() || ''
    for (const event of events) if (await processEvent(event)) { await reader.cancel().catch(() => {}); return }
  }
  if (!signal.aborted && buffer.trim()) await processEvent(buffer)
  try { await reader.cancel() } catch { /* stream already closed */ }
}

app.get('/api/health', c => c.json({
  ok: true,
  freeOnly: FREE_ONLY,
  paidProvidersDisabled: true,
  port: Number(process.env.PORT) || 8787,
  providers: enabledProviders().map(id => ({ id, name: id === 'openrouter' ? 'OpenRouter Free' : id, configured: true }))
}))

app.get('/api/providers', c => c.json({ freeOnly: FREE_ONLY, providers: enabledProviders() }))
app.get('/api/models', async c => {
  const ids = enabledProviders()
  const grouped = await Promise.all(ids.map(async id => {
    const names = await discoverModels(id)
    return names.map(model => ({
      id: `${id}:${model}`, provider: id,
      name: model === 'openrouter/free' ? 'Auto · Free models' : model.split('/').pop()?.replace(/:free$/, '') || model
    } as CatalogModel))
  }))
  return c.json(grouped.flat())
})

app.post('/api/chat', async c => {
  if (rateLimited(c)) return c.json({ error: 'Local rate limit reached. Please wait a minute before trying again.' }, 429)
  let body: Json
  try { body = await c.req.json() as Json } catch { return c.json({ error: 'Request body must be valid JSON.' }, 400) }
  const selected = providerAndModel(body.model)
  if (!selected) return c.json({ error: 'That model is unavailable in free-only mode. Refresh the model list and choose an enabled free-tier model.' }, 400)
  if (!Array.isArray(body.messages) || body.messages.length === 0) return c.json({ error: 'Add a message before sending.' }, 400)
  const messages = requestMessages(body.messages, body.persona)
  return streamSSE(c, async stream => {
    const controller = new AbortController()
    stream.onAbort(() => controller.abort())
    const send = async (data: Json) => { if (!controller.signal.aborted) await stream.writeSSE({ data: JSON.stringify(data) }) }
    const candidateList: Array<{ id: string; model: string }> = [{ id: selected.providerId, model: selected.modelId }]
    for (const alternative of await discoverModels(selected.providerId)) {
      if (alternative !== selected.modelId) candidateList.push({ id: selected.providerId, model: alternative })
    }
    for (const id of enabledProviders()) {
      if (id === selected.providerId) continue
      const alternatives = await discoverModels(id)
      if (alternatives[0]) candidateList.push({ id, model: alternatives[0] })
    }
    let finalError = 'No free-tier provider could complete this request.'
    for (const candidate of candidateList) {
      if (controller.signal.aborted) return
      const result = await makeCompletion(candidate.id, candidate.model, messages, { stream: true }, controller.signal)
      if (!result.response) { finalError = result.error || finalError; continue }
      try {
        await streamCompletion(result.response, send, controller.signal)
        await send({ done: true, provider: candidate.id, model: candidate.model })
        return
      } catch (e: any) {
        if (controller.signal.aborted) return
        finalError = String(e?.message || 'The provider stream ended unexpectedly.').slice(0, 240)
      }
    }
    await send({ e: `${finalError} Check the free-tier account quota, model availability, and server terminal for errors.` })
    await send({ done: true })
  })
})

app.post('/api/title', async c => {
  let body: Json
  try { body = await c.req.json() as Json } catch { return c.json({ title: null }, 400) }
  const selected = providerAndModel(body.model)
  if (!selected) return c.json({ title: null })
  const messages = [
    { role: 'system', content: 'Write a 2–5 word title for the conversation. Output the title only, no quotation marks.' },
    { role: 'user', content: String(body.text || '').slice(0, 900) }
  ]
  const result = await makeCompletion(selected.providerId, selected.modelId, messages, { stream: false, max_tokens: 24 })
  if (!result.response) return c.json({ title: null })
  const json = await result.response.json().catch(() => ({})) as Json
  const title = String(json.choices?.[0]?.message?.content || '').replace(/["\r\n]/g, '').trim().slice(0, 50)
  return c.json({ title: title || null })
})

const fn = (name: string, description: string, props: string[]) => ({
  type: 'function', function: { name, description, parameters: {
    type: 'object', properties: Object.fromEntries(props.map(k => [k, { type: 'string' }])), required: props
  } }
})
const TOOLS = [
  fn('write_file', 'Create or overwrite a workspace file with its complete contents', ['path', 'content']),
  fn('read_file', 'Read a workspace file', ['path']),
  fn('list_files', 'List workspace files', []),
  fn('delete_file', 'Delete a workspace file', ['path'])
]
const AGENT_PROMPT = `You are HERETICAL Agent, an AI coding assistant in a browser workspace. Build complete, polished, working projects. Use the workspace tools to create or edit files; never claim files were changed unless a tool call actually changed the in-memory workspace. Entry point is index.html unless the user asks otherwise. Prefer accessible responsive UI and maintainable vanilla HTML/CSS/JS. The workspace exists in the current chat and is not the user's physical disk.`
function safeWorkspacePath(value: unknown): string {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!raw || raw.split('/').some(part => part === '..' || part === '.') || raw.includes('\0') || raw.length > 180) return ''
  return raw
}

app.post('/api/agent', async c => {
  if (rateLimited(c)) return c.json({ error: 'Local rate limit reached. Please wait a minute before trying again.' }, 429)
  let body: Json
  try { body = await c.req.json() as Json } catch { return c.json({ error: 'Request body must be valid JSON.' }, 400) }
  const selected = providerAndModel(body.model)
  if (!selected) return c.json({ error: 'Choose an enabled free-tier model first.' }, 400)
  const files: Record<string, string> = body.files && typeof body.files === 'object' ? { ...body.files } : {}
  const incoming = requestMessages(body.messages, body.persona).slice(1)
  const messages: any[] = [{ role: 'system', content: `${AGENT_PROMPT}\nWorkspace files: ${Object.keys(files).join(', ') || '(none)'}` }, ...incoming]
  return streamSSE(c, async stream => {
    const controller = new AbortController()
    stream.onAbort(() => controller.abort())
    const send = async (o: Json) => { if (!controller.signal.aborted) await stream.writeSSE({ data: JSON.stringify(o) }) }
    for (let iteration = 0; iteration < 8 && !controller.signal.aborted; iteration++) {
      const result = await makeCompletion(selected.providerId, selected.modelId, messages, { stream: false, tools: TOOLS, tool_choice: 'auto' }, controller.signal)
      if (!result.response) { await send({ e: result.error || 'Agent request failed.' }); return }
      const payload = await result.response.json().catch(() => ({})) as Json
      const message = payload.choices?.[0]?.message
      if (!message) { await send({ e: 'The selected model returned no agent message. Try another free model.' }); return }
      messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls })
      if (message.content) await send({ t: `${message.content}\n\n` })
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) break
      for (const call of message.tool_calls) {
        if (controller.signal.aborted) return
        let args: Json = {}
        try { args = JSON.parse(call.function?.arguments || '{}') as Json } catch { /* malformed tool JSON gets a safe result */ }
        const path = safeWorkspacePath(args.path)
        let output = 'OK'
        if (call.function?.name === 'write_file' && path) {
          files[path] = String(args.content ?? '').slice(0, 400000)
          await send({ ev: 'file', path, content: files[path] })
          await send({ ev: 'step', label: `write ${path}` })
        } else if (call.function?.name === 'read_file' && path) {
          output = files[path] ?? 'File not found.'
          await send({ ev: 'step', label: `read ${path}` })
        } else if (call.function?.name === 'list_files') {
          output = Object.keys(files).join('\n') || '(empty workspace)'
          await send({ ev: 'step', label: 'list workspace files' })
        } else if (call.function?.name === 'delete_file' && path) {
          delete files[path]
          await send({ ev: 'del', path })
          await send({ ev: 'step', label: `delete ${path}` })
        } else output = 'Invalid or unsafe workspace operation.'
        messages.push({ role: 'tool', tool_call_id: call.id, content: output.slice(0, 400000) })
      }
    }
    await send({ done: true })
  })
})

// Strict free-only mode deliberately does not call Venice, Hugging Face pay-as-you-go inference,
// NSFWAI, or Pollinations Pollen APIs. Those may use paid credits; no image model is enabled here.
app.get('/api/image-engines', c => c.json([]))
app.post('/api/image', c => c.json({ error: 'Image generation is disabled in strict free-only mode because no configured image provider can be guaranteed to cost $0. Chat and streaming remain available.' }, 503))

if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist' }))
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

const port = Number(process.env.PORT) || 8787
const host = process.env.HOST || '127.0.0.1'
serve({ fetch: app.fetch, port, hostname: host }, () => console.log(`HERETICAL API listening at http://${host}:${port} (free-only mode)`))