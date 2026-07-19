// obxd-awp-shim.js — Prepended to the emcc output to make it runnable inside
// AudioWorkletGlobalScope, which (in Chrome) is missing several globals that
// emcc's worker-env output assumes.
//
// CRITICAL AWP QUIRKS (verified on Chrome 138):
//
//   1. `self` is NOT defined (use `globalThis`).
//   2. `location` is NOT defined.
//   3. `fetch` is NOT defined.
//   4. `XMLHttpRequest` is NOT defined.
//   5. `importScripts()` was removed in Chrome 105+.
//   6. Dynamic `import()` is disallowed.
//   7. Top-level `var`/`function` declarations go into a SEPARATE declarative
//      record, NOT onto `globalThis`. `globalThis.X = ...` silently fails
//      because globalThis is non-extensible. Bare-name `X` works ONLY because
//      of the separate declarative record.
//   8. emcc's `self.location.href` reads `self` (which we want to be
//      globalThis) and then `.location.href`. So `self.location` must work,
//      which means `globalThis.location` must work — but per (7) it can't.
//
// Solution: declare `self` as a top-level var holding a regular object that
// ALSO exposes location/fetch/etc as properties. Bare `self`, `location`,
// `fetch` all resolve via the declarative record. emcc's `self.location.href`
// resolves via our self object's location property.

var location = {
    href: '/',
    origin: '/',
    pathname: '/',
    protocol: 'https:',
    hostname: 'localhost',
    port: '',
};

var fetch = function fetch(_url, _opts) {
    // Never resolves, never rejects. The patched WebAssembly.instantiateStreaming
    // (installed by obxd-processor.tail.js's ensureModule) wins the race with the
    // pre-fetched bytes from processorOptions, so emcc's loader never actually
    // awaits this promise. Returning a forever-pending promise (rather than
    // rejecting) avoids an "Uncaught (in promise)" log from emcc's fetch
    // fallback path that doesn't attach a .catch() — purely cosmetic, but
    // keeps the console clean.
    return new Promise(function () {});
};

var importScripts = function importScripts() {
    throw new Error('importScripts() is not available in AudioWorkletGlobalScope');
};

// `self` is the worker-scope global. emcc reads self.location.href. AWP's
// real globalThis is non-extensible (we can't add `location` to it), so we
// can't just do `globalThis.self = globalThis`. Instead, declare `self` as
// a top-level var that includes the needed properties. emcc's bare `self`
// resolves here.
//
// Note: this means `self !== globalThis` inside AWP, which is technically
// incorrect vs the worker spec. But emcc only needs a few properties off
// `self`, and we mirror globalThis's standard AWP members (sampleRate etc.
// remain on globalThis) for any code that reads them off globalThis.
var self = {
    location: location,
    fetch: fetch,
    importScripts: importScripts,
    // Pass-through to globalThis for properties emcc might want but AWP
    // defines only on globalThis (sampleRate, currentTime, currentFrame).
    get sampleRate() { return globalThis.sampleRate; },
    get currentTime() { return globalThis.currentTime; },
    get currentFrame() { return globalThis.currentFrame; },
};

// `document` — referenced by some emcc paths under feature-detection guards.
var document = undefined;

// `performance` — emcc's `_emscripten_get_now = () => performance.now()`
// (worker-env output). Real Web Workers have `performance`; AWP does not.
// JUCE's Random::setSeedRandomly() reaches this via Time::currentTimeMillis()
// during SynthEngine construction, so without the shim the worklet's WASM
// init throws a ReferenceError before bufLPtr is read.
//
// AWP exposes `currentTime` on globalThis (seconds since context start,
// double precision) — use it as the timebase. performance.now() returns
// milliseconds, matching the spec emscripten_get_now expects.
var performance = {
    now: function performance_now() {
        // globalThis.currentTime is defined by AudioWorkletGlobalScope.
        // Fallback to Date.now() (also shimmed by emcc) keeps this safe
        // in non-AWP worker contexts too.
        var ct = (typeof globalThis.currentTime === 'number') ? globalThis.currentTime : 0;
        return ct * 1000.0;
    },
};

