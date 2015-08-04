require('../../tool-env/install-babel.js');

var _ = require('underscore');
var assert = require('assert');
var Fiber = require('fibers');
var files = require('../../fs/files.js');
var bundler = require('../../isobuild/bundler.js');
var release = require('../../packaging/release.js');
var catalog = require('../../catalog/catalog.js');
var buildmessage = require('../../buildmessage.js');
var meteorNpm = require('../../isobuild/meteor-npm.js');
var isopackets = require('../../tool-env/isopackets.js');
var projectContextModule = require('../../project-context.js');

var lastTmpDir = null;
var tmpDir = function () {
  return (lastTmpDir = files.mkdtemp());
};

var makeProjectContext = function (appName) {
  var projectDir = files.mkdtemp("test-bundler-assets");
  files.cp_r(files.pathJoin(files.convertToStandardPath(__dirname), appName),
    projectDir);
  var projectContext = new projectContextModule.ProjectContext({
    projectDir: projectDir
  });
  doOrThrow(function () {
    projectContext.prepareProjectForBuild();
  });

  return projectContext;
};

var doOrThrow = function (f) {
  var ret;
  var messages = buildmessage.capture(function () {
    ret = f();
  });
  if (messages.hasMessages()) {
    throw Error(messages.formatMessages());
  }
  return ret;
};

var getTestPackageDir = function (projectContext) {
  return files.pathJoin(projectContext.projectDir, 'packages', 'test-package');
};

var reloadPackages = function (projectContext) {
  projectContext.reset();
  doOrThrow(function () {
    projectContext.prepareProjectForBuild();
  });
};

var updateTestPackage = function (projectContext, npmDependencies, options) {
  options = options || {};
  files.writeFile(
    files.pathJoin(getTestPackageDir(projectContext), 'package.js'),
    "Package.describe({version: '1.0.0'});\n"
      + "\n"
      + "Npm.depends(" + JSON.stringify(npmDependencies) + ");"
      + "\n"
      + "Package.onUse(function (api) { api.addFiles('dummy.js', 'server'); });");
  if (! options.noReload)
    reloadPackages(projectContext);
};

///
/// HELPERS
///

var _assertCorrectPackageNpmDir = function (projectContext, deps) {
  // test-package/.npm was generated

  // sort of a weird way to do it, but i don't want to have to look up
  // all subdependencies to write these tests, so just transplant that
  // information
  var actualMeteorNpmShrinkwrapDependencies = JSON.parse(
    files.readFile(files.pathJoin(getTestPackageDir(projectContext), ".npm",
                                  "package", "npm-shrinkwrap.json"),
                    'utf8')).dependencies;
  var expectedMeteorNpmShrinkwrapDependencies = _.object(_.map(deps, function (version, name) {
    var expected = {};
    if (/tarball/.test(version)) {
      expected.from = version;
    } else {
      expected.version = version;
    }

    // copy fields with values generated by shrinkwrap that can't be
    // known to the test author. We set keys on val always in this
    // order so that comparison works well.
    var val = {};
    _.each(['version', 'dependencies'], function (key) {
      if (expected[key])
        val[key] = expected[key];
      else if (actualMeteorNpmShrinkwrapDependencies[name] && actualMeteorNpmShrinkwrapDependencies[name][key])
        val[key] = actualMeteorNpmShrinkwrapDependencies[name][key];
    });

    return [name, val];
  }));

  var testPackageDir = getTestPackageDir(projectContext);
  var actual = files.readFile(files.pathJoin(testPackageDir, ".npm", "package", "npm-shrinkwrap.json"), 'utf8');
  var expected = JSON.stringify({
    dependencies: expectedMeteorNpmShrinkwrapDependencies}, null, /*indentation, the way npm does it*/2) + '\n';

  assert.equal(actual, expected, actual + " == " + expected);

  assert.equal(
    files.readFile(files.pathJoin(testPackageDir, ".npm", "package", ".gitignore"), 'utf8'),
    "node_modules\n");
  assert(files.exists(files.pathJoin(testPackageDir, ".npm", "package", "README")));

  // verify the contents of the `node_modules` dir
  var nodeModulesDir = files.pathJoin(testPackageDir, ".npm", "package", "node_modules");

  // all expected dependencies are installed correctly, with the correct version
  _.each(deps, function (version, name) {
    assert(looksInstalled(nodeModulesDir, name));

    if (!/tarball/.test(version)) { // 'version' in package.json from a tarball won't be correct
      assert.equal(JSON.parse(
        files.readFile(
          files.pathJoin(nodeModulesDir, name, "package.json"),
          'utf8')).version,
        version);
    }
  });

  // all installed dependencies were expected to be found there,
  // meaning we correctly removed unused node_modules directories
  _.each(
    files.readdir(nodeModulesDir),
    function (installedNodeModule) {
      if (files.exists(files.pathJoin(nodeModulesDir, installedNodeModule, "package.json")))
        assert(installedNodeModule in deps);
    });
};

