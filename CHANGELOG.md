## v0.4.0
Support for **Cocolang v0.9.0** targeting **PISA v0.8.0**.

### PISA target awareness
- The server now reads `[target.pisa] version` from the `coco.nut` next to the file being
  edited and gates every version-dependent check on it. Without a `coco.nut` it assumes
  `0.8.0`, which is what `coco nut init` writes.

### New language features
- **Field-name shorthand in class and event literals** — `Person{name, age}` is understood as
  `Person{name: name, age: age}`. A bare name that is not a field of the type is reported as
  `field '<name>' not found in <Type>`.
- **`payer` clause** — `mutate v -> M.Logic.f payer Logic | Sender | Actor(id)` is validated:
  rejected on `observe`, rejected on actor state (*payer can only be set on logic state*),
  and rejected on targets below PISA 0.8.0.
- **Actor methods** — `Actor(id).Exists()`, `.HasSigned()` and `.Param(name String)` are
  known, with unknown-method, arity and argument-type diagnostics, and version gating.
- **`Environment.StorageResult(account, payer)`** — the PISA 0.8.0 storage accounting call,
  including its two return values.
- **`Environment.VolumeCapacity()` / `VolumeAvailable()`** — reported as removed on a 0.8.0
  target, and still accepted on 0.7.1 and below.

### State qualifiers
- The qualifier a callable needs is now inferred from its body and compared to what it
  declares, matching the compiler's exact-match rule: `mutate` needs `dynamic`, `observe`
  needs `static`, and **an omitted qualifier means `pure`, not `static`**. The requirement
  is the maximum over the body's own state access, the asset methods it calls, the local
  functions it calls, and any cross-logic interface calls (`asset:` members always count as
  `dynamic`). `deploy` and `enlist` endpoints are exempt, and the check is skipped entirely
  on PISA 0.3.2, which predates the rule.

### Other diagnostics
- Reserved words used as a variable, argument, return value, field, topic or callable name
  are flagged, with a suggested alternative for the ones that read like ordinary names
  (`actor`, `payer`, `local`, `default`, `field`, `topic`, `method`, `state`, `logic`,
  `asset`).
- `Invocation` and `Builtins` members are validated, including the PISA 0.3.2-only
  `Invocation.Kind()`, `.FuelLimit()`, `.FuelPrice()` and `Environment.ClusterID()`.

### Editing experience
- **Context-aware completion** — typing after `Environment.`, `Invocation.`, `Builtins.`,
  `Actor(id).` or `asset.` offers that receiver's methods with signatures and
  documentation, filtered to what the target PISA version implements.
- New keyword completions: `pure`, `gather`, `disperse`, `yield`, `throw`, and the
  `Sender` / `Logic` / `Actor` / `Environment` / `Invocation` / `Builtins` superglobals.
- Superglobal and asset method names get their own highlighting scope.

### New file types
- **`coco.nut`** now has a working grammar. The `coco_nut` language previously pointed at a
  grammar whose scope name did not match, so `.nut` files were left unhighlighted.
- **`*.lab`** Cocolab REPL scripts are highlighted, including the access-control commands
  `grant` / `wipe` / `get storage_mutate` with their `callers(...)`, `origins(...)`,
  `through` and `as` clauses, and the `>` / `!>` output expectations used by lab test cases.

### Focused on Coco 0.9.0
- The pre-0.6 vocabulary is gone: the `persistent` / `ephemeral` / `readonly` endpoint and
  function qualifiers, `state persistent:` / `state ephemeral:` blocks, and the `Receiver`
  and `State` superglobals are no longer parsed, highlighted or offered in completion.
- `server/src/modules/validation.ts` is deleted. Its three checks only ever matched the
  pre-0.6 syntax and had been silent on modern sources for several releases.
- One of them described a rule that is still real, so it came back properly: writing a map,
  array or class in state as a whole (`mutate v -> M.Logic.records`) is reported, pointing
  at the `mutate` block plus `disperse` form instead.
- `endpoint asset Name()` is recognised — it is a state qualifier like `pure`/`static`/
  `dynamic`, and like `deploy` and `enlist` it is exempt from the qualifier requirement.
- `asset.Define()` is no longer accepted. It was removed from the compiler; an asset is
  created through Cocolab's `create` command.

### Testing
- `npm test` runs `test/fixtures/` through the language server. `valid/` and the new
  `corpus/` must stay diagnostic-free, while `invalid/` and `legacy/` assert on `// EXPECT:`
  annotations. The `legacy/` fixtures target PISA 0.7.1 so the version gates are exercised
  in both directions.
- `test/fixtures/corpus/` is five complete modules of realistic Coco 0.9.0 — a token ledger,
  a native asset, a CRUD registry, cross-logic interfaces and participant queries.
- `npm run test:compile` builds every fixture project with the real `coco` compiler, so
  "the language server stays silent on this" is backed by "and the compiler accepts it".
  It skips itself when `coco` is not on `PATH`.
- `npm run verify` chains compile, lint, fixtures and the compiler cross-check.
- `npm run test:scan <dir>` (was `test:corpus`) scans an external tree for false positives.
  It now requires an explicit path instead of defaulting to one developer's checkout.

### Build
- **The extension is bundled with esbuild.** The `.vsix` went from 461 files / 751 KB to
  16 files / 223 KB, and holds exactly two JavaScript files — `dist/extension.js` and
  `dist/server.js` — with the LSP libraries inlined and `vscode` as the only external.
- The nested `client/` and `server/` npm packages are gone. One manifest, one lockfile, no
  `postinstall` that shells into subdirectories, and one `tsconfig.json` that type-checks
  both halves without emitting.
- `npm test` now runs against `dist/server.js`, so the suite exercises the artifact that
  ships rather than a separate `tsc` output.
- Minimum VS Code is now `^1.91.0`, matching `vscode-languageclient` 10. Dependencies moved
  to `vscode-languageclient` / `vscode-languageserver` 10, `@types/vscode` 1.91,
  `@types/node` 24 and TypeScript 5.9; `engines.node` is `>=20`.
- `npm audit` reports zero vulnerabilities, including an override for the
  `brace-expansion` advisory reachable through `@vscode/vsce`.

### Repository
- ESLint actually runs: flat config in `eslint.config.mjs` on eslint 9 with
  typescript-eslint 8, covering both TypeScript halves and the test harnesses. `npm run
  lint` was previously broken — there was no configuration file at all.
- Dropped the unused `mocha` and `@types/mocha` dependencies and the superseded
  `@typescript-eslint/*` v5 packages.
- A CI workflow builds, lints, tests and packages on every push and pull request; the
  release workflow now runs the same checks before publishing.
- The root `tsconfig.json` is a proper solution file, and the client is `strict` like the
  server always was.
- The extension name is spelled "Coco Programming Language".
- The `.vsix` ships only `dist/`, `syntaxes/`, `languages/`, `icons/` and the three
  documentation files.

## v0.3.1
- Support for the `payer` keyword in `mutate` statements and validation of the actor in
  state references.
- Recognises the `coco asset` module form and the `append` / `popend` / `merge` builtins.

## v0.1.0
- Initial release of the **Coco Extension for Visual Studio Code**
- Adds support for **Cocolang v0.1.0 (alpha)** with simple syntax highlighting
