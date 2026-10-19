import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Code from './Code'
import { withEmoji } from '../emoji'
const w = (T: string) => ({ children }: any) => { const C = T as any; return <C>{withEmoji(children)}</C> }
export default function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    p: w('p'), li: w('li'), h1: w('h1'), h2: w('h2'), h3: w('h3'), strong: w('strong'), em: w('em'), td: w('td'),
    pre: ({ children }: any) => <>{children}</>,
    code: ({ className, children }: any) => {
      const m = /language-(\w+)/.exec(className || ''), s = String(children)
      return m || s.includes('\n') ? <Code lang={m?.[1] || ''} code={s.replace(/\n$/, '')} /> : <code className="inline">{children}</code>
    },
  }}>{text}</ReactMarkdown>
}
