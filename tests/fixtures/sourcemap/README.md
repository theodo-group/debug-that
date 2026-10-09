Scripts that declare no source map, for the tests of `dbg sourcemap <script> --map` and `--pretty`:

- `app.js`: `tests/fixtures/ts/dist/app.js` without its `//# sourceMappingURL` comment. Its map is `tests/fixtures/ts/dist/app.js.map`.
- `app.min.js`: the same, minified (`bun build --minify --target node`).
