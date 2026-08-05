<!--
Every PR is reviewed personally by the maintainer, so review takes time — days, longer for security,
the event log, capabilities, the native host, or any gate. Filling this in honestly makes it faster.
Delete any section that genuinely does not apply.
-->

## What changed, and why

<!-- One concern per PR. Link the issue where the approach was agreed. -->

Closes #

## How I verified it

```
npm run build        # first: desktop typecheck consumes core's emitted declarations
npm run typecheck
npm test -w @sketch/core
npm test -w @sketch/desktop
```

- [ ] All four exit 0, **offline, with no API key in the environment**
- [ ] Suite run twice: once with `SKETCH_FAKE_PROVIDER=1`, once with it unset
- [ ] No test was skipped, loosened, or deleted to get green

## Broke the guard, watched it fail

<!--
Rule 4: green output is not evidence. For every guard, gate, redaction or containment check this
touches — break it, paste the failure, restore it, paste the pass. Skip only if this PR touches none.
-->

<details><summary>failure, then pass</summary>

```
```

</details>

## What I could NOT verify

<!-- An honest gap is useful. A silent one costs trust. "Nothing" is a valid answer if it is true. -->

## Checks that apply to this change

- [ ] `packages/core` still has **zero runtime dependencies**
- [ ] No fixture or placeholder data in a shipped panel — empty states say *why* they are empty
- [ ] Adds no outbound network path; if it does, `PRIVACY.md` is updated in this PR
- [ ] Secrets stay off disk and out of the event log
- [ ] New tool access goes through `ToolDispatcher` and requires a capability grant
- [ ] Commands run as argument vectors, never shell strings
- [ ] Docs updated where behaviour changed (`README.md`, `architecture.md`, `EXTENSIBILITY.md`)
- [ ] Describes seams as seams and stubs as stubs — nothing here is called working that is not

By opening this PR I agree it is contributed under **Apache-2.0**, and I have read
[CONTRIBUTING.md](../CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).
