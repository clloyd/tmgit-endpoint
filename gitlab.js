var exec = require('child_process').exec;
var fs = require('graceful-fs');
var path = require('path');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var request = require('request');

var Promise = require('rsvp').Promise;
var asp = require('rsvp').denodeify;

var tar = require('tar');
var zlib = require('zlib');

var DecompressZip = require('decompress-zip');

var semver = require('semver');

var which = require('which');



var GitlabLocation = function(options, ui) {

  // ensure git is installed
  try {
    which.sync('git');
  }
  catch(ex) {
    throw 'Git not installed. You can install git from `http://git-scm.com/downloads`.'
  }

  this.name = options.name;

  this.max_repo_size = (options.maxRepoSize || 100) * 1024 * 1024;

  this.execOpt = {
    cwd: options.tmpDir,
    timeout: options.timeout * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: this.max_repo_size
  };

  this.remoteString = "http://git.tm.tmcs"

}

function clearDir(dir) {
  return new Promise(function(resolve, reject) {
    fs.exists(dir, function(exists) {
      resolve(exists);
    });
  })
  .then(function(exists) {
    if (exists)
      return asp(rimraf)(dir);
  });
}

function prepDir(dir) {
  return clearDir(dir)
  .then(function() {
    return asp(mkdirp)(dir);
  });
}

// check if the given directory contains one directory only
// so that when we unzip, we should use the inner directory as
// the directory
function checkStripDir(dir) {
  return asp(fs.readdir)(dir)
  .then(function(files) {
    if (files.length > 1)
      return dir;

    var dirPath = path.resolve(dir, files[0]);

    return asp(fs.stat)(dirPath)
    .then(function(stat) {
      if (stat.isDirectory())
        return dirPath;

      return dir;
    });
  });
}


// static configuration function
GitlabLocation.configure = function(config, ui) {

}

