# Offline Mode

Offline Mode keeps Sketch's engine on this computer. Turn it on in **Settings → Privacy**. While it is on, the status bar shows **Offline**.

## What it does

| Works | Refused, with a message saying what and why |
|---|---|
| Models served on this computer: Ollama, LM Studio, llama.cpp, or any server at `localhost`, `127.x.x.x` or `::1` | Internet providers (OpenAI, Anthropic, Gemini, Groq, OpenRouter and the rest), for chats, completions, inline edits, commit messages and skill training |
| Listing, loading, unloading and removing local models | Downloading a model (Ollama fetches it from the internet) |
| Editing, the Explorer, git commits, branches and history | git push, pull, fetch and clone |
| The terminal, Run panel and your project's checks | ChatGPT and OpenRouter sign-in, and connection tests against internet providers |
| Project memory, search, architecture views, chats | MCP servers that need the network, and all of your own MCP servers (Sketch cannot tell what a program connects to) |

A server on another computer in your network counts as "not this computer" and is refused.

## How it is enforced

Two layers in the engine (`packages/core/src/privacy/offline.ts`):

1. **Explicit checks** before work starts, where the engine knows what it will contact: provider resolution for runs and connection tests, sign-ins, model downloads, git sync, MCP server start-up.
2. **A guard around the engine's `fetch`**, installed when the engine starts. Every request the engine makes goes through it, so a path the first layer missed is still stopped. It records each request (address and result only) for the Network activity list.

The setting is saved in `~/.sketch/privacy.json`. If that file exists but cannot be read, Offline Mode counts as **on**; switching it off rewrites the file. Setting `SKETCH_OFFLINE=1` in the engine's environment forces it on (the switch then cannot change it); `SKETCH_OFFLINE=0` forces it off.

## What it does not cover

Programs Sketch starts are separate processes, and the engine's guard cannot see their connections:

- programs you run in the terminal or the Run panel;
- your project's own scripts, including the checks the agent runs;
- commands the agent runs with `run_command` (an `npm install` still reaches the registry).

Sketch refuses to start the ones whose purpose is the network (git sync, model downloads, network MCP servers, your own MCP servers), and the Privacy page says the rest plainly.

## How to check it yourself

1. Turn Offline Mode on, pick an internet provider, and send a chat: it is refused before anything is sent, naming the address.
2. Open **Settings → Privacy → Network activity**: refused requests are listed as **Blocked**; requests to your local model server as **Sent**.
3. For a whole-machine check that covers every process, follow the clean-machine procedure in `OFFLINE-PROOF.md`.

## Your data

Settings → Privacy also lists where Sketch keeps data (settings and sign-ins in `~/.sketch`, each project's run log and memory in its `.sketch` folder, chats in the window's local storage, keys in the OS credential store) and has **Clear chat history**, which asks first.
