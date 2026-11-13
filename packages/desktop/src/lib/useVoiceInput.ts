// Voice input via the browser SpeechRecognition API (Chrome/Edge; Safari
// exposes it as webkitSpeechRecognition). The hook never throws: on a
// browser without the API, `supported` is false and `start()` is a no-op
// that reports the unsupported error. Interim results are shown in
// `transcript` as they arrive; each final result is appended to the
// transcript AND delivered to `onFinal` — the caller (the Composer) decides
// what to do with it. Nothing here sends audio or text anywhere.

import { useCallback, useEffect, useRef, useState } from 'react'

export const VOICE_UNSUPPORTED_ERROR = 'Voice input is not supported in this browser'

interface SpeechRecognitionResultItem {
  transcript: string
  isFinal: boolean
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number
  item(index: number): SpeechRecognitionResultItem
  [index: number]: SpeechRecognitionResultItem
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort?(): void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export interface UseVoiceInputOptions {
  /** Language tag, e.g. 'en-US'. Defaults to the browser language. */
  lang?: string
  /** Keep listening after a final result (default true). */
  continuous?: boolean
  /** Called once per final result with that result's text. */
  onFinal?: (text: string) => void
}

export interface UseVoiceInputResult {
  supported: boolean
  listening: boolean
  /** Final text so far, plus the current interim result while speaking. */
  transcript: string
  error: string | null
  start: () => void
  stop: () => void
}

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputResult {
  const { lang, continuous = true, onFinal } = options
  const [supported] = useState(() => recognitionConstructor() !== null)
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const finalRef = useRef('')
  const interimRef = useRef('')
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal

  const stop = useCallback(() => {
    try {
      recognitionRef.current?.stop()
    } catch {
      // Stopping a dead recognition must not throw into the caller.
    }
    recognitionRef.current = null
    setListening(false)
  }, [])

  // Stop the recognition when the component unmounts.
  useEffect(() => stop, [stop])

  const start = useCallback(() => {
    if (recognitionRef.current !== null) return
    const Ctor = recognitionConstructor()
    if (Ctor === null) {
      setError(VOICE_UNSUPPORTED_ERROR)
      return
    }
    let recognition: SpeechRecognitionLike
    try {
      recognition = new Ctor()
    } catch {
      setError(VOICE_UNSUPPORTED_ERROR)
      return
    }
    recognition.lang = lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US')
    recognition.continuous = continuous
    recognition.interimResults = true
    recognition.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]!
        const text = Array.from({ length: result.length }, (_, j) => result.item(j).transcript).join('')
        if (result.isFinal) {
          const finalText = text.trim()
          if (finalText !== '') {
            finalRef.current = finalRef.current === '' ? finalText : `${finalRef.current} ${finalText}`
            onFinalRef.current?.(finalText)
          }
        } else {
          interim += text
        }
      }
      interimRef.current = interim
      setTranscript(interim === '' ? finalRef.current : finalRef.current === '' ? interim : `${finalRef.current} ${interim}`)
    }
    recognition.onerror = (event) => {
      setError(event.error !== undefined && event.error !== '' ? `Voice input failed: ${event.error}` : 'Voice input failed.')
      setListening(false)
    }
    recognition.onend = () => {
      recognitionRef.current = null
      setListening(false)
    }
    recognitionRef.current = recognition
    setError(null)
    try {
      recognition.start()
      setListening(true)
    } catch {
      recognitionRef.current = null
      setError('Voice input could not start.')
      setListening(false)
    }
  }, [continuous, lang])

  return { supported, listening, transcript, error, start, stop }
}

export default useVoiceInput
