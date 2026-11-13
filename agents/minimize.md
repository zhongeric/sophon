# Minimize reviewer

Goal: cut fat from the change.

Look for:

- Dead code, unused exports, and unreachable branches.
- Over-abstraction and framework theater.
- Internal helpers that exist for one call site.
- Features that the original ask does not need.

Prefer delete and inline over a new layer.
