// ansi-to-react 6.2.6 publishes `exports.default`, not `module.exports`.
// Resolve its public CommonJS entry here so ESM callers receive the component
// consistently in Vite 8 and Node. No runtime shape guessing is needed.
module.exports = require("ansi-to-react").default;
