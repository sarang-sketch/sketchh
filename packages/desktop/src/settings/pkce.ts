// "Sign in with OpenRouter" — the surface's half of an OAuth PKCE sign-in.
//
// OpenRouter publishes this flow for exactly this kind of app
// (https://openrouter.ai/docs/guides/overview/auth/oauth): send the user to
// `openrouter.ai/auth` with a loopback `callback_url` and an S256 code challenge; the
// browser comes back with a one-time `code`; POST the code and the verifier to
// `/api/v1/auth/keys` and receive a key the user owns and can revoke.
//
// THE VERIFIER NEVER LEAVES THIS WINDOW. The engine's loopback listener only ever
// sees the code, which is worthless without the verifier. The key that comes back is
// handed straight to the OS credential store by the caller.

const OPENROUTER_AUTH = 'https://openrouter.ai/auth'
const OPENROUTER_EXCHANGE = 'https://openrouter.ai/api/v1/auth/keys'

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh PKCE verifier: 32 random bytes, base64url (43 characters). */
export function randomVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/** The S256 challenge for a verifier. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export function openRouterAuthUrl(callbackUrl: string, challenge: string): string {
  const params = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    key_label: 'Sketch IDE',
  })
  return `${OPENROUTER_AUTH}?${params.toString()}`
}

/**
 * Exchange the one-time code for the user's key. Throws with a sentence a person can
 * act on; never with the key, the code, or the verifier in it.
 */
export async function exchangeOpenRouterCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(OPENROUTER_EXCHANGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    })
  } catch {
    throw new Error('Could not reach openrouter.ai to finish signing in. Check your connection and try again.')
  }
  if (res.status === 403) throw new Error('OpenRouter refused the sign-in code. It may have expired — start again.')
  if (!res.ok) throw new Error(`OpenRouter could not finish the sign-in (HTTP ${res.status}). Try again.`)
  const body = (await res.json().catch(() => null)) as { key?: unknown } | null
  if (body === null || typeof body.key !== 'string' || body.key.trim() === '') {
    throw new Error('OpenRouter answered without a key. Try again.')
  }
  return body.key.trim()
}
