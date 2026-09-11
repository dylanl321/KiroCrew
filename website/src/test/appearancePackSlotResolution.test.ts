/**
 * The slot fallback chain, and its parity with the server's.
 *
 * A pack's FORMAT lives on the resolved slot, so the client has to walk the chain
 * itself before it can pick a player — which means the chain exists twice, here
 * and in `dashboard/appearances.py`. This test reads the backend's own order out
 * of that module and compares it, so the duplicate cannot drift into a client
 * that hands a Lottie parser a PNG.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { packDetailFrom, resolveSlot, spriteRowFor } from '../lib/appearancePacks/detail'

const svg = { content: '<svg/>', format: 'svg' }

describe('resolveSlot', () => {
  const full = packDetailFrom({
    animations: { idle: svg, loading: svg, thinking: svg, working: svg, done: svg, error: svg },
  })

  it('prefers the state own slot when the pack draws it', () => {
    for (const state of ['idle', 'working', 'done', 'error']) {
      expect(resolveSlot(full, state)).toBe(state)
    }
  })

  it('walks working through loading and thinking before idle', () => {
    const noWorking = packDetailFrom({ animations: { idle: svg, loading: svg, thinking: svg } })
    expect(resolveSlot(noWorking, 'working')).toBe('loading')
    expect(resolveSlot(packDetailFrom({ animations: { idle: svg, thinking: svg } }), 'working'))
      .toBe('thinking')
    expect(resolveSlot(packDetailFrom({ animations: { idle: svg } }), 'working')).toBe('idle')
  })

  it('falls done and error back to idle', () => {
    const idleOnly = packDetailFrom({ animations: { idle: svg } })
    expect(resolveSlot(idleOnly, 'done')).toBe('idle')
    expect(resolveSlot(idleOnly, 'error')).toBe('idle')
  })

  it('resolves an author-named clip to itself only', () => {
    // A pack's random clips are named by their author, so a fixed vocabulary
    // would make them unfetchable — and `walking` must not silently draw idle.
    const pack = packDetailFrom({ animations: { idle: svg, walking: svg } })
    expect(resolveSlot(pack, 'walking')).toBe('walking')
    expect(resolveSlot(packDetailFrom({ animations: { idle: svg } }), 'walking')).toBeNull()
  })

  it('answers null for a pack that draws nothing at all', () => {
    expect(resolveSlot(packDetailFrom({}), 'idle')).toBeNull()
  })
})

describe('chain parity with the server', () => {
  it('matches the order dashboard/appearances.py resolves', () => {
    // Read the backend's own table rather than restating it: a chain changed
    // there and not here is the drift this test exists for.
    const py = readFileSync(
      resolve(__dirname, '../../../src/kiro_crew/dashboard/appearances.py'),
      'utf-8',
    )
    for (const [state, chain] of [
      ['working', ['working', 'loading', 'thinking', 'idle']],
      ['done', ['done', 'idle']],
      ['error', ['error', 'idle']],
    ] as const) {
      // The module spells each chain as a tuple/list of slot names beside its
      // state key; assert every member appears in order within one line of it.
      const line = py.split('\n').find((l) => l.includes(`"${state}"`) && l.includes('"idle"'))
      expect(line, `no fallback line for ${state}`).toBeTruthy()
      let at = -1
      for (const slot of chain) {
        const next = line!.indexOf(`"${slot}"`, at + 1)
        expect(next, `${state} -> ${slot}`).toBeGreaterThan(at)
        at = next
      }
    }
  })
})

describe('spriteRowFor', () => {
  const sheet = (rowAssignments: Record<string, number>) =>
    packDetailFrom({
      animations: { idle: { content: 'b64', format: 'sprite' } },
      sprite: { frameWidth: 16, frameHeight: 16, fps: 4, rowAssignments },
    })

  it('reads the row the sheet assigns the slot', () => {
    expect(spriteRowFor(sheet({ idle: 0, working: 2 }), 'working')).toBe(2)
  })

  it('treats an unassigned slot as a single-row strip', () => {
    expect(spriteRowFor(sheet({ working: 1 }), 'idle')).toBe(0)
    expect(spriteRowFor(packDetailFrom({ animations: {} }), 'idle')).toBe(0)
  })

  it('refuses a row that would sample outside the sheet', () => {
    // The map comes out of a third-party bundle; a negative offset samples above
    // the sheet and draws an empty frame for every state.
    expect(spriteRowFor(sheet({ idle: -3 }), 'idle')).toBe(0)
    expect(spriteRowFor(sheet({ idle: 1.7 }), 'idle')).toBe(1)
    expect(spriteRowFor(sheet({ idle: NaN }), 'idle')).toBe(0)
  })
})

describe('packDetailFrom', () => {
  it('drops a malformed slot rather than defaulting it', () => {
    // A dropped slot lets the chain step PAST it; a defaulted one would hand a
    // player bytes it cannot read.
    const detail = packDetailFrom({
      animations: { idle: svg, working: { format: 'lottie' }, done: { content: '' } },
    })
    expect(Object.keys(detail.animations)).toEqual(['idle'])
    expect(resolveSlot(detail, 'working')).toBe('idle')
  })

  it('reads an unknown format as svg', () => {
    const detail = packDetailFrom({ animations: { idle: { content: 'x', format: 'webp' } } })
    expect(detail.animations.idle.format).toBe('svg')
  })

  it('reads sound presence strictly as true', () => {
    // A differently-shaped answer must not make the client fetch a sound route
    // that answers 404.
    expect(packDetailFrom({ sounds: { done: true, working: 'chime', error: 1 } }).sounds)
      .toEqual({ done: true })
  })

  it('is total against junk', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { animations: 'nope' }]) {
      expect(packDetailFrom(junk)).toEqual({ animations: {}, sprite: undefined, sounds: {} })
    }
  })
})
