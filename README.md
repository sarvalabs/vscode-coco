# Cocolang for Visual Studio Code

[latestrelease]: https://github.com/sarvalabs/vscode-coco/releases/latest
[issueslink]: https://github.com/sarvalabs/vscode-coco/issues
[marketplace]: https://marketplace.visualstudio.com/items?itemName=sarvalabs.cocolang

[![license](https://img.shields.io/badge/license-MIT-informational?style=for-the-badge)](./LICENSE)
[![latest tag](https://img.shields.io/github/v/tag/sarvalabs/vscode-coco?color=blue&label=latest%20tag&sort=semver&style=for-the-badge)][latestrelease]
![minver_vscode](https://img.shields.io/badge/vs_code-^v0.1.59-informational?style=for-the-badge&color=purple)
[![issue count](https://img.shields.io/github/issues/sarvalabs/vscode-coco?style=for-the-badge&color=yellow)][issueslink]

The VS Code Cocolang extension provides syntax highlighting for the [Coco programming language](http://cocolang.dev).

### Compatibility 
- v0.2.4 or greater is required for `cocolang@v0.4.0`

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


### Feedback and Issues
If you encounter any issues with the Cocolang extension or have suggestions for improvements, please 
check the extension's [GitHub repository](https://github.com/sarvalabs/vscode-coco) for issue tracking.
You can open a new issue to report problems or submit feature requests.
