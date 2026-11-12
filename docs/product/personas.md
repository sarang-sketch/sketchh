# Who Sketch is for

Four people, drawn from public reviews of AI code editors (October 2026). Each section says what
they complain about elsewhere, with the source, and what Sketch does about it. Third-party figures
are quoted as their source states them and were not re-measured.

## 1. Priya: the developer who cannot pay $20 a month

A student or early-career developer, often outside the US. Uses free tiers until they run out.

- **What hurts elsewhere.** Trustpilot reviewers of Cursor most often mention "unexpected charges",
  "confusing subscription models" and "high prices"
  ([Trustpilot](https://www.trustpilot.com/review/cursor.com)). Cursor's June 2025 move from request
  limits to usage-based credits made costs hard to predict; users called the credit counter
  "anxiety-inducing and opaque" ([nxcode](https://www.nxcode.io/resources/news/cursor-alternative-2026-best-ai-code-editors)).
  Free tiers have a reputation for being "capped at a usage level designed to frustrate you into
  paying" ([techsifted](https://techsifted.hashnode.dev/codeium-review-2026-the-best-free-ai-coding-assistant)).
- **What Sketch does.** The editor is free with no account. A model on her own computer (Ollama,
  LM Studio, llama.cpp) costs nothing. Free hosted options (ChatGPT sign-in, OpenRouter free models, Gemini, Groq, GitHub Models) sit next to
  it. The cost panel reads the same log the runs write, so the number shown is the number spent.

## 2. Marcus: the senior engineer who does not trust the output

Ten years in, uses AI daily, reviews every line.

- **What hurts elsewhere.** More developers distrust the accuracy of AI tools (46%) than trust it
  (33%) ([Stack Overflow 2025](https://survey.stackoverflow.co/2025/ai/)). The top frustration is
  "AI solutions that are almost right, but not quite"
  ([Stack Overflow blog](http://blog.stackoverflow.com/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/)).
  G2 reviewers of Cursor say it "can sometimes generate incorrect or overly complex code, so you
  still need to review its suggestions carefully" ([G2](https://www.g2.com/products/cursor/reviews)).
- **What Sketch does.** The agent must write a plan before it edits, and "done" only counts when the
  project's own checks pass (format, lint, typecheck, build, tests). Changes can be reviewed hunk by
  hunk, every run has an Undo, and the timeline replays exactly what happened.

## 3. Lena: the developer whose code cannot leave the machine

Works under an NDA, in a regulated company, or simply on principle. Runs models locally.

- **What hurts elsewhere.** "Your code is processed in the cloud" is a standing caveat in Cursor
  reviews ([similarlabs](https://similarlabs.com/blog/cursor-review)). Local agents get blamed on weak
  models, but often the cause is plumbing: on machines with under 24 GiB of video memory, Ollama
  defaults to a 4K context window and silently drops the start of longer prompts
  ([dev.to](https://dev.to/eryk_kubiak_c9663554a1ff4/local-coding-agent-weak-model-no-bad-plumbing-1l3j)).
  Small local models also tend to repeat the same action in a loop
  ([oh-my-openagent #585](https://github.com/code-yeongyu/oh-my-openagent/issues/585)).
- **What Sketch does.** No telemetry, no account and no Sketch server; keys sit in the operating
  system's credential store, and a test fails if the engine can reach a non-local host during the
  suite.

## 4. Arjun: the beginner who wants something working tonight

Learning to code, or a designer or founder building a first app.

- **What hurts elsewhere.** Setup that assumes knowledge he does not have: API keys, model names,
  JSON settings files. Reddit's advice to beginners is "verify everything it suggests"
  ([aitooldiscovery](https://www.aitooldiscovery.com/guides/best-ai-for-coding-reddit)), which needs a
  way to see and undo what the AI did.
- **What Sketch does.** "Connect a model" walks him through it without a settings file. Its first
  two choices need no key: ChatGPT sign-in (the Free plan works) and OpenRouter, which has free
  models. Each project's run scripts are one click in the Run panel, error locations
  in the terminal open the file at the line, and Edit with AI (Ctrl+K) shows a change as a diff
  before anything is written.
