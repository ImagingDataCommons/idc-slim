import { defaultConcurrency, runBounded } from '../core/scheduler'

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('runBounded', () => {
  it('returns results in input order regardless of completion order', async () => {
    const { results } = await runBounded(
      [30, 10, 20],
      async (delay) => {
        await new Promise((resolve) => setTimeout(resolve, delay))
        return delay
      },
      { concurrency: 3 },
    )
    expect(results).toEqual([30, 10, 20])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)

    await runBounded(
      items,
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
      },
      { concurrency: 4 },
    )

    expect(peak).toBe(4)
  })

  it('keeps a lane alive after one task rejects', async () => {
    // One unreachable object must not abandon the rest of a download.
    const { results, failures } = await runBounded(
      [1, 2, 3, 4],
      async (n) => {
        if (n === 2) {
          throw new Error('boom')
        }
        return n * 10
      },
      { concurrency: 1 },
    )

    expect(results).toEqual([10, undefined, 30, 40])
    expect(failures.size).toBe(1)
    expect((failures.get(1) as Error).message).toBe('boom')
  })

  it('records every failure by index', async () => {
    const { failures } = await runBounded(
      [1, 2, 3],
      async () => {
        throw new Error('all fail')
      },
      { concurrency: 3 },
    )
    expect(Array.from(failures.keys()).sort()).toEqual([0, 1, 2])
  })

  it('stops dispatching once the signal aborts', async () => {
    const controller = new AbortController()
    const started: number[] = []

    const run = runBounded(
      Array.from({ length: 50 }, (_, i) => i),
      async (n) => {
        started.push(n)
        await new Promise((resolve) => setTimeout(resolve, 1))
        return n
      },
      { concurrency: 2, signal: controller.signal },
    )

    await flush()
    controller.abort()
    const result = await run

    expect(result.aborted).toBe(true)
    // Far fewer than 50 tasks should have been dispatched.
    expect(started.length).toBeLessThan(50)
  })

  it('reports aborted when the signal was already set', async () => {
    const controller = new AbortController()
    controller.abort()
    const started: number[] = []

    const result = await runBounded(
      [1, 2, 3],
      async (n) => {
        started.push(n)
        return n
      },
      { concurrency: 2, signal: controller.signal },
    )

    expect(result.aborted).toBe(true)
    expect(started).toEqual([])
  })

  it('handles an empty input without spawning a lane', async () => {
    let calls = 0
    const result = await runBounded(
      [] as number[],
      async () => {
        calls += 1
        return 0
      },
      { concurrency: 4 },
    )
    expect(calls).toBe(0)
    expect(result.results).toEqual([])
    expect(result.aborted).toBe(false)
  })

  it('does not spawn more lanes than there are items', async () => {
    let inFlight = 0
    let peak = 0
    await runBounded(
      [1, 2],
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
      },
      { concurrency: 16 },
    )
    expect(peak).toBe(2)
  })

  it('passes the index alongside the item', async () => {
    const seen: Array<[string, number]> = []
    await runBounded(
      ['a', 'b', 'c'],
      async (item, index) => {
        seen.push([item, index])
      },
      { concurrency: 1 },
    )
    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ])
  })
})

describe('defaultConcurrency', () => {
  it('caps at the HTTP/1.1 per-origin connection limit', () => {
    // Above six, extra requests queue in the network stack while appearing
    // active in the UI, which makes a healthy download look stalled.
    expect(defaultConcurrency(16)).toBe(6)
    expect(defaultConcurrency(8)).toBe(6)
  })

  it('respects a lower core count', () => {
    expect(defaultConcurrency(4)).toBe(4)
    expect(defaultConcurrency(1)).toBe(1)
  })

  it('assumes a sane default when the hint is missing or nonsensical', () => {
    expect(defaultConcurrency(undefined)).toBe(4)
    expect(defaultConcurrency(0)).toBe(4)
  })
})
