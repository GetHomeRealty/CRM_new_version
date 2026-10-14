'use strict';

// Local hard limit: cannot be raised by caller options.
const MAX_DEPTH = 128;
const assertDepth = depth => {
  if (depth > MAX_DEPTH) throw new SyntaxError('Brace AST nesting exceeds security limit (128)');
};
module.exports = { assertDepth };
