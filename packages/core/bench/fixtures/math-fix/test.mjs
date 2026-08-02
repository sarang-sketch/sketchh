import assert from 'node:assert/strict'
import { add } from './src/math.mjs'

assert.equal(add(2, 3), 5)
