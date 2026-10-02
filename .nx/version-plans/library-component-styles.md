---
__default__: patch
---

`withAngularNative` takes `libraryStyles`, a list of npm packages whose components' CSS is compiled into native sheets as the app's own is. A component library from npm otherwise draws with no styles and no warning, because its CSS goes through the linker, which nothing compiles.
