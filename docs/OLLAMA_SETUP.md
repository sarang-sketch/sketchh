# Running models on your computer with Ollama

Sketch works without any account or API key when a model runs on your own computer. Ollama is the runtime Sketch can manage for you; LM Studio and llama.cpp work too, as servers you start yourself.

## 1. Install Ollama

Download it from [ollama.com/download](https://ollama.com/download) (Windows, macOS, Linux) and start it. On Windows and macOS it runs in the background after install; on Linux run `ollama serve`.

Sketch finds it at `http://localhost:11434`. If you moved it, set the address under Settings → Models → Ollama.

## 2. Pick and download a model in Sketch

Open **Settings → Models**. The "On this computer" section shows:

- whether Ollama is running, installed but stopped, or not installed;
- this computer's memory, CPU threads and NVIDIA GPU memory (other GPUs are not detected);
- the models you have, with size, quantisation, context length and what each can do (`completion`, `tools`, `vision`, `embedding`);
- recommended models for this computer, with a "Best fit".

**Download** asks first and shows the download size and the memory it needs. **Use for chat** makes the model the one the agent uses. **Load** keeps it in memory for 30 minutes; **Unload** frees it now. **Remove** asks first.

From a terminal the same actions are `ollama pull qwen2.5-coder:7b`, `ollama list`, `ollama ps` and `ollama rm <name>`.

## 3. Which model

Sizes are the default downloads listed on ollama.com (checked 2026-11-01).

| Model | Download | Context | Memory needed (estimate) | Good for |
|---|---|---|---|---|
| `qwen2.5-coder:1.5b` | 986 MB | 32K | about 5 GB | Completions and small edits on any machine |
| `qwen2.5-coder:3b` | 1.9 GB | 32K | about 7 GB | 8 GB machines |
| `qwen2.5-coder:7b` | 4.7 GB | 32K | about 11 GB | 16 GB machines; the usual choice |
| `qwen2.5-coder:14b` | 9.0 GB | 32K | about 17 GB | 32 GB machines |
| `qwen3-coder:30b` | 19 GB | 256K | about 31 GB, or a GPU with 21 GB | Long agentic tasks on large machines |
| `qwen2.5-coder:32b` | 20 GB | 32K | about 32 GB, or a GPU with 22 GB | Strongest Qwen 2.5 coder |
| `nomic-embed-text` | 274 MB | 2K | about 4 GB, almost all of it the system allowance | Embeddings for search; not a chat model |

The estimate is 1.5 x the download plus 4 GB for the system, Sketch and a browser; a GPU "holds" a model when its memory is at least 1.2 x the download. Memory is shown in GB of 1,024³ bytes, as Windows shows it. Without a GPU that holds the model, Sketch's "Best fit" stops at 10 GB, because larger models answer only a few words a second on a CPU.

Sketch's agent does not need a model with native tool calling: it speaks a JSON protocol any chat model can follow. Bigger models follow it more reliably.

## 4. Give the model enough context

Ollama uses a 4,096-token context window by default (Ollama's FAQ, checked 2026-10-29) and silently cuts the start of longer prompts, which makes local models look worse than they are. Sketch talks to Ollama's OpenAI-compatible endpoint, which ignores per-request context settings, so raise the limit in Ollama itself:

```powershell
# Windows: set it once, then quit and restart Ollama from the tray
setx OLLAMA_CONTEXT_LENGTH 16384
```

```bash
# macOS / Linux
launchctl setenv OLLAMA_CONTEXT_LENGTH 16384   # macOS app
OLLAMA_CONTEXT_LENGTH=16384 ollama serve       # Linux, or any terminal
```

A larger window needs more memory. 16,384 is a good start on 16 GB.

## Hardware requirements

- **Minimum:** 8 GB of memory for a 1.5B or 3B model. Slow on older CPUs.
- **Comfortable:** 16 GB for a 7B coder.
- **Large models:** 32 GB or more, or an NVIDIA GPU with enough memory for the whole model.
- Disk: the download size of each model, under your user folder (`~/.ollama`).

## Troubleshooting

| What you see | What to do |
|---|---|
| "Ollama is not installed" | Install it from ollama.com, then press Refresh |
| "Ollama is installed but not running" | Start it from your apps menu, or run `ollama serve`, then Refresh |
| "Offline Mode is on ... downloading" | Downloads need the internet. Turn Offline Mode off, download, then turn it back on |
| A download stops | Press Download again: Ollama resumes where it stopped |
| Answers ignore earlier parts of a long request | Raise `OLLAMA_CONTEXT_LENGTH` (above) |
| The model is very slow | Pick a smaller one from the recommendations, or Unload models you are not using |
