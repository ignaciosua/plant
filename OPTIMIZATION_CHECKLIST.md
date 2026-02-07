# Optimization Checklist

## Runtime Performance
- [x] Replace `O(N²)` branch collision broad-phase with spatial hash buckets.
- [x] Reuse branch collision buckets between frames (clear/reuse arrays instead of reallocating).
- [x] Reuse leaf collision buckets, key arrays, and active index arrays.
- [x] Replace string-based spatial keys with numeric hash keys (`spatialHash3`).
- [x] Add adaptive plant collider sync rate based on current scene load.
- [x] Add segment collider LOD budget (skip very small/low-impact colliders under overload).
- [x] Throttle environment lighting/fog updates to a fixed interval.
- [x] Throttle environment status DOM updates to reduce UI churn.
- [x] Cache transparent mountain material refs and avoid per-frame `traverse`.
- [x] Throttle physics debug overlay sync rate.
- [x] Add adaptive pixel ratio control to stabilize FPS on weaker devices.

## Physics Fidelity vs Cost
- [x] Keep high-priority colliders (thicker and active segments) under collider budget pressure.
- [x] Preserve dynamic leaf physics while reducing cost from collision bookkeeping allocations.
- [x] Keep branch collision correction active during growth while making broad-phase scalable.

## Code Structure / Maintainability
- [x] Centralize performance tuning constants (env update intervals, debug interval, adaptive DPR bounds).
- [x] Isolate reusable status text formatter (`buildEnvironmentStatusText`).
- [x] Keep per-frame paths allocation-free where possible.

## Validation
- [x] Run syntax validation after all edits.
- [ ] Smoke test: seed change + auto-grow + wind + physics debug on/off.
- [ ] Mobile sanity check: confirm adaptive DPR converges and UI remains responsive.
