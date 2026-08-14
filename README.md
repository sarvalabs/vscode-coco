# Coco Programming Language for Visual Studio Code

[latestrelease]: https://github.com/sarvalabs/vscode-coco/releases/latest
[issueslink]: https://github.com/sarvalabs/vscode-coco/issues
[marketplace]: https://marketplace.visualstudio.com/items?itemName=sarvalabs.cocolang

[![license](https://img.shields.io/badge/license-MIT-informational?style=for-the-badge)](./LICENSE)
[![latest tag](https://img.shields.io/github/v/tag/sarvalabs/vscode-coco?color=blue&label=latest%20tag&sort=semver&style=for-the-badge)][latestrelease]
![minver_vscode](https://img.shields.io/badge/vs_code-^1.91.0-informational?style=for-the-badge&color=purple)
[![issue count](https://img.shields.io/github/issues/sarvalabs/vscode-coco?style=for-the-badge&color=yellow)][issueslink]

The VS Code Coco Programming Language extension provides language support for the [Coco programming language](http://cocolang.dev), including syntax highlighting, real-time error diagnostics, Go to Definition and context-aware completion.

### Compatibility

**v0.4.0 targets Coco `0.9.0` with PISA `0.8.0`** — what `coco nut init` writes and what
new projects use. The pre-0.6 vocabulary (`persistent` / `ephemeral` / `readonly`
qualifiers, `state persistent:` blocks, the `Receiver` and `State` superglobals) is no
longer supported; sources still written that way get highlighting for the parts they share
with 0.9.0 and no diagnostics.

Within the modern syntax the extension still respects your target: the checks that depend
on it read `[target.pisa] version` from the `coco.nut` next to your source, so a `0.7.1`
project is told that `payer`, `Environment.StorageResult()` and the actor methods are not
available to it, and is not told that `Environment.VolumeAvailable()` has gone. With no
`coco.nut` in the directory the extension assumes `0.8.0`.

### What it checks

The language server reads your whole module — every `.coco` file next to the one you are
editing that declares the same `coco <Module>` — plus its `coco.nut`, and reports:

| Area | Examples |
|------|----------|
| **State qualifiers** | `endpoint GetName()` that observes state must say `static`; an omitted qualifier means `pure`, not `static`. Requirements propagate through called functions, asset methods and cross-logic interface calls. |
| **`payer` clause** (PISA 0.8.0) | `mutate v -> M.Logic.f payer Logic \| Sender \| Actor(id)` — rejected on `observe`, on actor state, and on pre-0.8.0 targets. |
| **Actor methods** (PISA 0.8.0) | `Actor(id).Exists()`, `.HasSigned()`, `.Param(name String)` — unknown methods, wrong arity, wrong argument types. |
| **Environment** | `Environment.StorageResult(account, payer)` on 0.8.0; `VolumeCapacity()` / `VolumeAvailable()` flagged as removed there, and still accepted below it. |
| **Field-name shorthand** | `Person{name, age}` is understood; a bare name that is not a field of the class is reported. |
| **Reserved words** | `memory payer = ...` or an argument named `actor` is caught before the compiler's `Unrecognized token`. |
| **Atomic storage** | `mutate v -> M.Logic.someMap` is rejected — maps, arrays and classes in state can only be moved with a `mutate` block and `disperse`. |
| **Asset methods** | Names, arities and argument labels, checked against the compiler's own table (note there is no `asset.Define` — assets are created through Cocolab's `create`). |
| **Types and members** | class/event literal fields, field access, f-string expressions, `emit` payloads, state paths, undefined variables. |

### Supported files

| File | Language id | What you get |
|------|-------------|--------------|
| `*.coco` | `coco` | Syntax highlighting, diagnostics, Go to Definition, semantic tokens, completion |
| `coco.nut` / `*.nut` | `coco_nut` | Syntax highlighting for the project manifest |
| `*.lab` | `cocolab` | Syntax highlighting for Cocolab REPL scripts, including `grant`/`wipe`/`get storage_mutate` |

### Install from the Extension Marketplace
This extension can be installed from the Visual Studio Code Extension Marketplace [here][marketplace].

### Install from a VSIX
A `.vsix` files comes bundled with every release and can be downloaded from [here][latestrelease].  

Alternatively, it can be built from this repository source with the following command (requires NPM) 
resulting in the creation of a file named a file `coco-v*.*.*.vsix` with the release version.
```bash
npm run package
```

However, you obtain the `.vsix` file, it can then be used to install the extension to Visual Studio
Code using the following command. Read more [here](https://code.visualstudio.com/docs/editor/extension-marketplace#_install-from-a-vsix) 
for other ways to install from a VSIX 
```bash
code --install-extension coco.vsix
```


### Development

```bash
npm install             # one manifest, one lockfile, no nested workspaces
npm run typecheck       # tsc --noEmit over client/src and server/src
npm run bundle          # esbuild -> dist/extension.js + dist/server.js
npm run compile         # typecheck + bundle
npm run lint            # eslint, flat config in eslint.config.mjs
npm test                # run the fixtures through the bundled language server
npm run test:compile    # build every fixture project with the real `coco` compiler
npm run verify          # everything above, in order — what CI runs
npm run test:scan <dir> # scan an external tree of .coco files for false positives
npm run package         # cocolang-<version>.vsix
```

**esbuild produces what ships.** `dist/extension.js` and `dist/server.js` are the only two
JavaScript files in the `.vsix`; the LSP libraries are inlined and `vscode` is the sole
external. TypeScript is used for type checking only, which is why `npm test` runs against
`dist/server.js` — the suite exercises the artifact users install. Press <kbd>F5</kbd> to
launch a development window; the `watch` task runs esbuild and `tsc --watch` side by side.

The extension re-implements a slice of the compiler's checks in TypeScript, so the suite is
built around agreeing with `coco` rather than with itself:

| Fixture group | Contract |
|---------------|----------|
| `test/fixtures/valid/` | Every feature of Coco 0.9.0 / PISA 0.8.0, in its correct form. No diagnostics allowed. |
| `test/fixtures/corpus/` | Five complete modules of realistic Coco — a token ledger, a native asset, a CRUD registry, cross-logic interfaces and participant queries. No diagnostics allowed. |
| `test/fixtures/invalid/` | One mistake per file. Each `// EXPECT: <text>` must be matched by a diagnostic, and nothing else may be reported. |
| `test/fixtures/legacy/` | The same, against a `coco.nut` targeting PISA `0.7.1`, so the version gates are exercised in both directions. |

Every project under `valid/` and `corpus/` is compiled by `npm run test:compile`, which is
what keeps "the language server stays silent on this" honest. That step skips itself when
`coco` is not on `PATH`.

### Feedback and Issues
If you encounter any issues with the Coco Programming Language extension or have suggestions for improvements, please check the extension's [GitHub repository](https://github.com/sarvalabs/vscode-coco) for issue tracking.
You can open a new issue to report problems or submit feature requests.
