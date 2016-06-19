var {promisify} = require('bluebird');
var resolve     = require('resolve');

const resolveP = promisify(resolve);

const load = file =>
  resolveP(file, {basedir: process.cwd()})
    .then(path => {
      delete require.cache[path];
      return require(path);
    });

module.exports = {load};