var _assertCorrectBundleNpmContents = function (bundleDir, deps) {
  // sanity check -- main.js has expected contents.
  assert.strictEqual(files.readFile(files.pathJoin(bundleDir, "main.js"), "utf8"),
                     bundler._mainJsContents);

  var bundledPackageNodeModulesDir = files.pathJoin(
    bundleDir, 'programs', 'server', 'npm', 'test-package', 'node_modules');

  // bundle actually has the npm modules
  _.each(deps, function (version, name) {
    assert(looksInstalled(bundledPackageNodeModulesDir, name));

    if (!/tarball/.test(version)) { // 'version' in package.json from a tarball won't be correct
      assert.equal(JSON.parse(
        files.readFile(files.pathJoin(bundledPackageNodeModulesDir, name, 'package.json'), 'utf8'))
                   .version,
                   version);
    }
  });
};

var looksInstalled = function (nodeModulesDir, name) {
  // All of the packages in this test have one of these two files, so presumably
  // if one of these files is here we have correctly installed the package.
  return files.exists(files.pathJoin(nodeModulesDir, name, 'README.md')) ||
    files.exists(files.pathJoin(nodeModulesDir, name, 'LICENSE'));
};

///
/// TESTS
///

var runTest = function () {
  // As preparation, we need to initialize the official catalog, which serves as
  // our sql data store.
  catalog.official.initialize();

  var projectContext = makeProjectContext('app-with-package');
  var testPackageDir = getTestPackageDir(projectContext);

  // XXX this is a huge nasty hack. see release.js,
  // #HandlePackageDirsDifferently
  console.log("app that uses gcd - clean run");
  assert.doesNotThrow(function () {
    updateTestPackage(projectContext, {gcd: '0.0.0'});
    var tmpOutputDir = tmpDir();
    var result = bundler.bundle({
      projectContext: projectContext,
      outputPath: tmpOutputDir
    });
    assert.strictEqual(result.errors, false, result.errors && result.errors[0]);
    _assertCorrectPackageNpmDir(projectContext, {gcd: '0.0.0'});
    _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0'});
  });

  console.log("app that uses gcd - no changes, running again");
  assert.doesNotThrow(function () {
    var tmpOutputDir = tmpDir();
    var result = bundler.bundle({
      projectContext: projectContext,
      outputPath: tmpOutputDir
    });
    assert.strictEqual(result.errors, false, result.errors && result.errors[0]);
    _assertCorrectPackageNpmDir(projectContext, {gcd: '0.0.0'});
    _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0'});
  });

  console.log("app that uses gcd - as would be in a 3rd party repository (no .npm/package/node_modules)");
  assert.doesNotThrow(function () {
    var tmpOutputDir = tmpDir();

    // rm -rf .npm
    var nodeModulesDir = files.pathJoin(testPackageDir, ".npm",
                                        "package", "node_modules");
    assert(files.exists(nodeModulesDir));
    files.rm_recursive(nodeModulesDir);
    // We also have to change something in the package or else we won't rebuild
    // at all.
    files.appendFile(files.pathJoin(testPackageDir, 'package.js'), '\n');
    reloadPackages(projectContext);

    // while bundling, verify that we don't call `npm install
    // name@version unnecessarily` -- calling `npm install` is enough,
    // and installing each package separately could unintentionally bump
    // subdependency versions. (to intentionally bump subdependencies,
    // just remove all of the .npm directory)
    var bareRunNpmCommand = meteorNpm.runNpmCommand;
    meteorNpm.runNpmCommand = function (file, args, opts) {
      if (args.length > 1 && args[0] === 'install')
        assert.fail("shouldn't be installing specific npm packages: " + args[1]);
      return bareRunNpmCommand(file, args, opts);
    };
    var result = bundler.bundle({
      projectContext: projectContext,
      outputPath: tmpOutputDir
    });
    meteorNpm.runNpmCommand = bareRunNpmCommand;

    assert.strictEqual(result.errors, false, result.errors && result.errors[0]);
    _assertCorrectPackageNpmDir(projectContext, {gcd: '0.0.0'});
    _assertCorrectBundleNpmContents(tmpOutputDir, {gcd: '0.0.0'});
  });

  console.log("app that uses gcd - add mime and semver");
  assert.doesNotThrow(function () {
    updateTestPackage(projectContext,
                      {gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
    var tmpOutputDir = tmpDir();
    var result = bundler.bundle({
      projectContext: projectContext,
      outputPath: tmpOutputDir
    });
    assert.strictEqual(result.errors, false, result.errors && result.errors[0]);
    _assertCorrectPackageNpmDir(
      projectContext, {gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
    _assertCorrectBundleNpmContents(
      tmpOutputDir, {gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
  });

  console.log("app that uses gcd - add mime, as it would happen if you pulled in this change (updated npm-shrinkwrap.json but not node_modules)");
  assert.doesNotThrow(function () {
    var tmpOutputDir = tmpDir();

    // rm -rf .npm/package/node_modules/mime
    var nodeModulesMimeDir = files.pathJoin(
      testPackageDir, ".npm", "package", "node_modules", "mime");
    assert(files.exists(files.pathJoin(nodeModulesMimeDir)));
    files.rm_recursive(nodeModulesMimeDir);
    // We also have to change something in the package or we won't rebuild at
    // all.
    files.appendFile(files.pathJoin(testPackageDir, 'package.js'), '\n');
    reloadPackages(projectContext);

    var result = bundler.bundle({
      projectContext: projectContext,
      outputPath: tmpOutputDir
    });
    assert.strictEqual(result.errors, false, result.errors && result.errors[0]);
    _assertCorrectPackageNpmDir(
      projectContext, {gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
    _assertCorrectBundleNpmContents(
      tmpOutputDir, {gcd: '0.0.0', mime: '1.2.7', semver: '1.1.0'});
  });

  console.log("app that uses gcd - upgrade mime, remove semver");
  assert.doesNotThrow(function () {
    updateTestPackage(projectContext, {gcd: '0.0.0', mime: '1.2.8'});
    var tmpOutputDir = tmpDir();
    var result = bundler.bundle({
      projectContext: projectContext,
      outputPath: tmpOutputDir
    });
    assert.strictEqual(result.errors, false, result.errors && result.errors[0]);
    _assertCorrectPackageNpmDir(projectContext, {gcd: '0.0.0', mime: '1.2.8'});
    _assertCorrectBundleNpmContents(
      tmpOutputDir, {gcd: '0.0.0', mime: '1.2.8'});
  });

  console.log("app that uses gcd - try downgrading mime to non-existant version");
  assert.doesNotThrow(function () {
    updateTestPackage(
      projectContext, {gcd: '0.0.0', mime: '0.1.2'}, {noReload: true});
    projectContext.reset();
    var messages = buildmessage.capture(function () {
      projectContext.prepareProjectForBuild();
    });
    assert(messages.hasMessages());
    var job = _.find(messages.jobs, function (job) {
      return job.title === "building package test-package";
    });
    assert(job);
    assert(/mime version 0.1.2 is not available/.test(job.messages[0].message));
    _assertCorrectPackageNpmDir(
      projectContext, {gcd: '0.0.0', mime: '1.2.8'}); // shouldn't've changed
  });

  console.log("app that uses gcd - downgrade mime to an existant version");
  assert.doesNotThrow(function () {
    updateTestPackage(projectContext, {gcd: '0.0.0', mime: '1.2.7'});
    var tmpOutputDir = tmpDir();
    var result = bundler.bundle({
      projectContext: projectContext,
      outputPath: tmpOutputDir
    });
    assert.strictEqual(result.errors, false, result.errors && result.errors[0]);

    _assertCorrectPackageNpmDir(projectContext, {gcd: '0.0.0', mime: '1.2.7'});
    _assertCorrectBundleNpmContents(
      tmpOutputDir, {gcd: '0.0.0', mime: '1.2.7'});
  });

  console.log("app that uses gcd - install gzippo via tarball");
  assert.doesNotThrow(function () {
    var deps = {gzippo: 'https://github.com/meteor/gzippo/tarball/1e4b955439abc643879ae264b28a761521818f3b'};
    updateTestPackage(projectContext, deps);
    var tmpOutputDir = tmpDir();
    var result = bundler.bundle({
      projectContext: projectContext,
      outputPath: tmpOutputDir
    });
    assert.strictEqual(result.errors, false, result.errors && result.errors[0]);
    _assertCorrectPackageNpmDir(projectContext, deps);
    _assertCorrectBundleNpmContents(tmpOutputDir, deps);
    // Check that a string introduced by our fork is in the source.
    assert(/clientMaxAge = 604800000/.test(
      files.readFile(
        files.pathJoin(testPackageDir, ".npm", "package", "node_modules",
                       "gzippo", "lib", "staticGzip.js"), "utf8")));
  });
};


Fiber(function () {
  if (! files.inCheckout()) {
    throw Error("This old test doesn't support non-checkout");
  }

  meteorNpm._printNpmCalls = true;

  try {
    release.setCurrent(release.load(null));
    isopackets.ensureIsopacketsLoadable();
    runTest();
  } catch (err) {
    console.log(err.stack);
    console.log('\nBundle can be found at ' + lastTmpDir);
    process.exit(1);
  }
}).run();
