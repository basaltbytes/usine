# create-usine

## 0.7.0

### Patch Changes

- Updated dependencies [f8f311c]
- Updated dependencies [2b3ac6b]
- Updated dependencies [095438d]
- Updated dependencies [6aa5e72]
- Updated dependencies [539349e]
- Updated dependencies [bfa02ef]
- Updated dependencies [c8ea557]
- Updated dependencies [589ad7b]
- Updated dependencies [e828b51]
- Updated dependencies [d7e00bc]
- Updated dependencies [64afcbb]
- Updated dependencies [fd52df7]
- Updated dependencies [e8003db]
- Updated dependencies [c8241d7]
- Updated dependencies [2a76a52]
- Updated dependencies [360d371]
- Updated dependencies [2882f71]
- Updated dependencies [fa97db3]
- Updated dependencies [c7bd772]
- Updated dependencies [c7f39bc]
- Updated dependencies [324bfed]
- Updated dependencies [738c15c]
- Updated dependencies [1eddd3d]
- Updated dependencies [4aebd77]
  - @usine/core@0.8.0

## 0.6.0

### Minor Changes

- c80354d: Create a runtime folder with `npm create usine@latest <folder>` or `pnpm create usine <folder>`. Install an exact-pinned server with a lockfile and a commented environment template, then start GitHub App setup with the local `usine up` command. Linux service startup accepts folders without a bootstrap configuration file.

### Patch Changes

- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- 8d28709: Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.
  
  Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
- 8412ddc: Use Effect services for platform operations and deterministic service keys. Report worker JSON encoding failures as defects and preserve synchronous formatting and validation boundaries. Gateway composition supplies Crypto for auth-file names. Check all configured Effect diagnostics directly with the patched compiler.
- Updated dependencies [6a1cf79]
- Updated dependencies [e0cedc8]
- Updated dependencies [6e60662]
- Updated dependencies [01467e3]
- Updated dependencies [a1c0d36]
- Updated dependencies [e007d09]
- Updated dependencies [9290433]
- Updated dependencies [1c981c9]
- Updated dependencies [82b55aa]
- Updated dependencies [9786f67]
- Updated dependencies [7e5bb5b]
- Updated dependencies [d740598]
- Updated dependencies [bb96f16]
- Updated dependencies [4f87593]
- Updated dependencies [77ede43]
- Updated dependencies [6316707]
- Updated dependencies [5796627]
- Updated dependencies [4d60236]
- Updated dependencies [9476883]
- Updated dependencies [10154eb]
- Updated dependencies [7c58461]
- Updated dependencies [1948b10]
- Updated dependencies [9cf0b5e]
- Updated dependencies [9e30c8c]
- Updated dependencies [69ba086]
- Updated dependencies [8412ddc]
- Updated dependencies [d0900a3]
- Updated dependencies [81330c9]
- Updated dependencies [0e34ec1]
- Updated dependencies [d0900a3]
  - @usine/core@0.7.0
