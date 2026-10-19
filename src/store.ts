import { create } from 'zustand'
import { persist } from 'zustand/middleware'
export type Msg = { role: 'user' | 'assistant'; content: string; img?: string; prompt?: string; steps?: string[] }
export type Chat = { id: string; title: string; messages: Msg[]; pinned?: boolean; files?: Record<string, string> }
type S = { chats: Chat[]; active: string | null; model: string; persona: string; engine: string
  set: (p: Partial<S>) => void; upsert: (c: Chat) => void; remove: (id: string) => void }
export const useStore = create<S>()(persist((set) => ({
  chats: [], active: null, model: '', persona: '', engine: '',
  set: p => set(p),
  upsert: c => set(s => ({ chats: s.chats.some(x => x.id === c.id) ? s.chats.map(x => x.id === c.id ? c : x) : [c, ...s.chats] })),
  remove: id => set(s => ({ chats: s.chats.filter(c => c.id !== id), active: s.active === id ? null : s.active })),
}), { name: 'heretical' }))
