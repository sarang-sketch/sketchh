---
name: finance-quant
description: Write financial and numerical code with exact money arithmetic, stated units, and no advice.
capabilities: fs:read:project
---

# Finance and quantitative code

## This skill gives no financial advice

You write and review code. You do not recommend an investment, forecast a price,
size a position, or interpret someone's financial situation. If a task asks for
that, say plainly that you help build the software and not the decision, and offer
the technical half.

## Money is never a float

`0.1 + 0.2 !== 0.3`, and in a currency column that is a real defect with a real
cost.

- Represent money as an **integer in the smallest unit** (cents, satoshi, pence),
  or as the project's existing decimal type. Match what the project already does.
- **Every monetary value carries its currency.** A bare number is not an amount.
  Two amounts in different currencies do not add, and code that adds them should
  fail rather than convert silently.
- **State the rounding rule** at every boundary where precision is lost: half-up,
  half-even, or truncate — and say which. Rounding at the wrong step is how totals
  stop matching their line items.
- Rates and percentages: keep the raw ratio, format for display, and never
  round-trip through the formatted string.

## Units and time

- Name the unit in the identifier: `budget_ms`, `notional_cents`, `rate_bps`,
  `weight_pct`. A variable called `amount` is a defect waiting for a maintainer.
- **Basis points are not percent.** 25 bps is 0.25%, and the two are confused
  routinely.
- Timestamps are **UTC** with an explicit timezone; a business date is a date, not
  an instant. A trade "on Monday" depends on whose Monday.
- Day counts and periods follow the convention the domain uses (ACT/365,
  30/360, …). Name the convention in the code; do not infer it.

## Numerical care

- Sum in a stable order, and prefer the summation the project already uses.
  Reordering a float sum changes the answer.
- Never compare floats with `===`. Compare within a stated tolerance, and state it.
- A division needs a documented answer for a zero denominator. "It cannot be zero"
  is not documentation.
- Say when a calculation is an **estimate**, and by what method. A number that
  looks exact will be trusted as exact.

## Data and reproducibility

- Record the source and as-of timestamp of every input. A figure with no as-of is
  not reproducible and not auditable.
- Missing is not zero. A missing price is `null`; treating it as 0 silently
  produces a loss that never happened.
- Seed every simulation and record the seed. An unreproducible backtest result is
  an anecdote.
- Corporate actions, splits, and revisions change history. Say whether your series
  is adjusted, and how.

## Testing

Test the boundaries that actually break: zero, negative, the smallest
representable unit, the largest plausible value, a currency mismatch, a leap day,
a DST transition, and a rounding case whose two plausible answers differ by one
cent. Assert the exact expected integer, never "approximately".

## What not to do

- Do not hardcode a rate, a fee, or a currency. Configuration.
- Do not log a full account identifier or a credential.
- Do not present a backtest as a prediction, in code comments or in output.
