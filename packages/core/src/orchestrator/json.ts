// Extracts a JSON object from a model's text response.
// Models often wrap JSON in prose or ```json fences; this recovers it robustly.

export function extractJson<T = unknown>(text: string): T | null {
  // 1. Try a fenced ```json ... ``` block first.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    const parsed = tryParse<T>(fenced[1])
    if (parsed !== null) return parsed
  }

  // 2. Try the whole string.
  const whole = tryParse<T>(text)
  if (whole !== null) return whole

  // 3. Fall back to the first balanced { ... } or [ ... ] span.
  const span = firstBalancedSpan(text)
  if (span) return tryParse<T>(span)

  return null
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s.trim()) as T
  } catch {
    return null
  }
}

function firstBalancedSpan(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']'
      let depth = 0
      let inString = false
      let escaped = false
      for (let j = i; j < text.length; j++) {
        const c = text[j]
        if (inString) {
          if (escaped) escaped = false
          else if (c === '\\') escaped = true
          else if (c === '"') inString = false
        } else {
          if (c === '"') inString = true
          else if (c === ch) depth++
          else if (c === close) {
            depth--
            if (depth === 0) return text.slice(i, j + 1)
          }
        }
      }
    }
  }
  return null
}
