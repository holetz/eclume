# `explanation/` — explanation

Understanding-oriented pages that explain how and why the product works, for the reader of
the documentation site (the Diátaxis **explanation** quadrant). Each page carries
`type: explanation`.

**Boundary:** a concept page here is part of the **published site** for product users.
Internal team understanding — mental models and learnings — belongs in the `concepts/` home. The
root glossary remains canonical there and is copied into the bounded `site-source/` input by
`.agents/quenching/bin/cq knowledge site-source`; readers reach its published route without a second editable source.

## How to organize

The repo decides which concept pages exist — the skeleton ships none. Standalone pages live
as `.md` files here; group by subject into subfolders with their own `index.md`.
