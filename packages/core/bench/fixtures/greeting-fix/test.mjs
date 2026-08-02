import assert from 'node:assert/strict'
import { greet } from './src/greet.mjs'

assert.equal(greet('Sketch'), 'Hello, Sketch!')
