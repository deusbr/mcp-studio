'use strict';

module.exports = {
  ...require('./lib/blueprints.cjs'),
  ...require('./lib/generator.cjs'),
  ...require('./lib/prober.cjs'),
  ...require('./lib/store.cjs'),
  ...require('./lib/installers.cjs'),
  ...require('./lib/studio-web.cjs')
};
