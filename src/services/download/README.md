# Direct download

Streams DICOM objects from a public object store straight into a folder the user
picks, with no server in the byte path.

Self-contained by design: no dependencies, no React, and no imports from the rest
of this application, so it can be lifted into a standalone package for another
viewer without code changes. `__tests__/extraction.test.ts` enforces that
mechanically rather than by convention.

## The one rule that will bite you

**`pickDestination()` must be the first statement of a click handler.**

The directory picker requires transient user activation. Any `await` before it —
a network request, an async confirmation dialog, even a state update that yields
— consumes that activation and the call throws. This is why the API is split the
way it is: everything needing the network happens in `prepare()`, before the user
clicks, so the click handler has nothing left to do but pick and start.

```ts
// WRONG — the await spends the activation
const onClick = async () => {
  const { plan } = await service.prepare(selector)   // ← activation gone
  const picked = await pickDestination()             // ← throws
}

// RIGHT — prepare on open, pick on click
const onOpen = async () => setPrepared(await service.prepare(selector))
const onClick = async () => {
  const picked = await pickDestination()             // ← first statement
  if (!picked.ok) return
  const check = await verifyDestination({ plan, sink: picked.sink, ... })
  service.start(plan, picked.sink)
}
```

## The four-call protocol

| Call | Needs a gesture? | Purpose |
| --- | --- | --- |
| `prepare(selector)` | No | Resolve identifiers, list objects, build a plan with **exact** byte and file counts, licenses, warnings, blockers |
| `pickDestination()` | **Yes, first statement** | Ask the user for a folder; returns a `DirectorySink` |
| `verifyDestination(...)` | No | Confirm the destination is writable and can hold the deepest path |
| `start(plan, sink)` | No | Run the transfer; returns a `DownloadJob` |

`prepare()` needs no browser capability, so it works in browsers that cannot
download at all. That is deliberate: an unsupported browser can still be handed a
command-line snippet containing the real bucket paths rather than a bare
documentation link.

## Deciding what UI to show

`probeCapabilities()` returns *every* failing reason, because the copy differs per
reason and collapsing them all into "unsupported browser" hides the ones a user
could act on. Combined with the plan, three states fall out:

| State | Condition |
| --- | --- |
| Offer the download | `directDownload === 'supported'`, no blockers, no warnings |
| Offer it, warn first | supported, no blockers, warnings present |
| Command line only | `directDownload === 'unsupported'` **or** `plan.blockers.length > 0` |

## Browser support

Requires the File System Access API, which in practice means a Chromium browser
on desktop. Detection is at runtime, so the feature turns itself on if another
engine ships the picker. Known blockers:

- **No File System Access API** — Firefox and Safari.
- **Insecure context** — the API is HTTPS-only, so plain HTTP on a LAN address
  cannot use it however capable the browser.
- **Cross-origin subframe** — the picker throws `SecurityError`. Relevant to any
  host embedding the viewer in a portal iframe.
- **Mobile** — advisory rather than blocking; surfaced as a warning.

## Architecture

```
index.ts        Public API. The only file a host should import.
types.ts        Every public type. No logic, no imports.
service.ts      Orchestrator: prepare / start / activeJob.
core/
  transfer.ts   Per-file pump: retry, range-resume, size check, abort cleanup.
  plan.ts       Resolved series + listings -> DownloadPlan.
  scheduler.ts  Bounded-concurrency runner.
  layout.ts     On-disk paths, sanitization, path-length projection.
  progress.ts   Counters, throttled snapshots, windowed rate and ETA.
  retry.ts      Retry classification and jittered backoff.
  limits.ts     Size and count thresholds.
  manifest.ts   CSV manifest for the flat layout.
sources/        S3 ListObjectsV2: URL building, pagination, XML scanning.
sinks/          The destination seam, plus FSA and in-memory implementations.
platform/       Capability probing, the picker, the path-length probe.
resolvers/idc/  The ONLY archive-aware code in the module.
```

### Two decisions worth knowing

