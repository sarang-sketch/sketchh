// Sketch website behaviour. No framework, no build step.
//
// Everything here is progressive: without JavaScript the page reads complete, with
// every step of the example run shown as done and the ribbon showing its text at rest.
// With "reduce motion" on, nothing moves on its own.

(() => {
  'use strict'

  const config = Object.assign(
    { repo: 'sarang-sketch/sketch', downloadUrl: '', checkLatestRelease: true, launchEmailEndpoint: '' },
    window.SKETCH_SITE || {},
  )
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))
  const repoUrl = `https://github.com/${config.repo}`

  // ── links built from the configured repository ──────────────────────────────
  for (const link of $$('[data-repo]')) link.href = repoUrl
  for (const link of $$('[data-repo-path]')) link.href = `${repoUrl}/${link.dataset.repoPath}`

  // ── the Code | Cowork switch ────────────────────────────────────────────────
  const COPY = {
    code: {
      title1: "Don't code it all,",
      title2: 'just describe it.',
      sub: 'Sketch is a free, open-source AI code editor. Tell its agent what you want, and it plans the change, edits your files, runs your tests, and only calls it done when they pass.',
    },
    cowork: {
      title1: 'Hand off the task,',
      title2: 'review the result.',
      sub: "Cowork is Sketch's agent workspace. Give it a job, follow every step it takes on the timeline, and undo any run with one click.",
    },
  }

  let typingTimer = 0
  function typeInto(element, text) {
    window.clearTimeout(typingTimer)
    if (reduceMotion.matches || document.hidden) {
      element.textContent = text
      return
    }
    element.textContent = ''
    let shown = 0
    const step = () => {
      // A background tab slows timers to about one a second; finish at once instead.
      shown = document.hidden ? text.length : shown + 1
      element.textContent = text.slice(0, shown)
      if (shown < text.length) typingTimer = window.setTimeout(step, 38 + Math.random() * 40)
    }
    typingTimer = window.setTimeout(step, 260)
  }

  function setSurface(name) {
    const copy = COPY[name]
    if (copy === undefined) return
    for (const button of $$('.surface-btn')) button.setAttribute('aria-pressed', String(button.dataset.surface === name))
    const line1 = $('[data-copy="title1"]')
    const line2 = $('[data-copy="title2"]')
    const sub = $('[data-copy="sub"]')
    const sr = $('[data-copy="titleSr"]')
    if (line1) line1.textContent = copy.title1
    if (sub) sub.textContent = copy.sub
    if (sr) sr.textContent = `${copy.title1} ${copy.title2}`
    if (line2) typeInto(line2, copy.title2)
  }

  for (const button of $$('.surface-btn')) {
    button.addEventListener('click', () => setSurface(button.dataset.surface))
  }
  for (const link of $$('[data-surface-link]')) {
    link.addEventListener('click', () => setSurface(link.dataset.surfaceLink))
  }

  const firstLine2 = $('[data-copy="title2"]')
  if (firstLine2) typeInto(firstLine2, COPY.code.title2)

  // ── the hero ribbon: a request flows in, code flows out ─────────────────────
  const AGENT_STEPS = [
    { text: 'Reading 4 files', pass: false },
    { text: 'Plan written', pass: true },
    { text: 'Editing 2 files', pass: false },
    { text: 'Running npm test', pass: false },
    { text: '12 tests passed', pass: true },
    { text: 'Done. Undo is ready', pass: true },
  ]

  function sizeChip(chip, text) {
    const label = $('#chip-text', chip)
    const background = $('#chip-bg', chip)
    const icon = $('#chip-icon', chip)
    label.textContent = text
    const textWidth = label.getComputedTextLength()
    const width = 16 + 16 + 10 + textWidth + 20
    const left = -width / 2
    background.setAttribute('x', left.toFixed(1))
    background.setAttribute('width', width.toFixed(1))
    icon.setAttribute('transform', `translate(${(left + 16 + 8).toFixed(1)} 0)`)
    label.setAttribute('x', (left + 16 + 16 + 10).toFixed(1))
  }

  async function setupRibbon() {
    const ribbon = $('.ribbon')
    const chip = $('#chip')
    const toggle = $('#ribbon-toggle')
    if (ribbon === null || chip === null) return

    // On a phone only the middle of the ribbon fits, so frame the chip and the pill
    // closer instead of showing the empty top of the curves.
    const svg = $('.ribbon-svg', ribbon)
    const narrow = window.matchMedia('(max-width: 600px)')
    const frameRibbon = () => svg && svg.setAttribute('viewBox', narrow.matches ? '0 170 1600 246' : '0 96 1600 320')
    frameRibbon()
    narrow.addEventListener?.('change', frameRibbon)
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready
      } catch {
        // Measure with whatever font is there.
      }
    }

    const lanes = [
      { textPath: $('#tp-in'), path: $('#path-in'), measure: $('#measure-in'), speed: 36 },
      { textPath: $('#tp-out'), path: $('#path-out'), measure: $('#measure-out'), speed: 48 },
    ]
      .map((lane) => {
        if (!lane.textPath || !lane.path || !lane.measure) return null
        const copy = lane.textPath.innerHTML
        lane.measure.innerHTML = copy
        const length = lane.measure.getComputedTextLength()
        const pathLength = lane.path.getTotalLength()
        lane.measure.textContent = ''
        if (!(length > 0) || !(pathLength > 0)) return null
        lane.textPath.innerHTML = copy.repeat(Math.max(2, Math.ceil(pathLength / length) + 1))
        lane.length = length
        lane.offset = -length * 0.55
        lane.textPath.setAttribute('startOffset', lane.offset.toFixed(1))
        return lane
      })
      .filter(Boolean)

    sizeChip(chip, AGENT_STEPS[4].text)

    let inView = true
    let pageVisible = !document.hidden
    let paused = false
    let frame = 0
    let last = 0
    let stepIndex = 4
    let stepTimer = 0

    const moving = () => inView && pageVisible && !paused && !reduceMotion.matches

    const tick = (now) => {
      const seconds = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000)
      last = now
      for (const lane of lanes) {
        lane.offset += lane.speed * seconds
        if (lane.offset >= 0) lane.offset -= lane.length
        lane.textPath.setAttribute('startOffset', lane.offset.toFixed(1))
      }
      frame = window.requestAnimationFrame(tick)
    }

    const nextStep = () => {
      stepIndex = (stepIndex + 1) % AGENT_STEPS.length
      const step = AGENT_STEPS[stepIndex]
      chip.classList.toggle('is-pass', step.pass)
      sizeChip(chip, step.text)
      chip.classList.remove('pop')
      void chip.getBoundingClientRect()
      chip.classList.add('pop')
      stepTimer = window.setTimeout(nextStep, step.pass ? 1900 : 1500)
    }

    const update = () => {
      ribbon.classList.toggle('is-paused', !moving())
      if (moving()) {
        if (frame === 0) {
          last = 0
          frame = window.requestAnimationFrame(tick)
        }
        if (stepTimer === 0) stepTimer = window.setTimeout(nextStep, 900)
      } else {
        if (frame !== 0) window.cancelAnimationFrame(frame)
        frame = 0
        window.clearTimeout(stepTimer)
        stepTimer = 0
      }
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        inView = entries.some((entry) => entry.isIntersecting)
        update()
      }).observe(ribbon)
    }

    if (toggle !== null) {
      toggle.addEventListener('click', () => {
        paused = !paused
        toggle.setAttribute('aria-pressed', String(paused))
        $('span', toggle).textContent = paused ? 'Play animation' : 'Pause animation'
        $('use', toggle).setAttribute('href', paused ? '#i-play' : '#i-pause')
        update()
      })
    }

    reduceMotion.addEventListener?.('change', update)
    document.addEventListener('visibilitychange', () => {
      pageVisible = !document.hidden
      update()
    })
    update()
  }

  setupRibbon()

  // ── the example run ─────────────────────────────────────────────────────────
  function setupRun() {
    const windowEl = $('#run-window')
    if (windowEl === null) return
    const steps = $$('.step', windowEl)
    const count = $('#test-count')
    const replay = $('#run-replay')
    let timers = []

    const clear = () => {
      for (const timer of timers) window.clearTimeout(timer)
      timers = []
    }
    const reset = () => {
      for (const step of steps) step.classList.remove('is-active', 'is-done')
    }

    const play = () => {
      clear()
      reset()
      if (reduceMotion.matches) {
        windowEl.classList.remove('is-armed')
        if (count) count.textContent = '12'
        return
      }
      windowEl.classList.add('is-armed')
      if (count) count.textContent = '0'
      let at = 250
      for (const step of steps) {
        const kind = step.dataset.step
        const duration = kind === 'test' ? 1700 : kind === 'edit' ? 1300 : kind === 'ask' ? 1100 : 850
        timers.push(window.setTimeout(() => step.classList.add('is-active'), at))
        if (kind === 'test' && count) {
          for (let passed = 1; passed <= 12; passed += 1) {
            timers.push(window.setTimeout(() => { count.textContent = String(passed) }, at + (duration * passed) / 12))
          }
        }
        at += duration
        timers.push(window.setTimeout(() => {
          step.classList.remove('is-active')
          step.classList.add('is-done')
        }, at))
        at += 140
      }
    }

    if (replay) replay.addEventListener('click', play)

    if (reduceMotion.matches || !('IntersectionObserver' in window)) return
    windowEl.classList.add('is-armed')
    if (count) count.textContent = '0'
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      play()
    }, { threshold: 0.35 })
    observer.observe(windowEl)
  }

  setupRun()

  // ── "Add a skill" ───────────────────────────────────────────────────────────
  function setupRules() {
    const list = $('#rules-chips')
    const button = $('#rules-add')
    if (list === null || button === null) return
    const label = $('span', button)
    const original = list.innerHTML
    const extra = ['frontend-design', 'commit-context', 'scope-discipline', '/fix-lint']
    let added = 0

    button.addEventListener('click', () => {
      if (added >= extra.length) {
        list.innerHTML = original
        added = 0
        label.textContent = 'Add a skill'
        return
      }
      const item = document.createElement('li')
      const code = document.createElement('code')
      code.textContent = extra[added]
      item.append(code)
      if (!reduceMotion.matches) item.className = 'is-new'
      list.append(item)
      added += 1
      if (added >= extra.length) label.textContent = 'Start over'
    })
  }

  setupRules()

  // ── "Undo this run" ─────────────────────────────────────────────────────────
  function setupUndo() {
    const card = $('#undo-card')
    const button = $('#undo-btn')
    const status = $('#undo-status')
    if (card === null || button === null || status === null) return
    button.addEventListener('click', () => {
      const restored = card.dataset.state !== 'restored'
      card.dataset.state = restored ? 'restored' : 'applied'
      status.textContent = restored ? 'Restored to before the run' : 'Changed by the agent'
      button.textContent = restored ? 'Show the change again' : 'Undo this run'
    })
  }

  setupUndo()

  // ── the download button ─────────────────────────────────────────────────────
  async function setupDownload() {
    const button = $('#download-btn')
    const note = $('#download-note')
    if (button === null) return
    if (config.downloadUrl) {
      button.href = config.downloadUrl
      return
    }
    button.href = `${repoUrl}/releases`
    if (!config.checkLatestRelease || typeof window.fetch !== 'function') return
    try {
      // The release list, not /releases/latest: it answers 200 with an empty list before
      // the first release (no 404 in the console), and it includes a beta published as a
      // pre-release, which /releases/latest skips.
      const response = await fetch(`https://api.github.com/repos/${config.repo}/releases?per_page=10`, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!response.ok) return
      const releases = await response.json()
      if (!Array.isArray(releases)) return
      for (const release of releases) {
        const assets = Array.isArray(release.assets) ? release.assets : []
        const installer =
          assets.find((asset) => /setup\.exe$/i.test(asset.name)) ||
          assets.find((asset) => /\.(exe|msi)$/i.test(asset.name))
        if (!installer || typeof installer.browser_download_url !== 'string') continue
        button.href = installer.browser_download_url
        if (note && typeof installer.size === 'number') {
          const megabytes = Math.round(installer.size / 1e6)
          const version = typeof release.tag_name === 'string' ? release.tag_name : 'Latest'
          note.textContent = `${version} beta for Windows, ${megabytes} MB. Free and open source.`
        }
        return
      }
    } catch {
      // Offline, rate-limited or blocked: the button still opens the releases page.
    }
  }

  setupDownload()

  // ── the launch email form ───────────────────────────────────────────────────
  function setupSignup() {
    const form = $('#signup')
    if (form === null || !config.launchEmailEndpoint) return
    form.hidden = false
    const status = $('#signup-status')
    const submit = $('button[type="submit"]', form)
    const say = (text, tone) => {
      status.textContent = text
      if (tone) status.dataset.tone = tone
      else delete status.dataset.tone
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const email = form.elements.namedItem('email').value.trim()
      if (form.elements.namedItem('company').value !== '') return
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        say('Enter an email address, like you@example.com.', 'error')
        form.elements.namedItem('email').focus()
        return
      }
      submit.disabled = true
      say('Sending...')
      try {
        const response = await fetch(config.launchEmailEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email, source: 'sketch-website' }),
        })
        if (!response.ok) throw new Error(`the server answered ${response.status}`)
        say("You're on the list. We'll email you when Sketch launches.", 'ok')
        form.reset()
      } catch (error) {
        say(`The sign-up didn't go through (${error instanceof Error ? error.message : 'network error'}). Try again in a minute.`, 'error')
      } finally {
        submit.disabled = false
      }
    })
  }

  setupSignup()
})()
