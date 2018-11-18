/**
 * Copyright 2016, Google, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const async = require('async');
const fs = require('fs');
const path = require('path');

// By default, the client will authenticate using the service account file
// specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable and use
// the project specified by the GCLOUD_PROJECT environment variable. See
// https://googlecloudplatform.github.io/gcloud-node/#/docs/google-cloud/latest/guides/authentication
const vision = require('@google-cloud/vision');
const natural = require('natural');
const redis = require('redis');

// Instantiate a vision client
const client = new vision.ImageAnnotatorClient();

function Index() {
  // Connect to a redis server.
  const TOKEN_DB = 0;
  const DOCS_DB = 1;
  const PORT = process.env.REDIS_PORT || '6379';
  const HOST = process.env.REDIS_HOST || '127.0.0.1';

  this.tokenClient = redis
    .createClient(PORT, HOST, {
      db: TOKEN_DB,
    })
    .on('error', function(err) {
      console.error('ERR:REDIS: ' + err);
    });
  this.docsClient = redis
    .createClient(PORT, HOST, {
      db: DOCS_DB,
    })
    .on('error', function(err) {
      console.error('ERR:REDIS: ' + err);
    });
}

Index.prototype.quit = function() {
  this.tokenClient.quit();
  this.docsClient.quit();
};

Index.prototype.add = function(filename, document, callback) {
  const self = this;
  const PUNCTUATION = ['.', ',', ':', ''];
  const tokenizer = new natural.WordTokenizer();
  const tokens = tokenizer.tokenize(document);

  const tasks = tokens
    .filter(function(token) {
      return PUNCTUATION.indexOf(token) === -1;
    })
    .map(function(token) {
      return function(cb) {
        self.tokenClient.sadd(token, filename, cb);
      };
    });

  tasks.push(function(cb) {
    self.tokenClient.set(filename, document, cb);
  });

  async.parallel(tasks, callback);
};

Index.prototype.lookup = function(words, callback) {
  const self = this;
  const tasks = words.map(function(word) {
    word = word.toLowerCase();
    return function(cb) {
      self.tokenClient.smembers(word, cb);
    };
  });
  async.parallel(tasks, callback);
};

Index.prototype.documentIsProcessed = function(filename, callback) {
  this.docsClient.GET(filename, function(err, value) {
    if (err) {
      return callback(err);
    }
    if (value) {
      console.log(filename + ' already added to index.');
      callback(null, true);
    } else if (value === '') {
      console.log(filename + ' was already checked, and contains no text.');
      callback(null, true);
    } else {
      callback(null, false);
    }
  });
};

Index.prototype.setContainsNoText = function(filename, callback) {
  this.docsClient.set(filename, '', callback);
};

function lookup(words) {
  return new Promise((resolve, reject) => {
    const index = new Index();
    index.lookup(words, function(err, hits) {
      index.quit();
      if (err) {
        return reject(err);
      }
      words.forEach(function(word, i) {
        console.log('hits for "' + word + '":', hits[i].join(', '));
      });
      resolve(hits);
    });
  });
}

function extractDescription(texts) {
  let document = '';
  texts.forEach(function(text) {
    document += text.description || '';
  });
  return document;
}

function extractDescriptions(filename, index, response, callback) {
  if (response.textAnnotations.length) {
    index.add(filename, extractDescription(response.textAnnotations), callback);
  } else {
    console.log(filename + ' had no discernable text.');
    index.setContainsNoText(filename, callback);
  }
}

function getTextFromFiles(index, inputFiles, callback) {
  // Make a call to the Vision API to detect text
  const requests = [];
  inputFiles.forEach(filename => {
    const request = {
      image: {content: fs.readFileSync(filename).toString('base64')},
      features: [{type: 'TEXT_DETECTION'}],
    };
    requests.push(request);
  });
  client
    .batchAnnotateImages({requests: requests})
    .then(results => {
      const detections = results[0].responses;
      const textResponse = {};
      const tasks = [];
      inputFiles.forEach(function(filename, i) {
        const response = detections[i];
        if (response.error) {
          console.log('API Error for ' + filename, response.error);
          return;
        } else if (Array.isArray(response)) {
          textResponse[filename] = 1;
        } else {
          textResponse[filename] = 0;
        }
        tasks.push(function(cb) {
          extractDescriptions(filename, index, response, cb);
        });
      });
      async.parallel(tasks, function(err) {
        if (err) {
          return callback(err);
        }
        callback(null, textResponse);
      });
    })
    .catch(callback);
}

// Run the example
function main(inputDir) {
  return new Promise((resolve, reject) => {
    const index = new Index();

    async.waterfall(
      [
        // Scan the specified directory for files
        function(cb) {
          fs.readdir(inputDir, cb);
        },
        // Separate directories from files
        function(files, cb) {
          async.parallel(
            files.map(function(file) {
              const filename = path.join(inputDir, file);
              return function(cb) {
                fs.stat(filename, function(err, stats) {
                  if (err) {
                    return cb(err);
                  }
                  if (!stats.isDirectory()) {
                    return cb(null, filename);
                  }
                  cb();
                });
              };
            }),
            cb
          );
        },
        // Figure out which files have already been processed
        function(allImageFiles, cb) {
          const tasks = allImageFiles
            .filter(function(filename) {
              return filename;
            })
            .map(function(filename) {
              return function(cb) {
                index.documentIsProcessed(filename, function(err, processed) {
                  if (err) {
                    return cb(err);
                  }
                  if (!processed) {
                    // Forward this filename on for further processing
                    return cb(null, filename);
                  }
                  cb();
                });
              };
            });
          async.parallel(tasks, cb);
        },
        // Analyze any remaining unprocessed files
        function(imageFilesToProcess, cb) {
          imageFilesToProcess = imageFilesToProcess.filter(function(filename) {
            return filename;
          });
          if (imageFilesToProcess.length) {
            return getTextFromFiles(index, imageFilesToProcess, cb);
          }
          console.log('All files processed!');
          cb();
        },
      ],
      function(err, result) {
        index.quit();
        if (err) {
          return reject(err);
        }
        resolve(result);
      }
    );
  });
}

if (module === require.main) {
  const generalError =
    'Usage: node textDetection <command> <arg> ...\n\n' +
    '\tCommands: analyze, lookup';
  if (process.argv.length < 3) {
    console.log(generalError);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command === 'analyze') {
    if (!args.length) {
      console.log('Usage: node textDetection analyze <dir>');
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    }
    main(args[0], console.log);
  } else if (command === 'lookup') {
    if (!args.length) {
      console.log('Usage: node textDetection lookup <word> ...');
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    }
    lookup(args, console.log);
  } else {
    console.log(generalError);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
}

exports.Index = Index;
exports.lookup = lookup;
exports.getTextFromFiles = getTextFromFiles;
exports.main = main;