**No workers.** There is no CPU work in this pipeline — no decoding, no hashing,
no copying — and the browser's per-origin connection limit for HTTP/1.1 (which is
all the S3 REST API speaks) is shared process-wide rather than per-thread. Sixteen
workers against one bucket therefore move exactly what six main-thread fetches do,
while adding a worker lifecycle, a `blob:` URL needing `worker-src blob:` under
any CSP, and structured-cloning of directory handles. Concurrency defaults to six
for the same reason: above that, requests queue in the network stack while
appearing active in the UI, which makes a healthy download look stalled.

**An explicit reader loop, not `pipeTo`.**
`response.body.pipeThrough(counter).pipeTo(writable, { signal })` is shorter and
gets backpressure and abort semantics for free, but it hides the byte offset that
range-resume needs and requires `TransformStream`, which jsdom lacks — so the hot
path would become untestable. This is not a browser-support argument: `for await`
over a response body works in Chromium.

## Data integrity

Three behaviours exist specifically so an interrupted download cannot be mistaken
for a complete one:

- **A cancelled transfer aborts the writer and removes a file this run created.**
  Closing it instead would commit a truncated file under its correct final name,
  indistinguishable from a complete one. `abort()` alone is not enough either: a
  freshly created handle can survive as a zero-byte file, which looks just as
  real.
- **Written bytes are verified against the size the listing reported.** Free,
  because the listing already carries it, and the only defence against truncation
  from any cause.
- **Writes are awaited.** Un-awaited, the writable's queue grows to the gap
  between network and disk throughput for the whole transfer, and a write
  rejection surfaces far from where it happened.

`skipExistingBySize` plus range-resume then make recovery cheap: a re-run after an
interruption skips whatever already landed at the right size.

## Adding a resolver

A resolver maps DICOM identifiers to object-store locations. It hands back a
finished `baseUrl` and `prefix`; the engine never composes a hostname, so it
cannot develop the class of bug where a region field drifts out of sync with a
hardcoded URL.

```ts
const resolver: SeriesResolver = {
  id: 'my-archive',
  resolve: async (selector, ctx) => ({
    series: [/* ResolvedSeries, one entry per resolvable series */],
    unresolved: [/* UIDs this archive does not have — never omit these */],
  }),
  describeFallback: (selector, resolved) => ({ /* command-line snippets */ }),
}
```

`unresolved` is load-bearing, not defensive. A slide annotated in the viewer has
SR/ANN series that exist only on the local DICOMweb server and will never appear
in a public archive index, so a slide-level request routinely resolves fewer
series than it asked for. Reporting that is what lets the UI say "3 of 4 series
can be downloaded" instead of silently downloading less than the user expects.

## Testing

Everything except the three browser adapters runs under jsdom, because each
external dependency sits behind an injected seam:

| Seam | Test double |
| --- | --- |
| `HttpLike` | Narrower than `fetch` on purpose; a fake is ~10 lines |
| `ByteReaderLike` | An array of chunks; a mid-stream failure is one rejected `read()` |
| `DirectorySink` | `createMemorySink()`, with injectable faults via `failOn` |
| `now` / `sleep` / `random` | Injected, so backoff and throttling are deterministic |
| `CapabilityEnv` | Plain object, so every capability branch is covered |

Not unit-tested, and therefore kept thin and free of policy: `sinks/fsaSink.ts`,
`platform/picker.ts`, `platform/pathProbe.ts`.

## Extraction contract

Enforced by `__tests__/extraction.test.ts`:

- No imports escaping the module; no path aliases; no runtime dependencies.
- Nothing outside `resolvers/` may import from `resolvers/`, or name an archive
  host.
- No `import.meta`, `process.env`, `NodeJS.*`, or `declare global`.
- No `for await` or async generators (they change the emitted output under
  `target: es5`).
- No `console.*` — logging goes through the injected `Logger`.
- Browser globals only in `platform/`.
- No default exports and no `enum` (both travel badly across a package boundary).

Extraction is then `git mv`, add a `package.json`, and change one import. No code
changes is the acceptance criterion.

A host supplies: a resolver, a `SeriesSelector`, somewhere to call `prepare()`,
a click handler that calls `pickDestination()` first, and its own progress UI.
