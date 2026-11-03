# `standards/agents/`

**How we instruct agents** — what the repository's always-loaded surface declares to whoever reads
it at the start of a session: the language of the prose and the conduct expected of the agent that
writes it.

**Boundary:** `agents/` governs the *instructions* the repository gives an agent. The layout and
the commands live in [../code/](../code/index.md). One standard per file; each with
`type: standard` and a derived `resource:`.

* [communication.md](communication.md) — the declared language (`en`, on the `Language:` line of the root `AGENTS.md`) and the agents' conduct contract