GitlabLocation.prototype = {

  parse: function(name) {
    var parts = name.split('/');
    var packageName = parts.splice(0, 2).join('/');
    return {
      package: packageName,
      path: parts.join('/')
    };
  },

  // given a repo name, locate it and ensure it exists
  locate: function(repo) {
    var self = this;
    var remoteString = this.remoteString;
    // request the repo to check that it isn't a redirect
    return new Promise(function(resolve, reject) {
      request({
        uri: remoteString + repo,
        headers: {
          'User-Agent': 'jspm'
        },
        followRedirect: false
      })
      .on('response', function(res) {
        // redirect
        if (res.statusCode == 301)
          resolve({ redirect: self.name + ':' + res.headers.location.split('/').splice(3).join('/') });

        if (res.statusCode == 401)
          reject('Invalid authentication details. Run %jspm endpoint config ' + self.name + '% to reconfigure.');

        // it might be a private repo, so wait for the lookup to fail as well
        if (res.statusCode == 404 || res.statusCode == 200 || res.statusCode === 302)
          resolve();

        reject(new Error('Invalid status code ' + res.statusCode + '\n' + JSON.stringify(res.headers, null, 2)));
      })
      .on('error', reject);
    });
  },

  // return values
  // { versions: { versionhash } }
  // { notfound: true }
  lookup: function(repo) {
    var execOpt = this.execOpt;
    var remoteString = this.remoteString;
    return new Promise(function(resolve, reject) {
      exec('git ls-remote ' + remoteString + repo + '.git refs/tags/* refs/heads/*', execOpt, function(err, stdout, stderr) {
        if (err) {
          if ((err + '').indexOf('not found') == -1)
            // dont show plain text passwords in error
            reject(stderr.toString().replace(remoteString, ''));
          else
            resolve({ notfound: true });
        }

        versions = {};
        var refs = stdout.split('\n');
        for (var i = 0; i < refs.length; i++) {
          if (!refs[i])
            continue;

          var hash = refs[i].substr(0, refs[i].indexOf('\t'));
          var refName = refs[i].substr(hash.length + 1);
          var version;
          var versionObj = { hash: hash, meta: {} };

          if (refName.substr(0, 11) == 'refs/heads/') {
            version = refName.substr(11);
            versionObj.stable = false;
          }

          else if (refName.substr(0, 10) == 'refs/tags/') {
            if (refName.substr(refName.length - 3, 3) == '^{}')
              version = refName.substr(10, refName.length - 13);
            else
              version = refName.substr(10);

            if (version.substr(0, 1) == 'v' && semver.valid(version.substr(1))) {
              version = version.substr(1);
              // note when we remove a "v" which versions we need to add it back to
              // to work out the tag version again
              versionObj.meta.vPrefix = true;
            }
          }

          versions[version] = versionObj;
        }

        resolve({ versions: versions });
      });
    });
  },

  // optional hook, allows for quicker dependency resolution
  // since download doesn't block dependencies
  getPackageConfig: function(repo, version, hash, meta) {
    if (meta.vPrefix)
      version = 'v' + version;

    return asp(request)({
      uri: this.apiRemoteString + 'repos/' + repo + '/contents/package.json',
      headers: {
        'User-Agent': 'jspm',
        'Accept': 'application/vnd.github.v3.raw'
      },
      qs: {
        ref: version
      }
    }).then(function(res) {
      var rateLimitResponse = checkRateLimit.call(this, res.headers);
      if (rateLimitResponse)
        return rateLimitResponse;

      if (res.statusCode == 404) {
        // it is quite valid for a repo not to have a package.json
        return {};
      }

      if (res.statusCode != 200)
        throw 'Unable to check repo package.json for release, status code ' + res.statusCode;

      var packageJSON;

      try {
        packageJSON = JSON.parse(res.body);
      }
      catch(e) {
        throw 'Error parsing package.json';
      }

      return packageJSON;
    });
  },

  download: function(repo, version, hash, meta, outDir) {
    if (meta.vPrefix)
      version = 'v' + version;

    var execOpt = this.execOpt;
    var max_repo_size = this.max_repo_size;
    var remoteString = this.remoteString;

    var self = this;

    return this.checkReleases(repo, version)
    .then(function(release) {
      if (!release)
        return true;

      // Download from the release archive
      return new Promise(function(resolve, reject) {
        var inPipe;

        if (release.type == 'tar') {
          inPipe = zlib.createGunzip()
          .pipe(tar.Extract({ path: outDir, strip: 1 }))
          .on('end', function() {
            resolve();
          })
          .on('error', reject);
        }
        else if (release.type == 'zip') {
          var tmpDir = path.resolve(execOpt.cwd, 'release-' + repo.replace('/', '#') + '-' + version);
          var tmpFile = tmpDir + '.' + release.type;

          var repoDir;

          inPipe = fs.createWriteStream(tmpFile)
          .on('finish', function() {
            new Promise(function(resolve, reject) {

              var unzipper = new DecompressZip(tmpFile);

              unzipper.on('error', reject);
              unzipper.on('extract', resolve);

              unzipper.extract({
                path: tmpDir
              });

            })
            .then(function() {
             return checkStripDir(tmpDir);
            })
            .then(function(_repoDir) {
              repoDir = _repoDir;
              return asp(fs.rmdir)(outDir);
            })
            .then(function() {
              return asp(fs.rename)(repoDir, outDir);
            })
            .then(function() {
              return asp(fs.unlink)(tmpFile);
            })
            .then(resolve, reject);
          })
          .on('error', reject);
        }
        else {
          throw 'GitHub release found, but no archive present.';
        }

        // now that the inPipe is ready, do the request
        request({
          uri: release.url,
          headers: {
            'accept': 'application/octet-stream',
            'user-agent': 'jspm'
          },
          followRedirect: false,
          auth: self.auth && {
            user: self.auth.username,
            pass: self.auth.password
          }
        }).on('response', function(archiveRes) {
          var rateLimitResponse = checkRateLimit.call(this, archiveRes.headers);
          if (rateLimitResponse)
            return rateLimitResponse.then(resolve, reject);

          if (archiveRes.statusCode != 302)
            return reject('Bad response code ' + archiveRes.statusCode + '\n' + JSON.stringify(archiveRes.headers));

          request({
            uri: archiveRes.headers.location,
            headers: {
              'accept': 'application/octet-stream',
              'user-agent': 'jspm'
            }
          })
          .on('response', function(archiveRes) {

            if (archiveRes.headers['content-length'] > max_repo_size)
              return reject('Response too large.');

            archiveRes.pause();

            archiveRes.pipe(inPipe);

            archiveRes.on('error', reject);

            archiveRes.resume();

          })
          .on('error', reject);
        })
        .on('error', reject);
      });
    })
    .then(function(git) {
      if (!git)
        return;

      // Download from the git archive
      return new Promise(function(resolve, reject) {
        request({
          uri: remoteString + repo + '/archive/' + version + '.tar.gz',
          headers: { 'accept': 'application/octet-stream' }
        })
        .on('response', function(pkgRes) {
          if (pkgRes.statusCode != 200)
            return reject('Bad response code ' + pkgRes.statusCode);

          if (pkgRes.headers['content-length'] > max_repo_size)
            return reject('Response too large.');

          pkgRes.pause();

          var gzip = zlib.createGunzip();

          pkgRes
          .pipe(gzip)
          .pipe(tar.Extract({ path: outDir, strip: 1 }))
          .on('error', reject)
          .on('end', resolve);

          pkgRes.resume();

        })
        .on('error', reject);
      });
    });
  },

  checkReleases: function(repo, version) {
    // NB cache this on disk with etags
    var reqOptions = {
      uri: this.apiRemoteString + 'repos/' + repo + '/releases',
      headers: {
        'User-Agent': 'jspm',
        'Accept': 'application/vnd.github.v3+json'
      },
      followRedirect: false
    };

    return asp(request)(reqOptions)
    .then(function(res) {
      var rateLimitResponse = checkRateLimit.call(this, res.headers);
      if (rateLimitResponse)
        return rateLimitResponse;

      return Promise.resolve()
      .then(function() {
        try {
          return JSON.parse(res.body);
        }
        catch(e) {
          throw 'Unable to parse GitHub API response';
        }
      })
      .then(function(releases) {
        // run through releases list to see if we have this version tag
        for (var i = 0; i < releases.length; i++) {
          var tagName = releases[i].tag_name.trim();

          if (tagName == version) {
            var firstAsset = releases[i].assets[0];
            if (!firstAsset)
              return false;

            var assetType;

            if (firstAsset.name.substr(firstAsset.name.length - 7, 7) == '.tar.gz' || firstAsset.name.substr(firstAsset.name.length - 4, 4) == '.tgz')
              assetType = 'tar';
            else if (firstAsset.name.substr(firstAsset.name.length - 4, 4) == '.zip')
              assetType = 'zip';
            else
              return false;

            return { url: firstAsset.url, type: assetType };
          }
        }
        return false;
      });
    });
  }

};

module.exports = GithubLocation;
