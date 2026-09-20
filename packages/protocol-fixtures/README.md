# Protocol fixtures

Canonical examples of every shape that crosses the Rust ↔ TypeScript boundary,
serialized by the Rust types themselves and decoded by the TypeScript decoders.

There is no code generator between the two halves: the Effect schemas in
`packages/tmuxy-ui/src/tmux/effect/schemas.ts` and the merge logic in
`packages/tmuxy-ui/src/tmux/deltaProtocol.ts` mirror the Rust types by hand.
When the two drift, neither suite notices — the `history_size` field was on the
wire and absent from the decoder for exactly that reason. These files are the
shared artefact that makes the drift visible.

| File                          | Shape                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `get_initial_state.json`      | The 200 body of `POST /commands` for `get_initial_state` — the `CommandResponse` envelope around a full state |
| `sse_state_update_full.json`  | The `state-update` SSE frame carrying a full snapshot                                                         |
| `sse_state_update_delta.json` | The `state-update` SSE frame carrying a delta, including pane/window removals and sparse content              |
| `sse_frames.json`             | Every other SSE frame, one per `SseEvent` variant                                                             |
| `command_errors.json`         | The `/commands` error bodies a client has to render                                                           |

Each state and delta populates **every** field, so nothing is skipped by
`skip_serializing_if` and hidden from the decoder.

## Who reads them

- **Rust** (`packages/tmuxy-server/src/sse.rs`, `mod protocol_fixtures`) asserts
  the committed file is byte-for-byte what the live types emit today. A Rust
  field renamed, added or removed turns `cargo test` red.
- **TypeScript** (`packages/tmuxy-ui/src/tmux/__tests__/protocolFixtures.test.ts`)
  decodes the same files through the Effect schemas and `deltaProtocol`, and
  asserts no key in a fixture is dropped on the way through. A field the Rust
  side sends and the schema does not model turns `vitest` red.

## Regenerating

```sh
UPDATE_PROTOCOL_FIXTURES=1 cargo test -p tmuxy-server protocol_fixtures
```

Review the diff: a change here is a wire-format change, and the TypeScript side
has to be updated in the same commit.

The `.json` files are **generated**: they are written by `serde_json`'s
pretty-printer and compared byte for byte. Do not run a formatter over them —
reflowing so much as an empty array turns the Rust test red. Only the
regeneration command above should ever change them.
