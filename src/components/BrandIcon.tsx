import {
  siGoogle,
  siAnthropic,
  siHuggingface,
  siOpenrouter
} from 'simple-icons'

type Props = {
  label?: string
  provider?: string
  size?: number
}

const icons = {
  google: siGoogle,
  anthropic: siAnthropic,
  huggingface: siHuggingface,
  openrouter: siOpenrouter
}

function providerFrom(value: string) {
  const name = value.toLowerCase().replace(/[\s_-]/g, '')

  if (name.includes('openrouter')) return 'openrouter'
  if (name.includes('huggingface')) return 'huggingface'
  if (name.includes('anthropic') || name.includes('claude')) return 'anthropic'
  if (name.includes('google') || name.includes('gemini')) return 'google'

  return ''
}

function Fallback({
  label,
  size
}: {
  label: string
  size: number
}) {
  const initials =
    label
      .trim()
      .split(/\s+/)
      .map(word => word[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'AI'

  return (
    <span
      className="brand-provider-icon brand-provider-fallback"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {initials}
    </span>
  )
}

export default function BrandIcon({
  label = '',
  provider,
  size = 16
}: Props) {
  const key = provider || providerFrom(label)
  const icon = icons[key as keyof typeof icons]

  if (!icon) {
    return <Fallback label={label || 'AI'} size={size} />
  }

  return (
    <svg
      className="brand-provider-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={icon.path} fill="currentColor" />
    </svg>
  )
}