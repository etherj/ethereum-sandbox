var Ethereum = require('ethereumjs-lib');
var Transaction = Ethereum.Transaction;
var rlp = Ethereum.rlp;
var ethUtils = Ethereum.utils;
var async = require('async');
var SHA3Hash = require('sha3').SHA3Hash;
var _ = require('lodash');
var levelup = require('levelup');
var util = require('./util');

var Sandbox = {
  SHA3_RLP_NULL: '56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
  DEFAULT_TX_GAS_PRICE: 1000000,
  DEFAULT_TX_GAS_LIMIT: 100000,

  init: function() {
    this.coinbase = new Buffer('1337133713371337133713371337133713371337', 'hex');
    this.defaultAccount = null;
    this.transactions = [];
    this.contracts = {};
    this.filtersCounter = 0;
    this.filters = {};
    this.createVM();
    this.gasLimit = 3141592;
    return this;
  },
  createVM: function() {
    var blockDB = levelup('', { db: require('memdown') });
    var detailsDB = levelup('/does/not/matter', { db: require('memdown') });

    this.blockchain = new Ethereum.Blockchain(blockDB, detailsDB);
    
    this.vm = new Ethereum.VM(new Ethereum.Trie(), this.blockchain);
    
    this.vm.onStep = (function(info, done) {
      if (info.opcode === 'LOG') notify.call(this, info);
      done();
    }).bind(this);
    
    function notify(info) {
      var stack = info.stack.slice();
      info.account.getCode(this.vm.trie, (function(err, code) {
        if (code.length !== 0) {
          var topicNum = code.readUInt8(info.pc) - 0xa0;
          var offset = parseInt(stack.pop().toString('hex'), 16);
          var size = parseInt(stack.pop().toString('hex'), 16);
          var data = _(info.memory).slice(offset, offset + size)
                .chunk(32)
                .map(function(val) {
                  return val
                    .map(function(cell) {
                      return pad(cell.toString(16));
                    })
                    .join('');
                })
                .value();
          var topics = _.times(topicNum, function() {
            return '0x' + stack.pop().toString('hex');
          });
          var log = {
            logIndex: null,
            transactionIndex: null,
            transactionHash: null,
            blockHash: null,
            blockNumber: null,
            address: '0x' + info.address.toString('hex'),
            data: '0x' +  data.join(''),
            topics: topics
          };
          _.each(this.filters, function(filter) {
            if (filter.type === 'log') filter.entries.push(log);
          });
        }
      }).bind(this));
    }
  },
  setBlock: function(block) {
    this.block = new Ethereum.Block();
    if (block) {
      _.each([ 'coinbase', 'difficulty', 'gasLimit', 'number', 'timestamp' ],
             _.partial(setField, this.block.header, block));
    }
  },
  createAccounts: function(accounts, cb) {
    accounts = _.map(accounts, function(account, address) {
      account.address = address;
      return util.toBuffers(account, ['address', 'nonce', 'balance', 'code', 'pkey']);
    });
    this.accounts = _.transform(accounts, function(result, account) {
      result[account.address.toString('hex')] = account.hasOwnProperty('pkey') ?
        account.pkey : null;
    });

    async.each(accounts, processAccount.bind(this), (function(err) {
      if (err) this.stop(cb.bind(null, 'Could not create an account: ' + err));
      else {
        if (this.defaultAccount === null) {
          this.stop(cb.bind(null, 'Please, specify a default account in ethereum.json'));
        } else cb();
      }
    }).bind(this));

    function processAccount(options, cb) {
      if (options.default) {
        if (this.defaultAccount !== null)
          return cb('There is should be only one default account. Please, correct ethereum.json.');
        
        if (!options.hasOwnProperty('pkey'))
          return cb('Default account in ethereum.json should have a pkey.');
        
        this.defaultAccount = options.address;
      }
      this.createAccount(options, cb);
    }
  },
  stop: function(cb) {
    this.vm = null;
    this.blockchain = null;
    this.block = null;
    this.coinbase = null;
    this.defaultAccount = null;
    this.transactions = null;
    this.contracts = null;
    this.accounts = null;
    this.filters = null;
    this.filtersCounter = null;
    cb();
  },
  createAccount: function(options, cb) {
    var account = new Ethereum.Account(options);

    async.series([
      runCode.bind(this),
      storeCode.bind(this),
      saveStorage.bind(this),
      (function(cb) {
        this.vm.trie.put(options.address, account.serialize(), cb);
      }).bind(this)
    ], cb);

    function runCode(cb) {
      if (!options.hasOwnProperty('runCode')) return cb();
      if (!_.every(
        ['name', 'binary', 'abi'],
        options.runCode.hasOwnProperty.bind(options.runCode)
      )) return cb('Bad runCode field');
      
      var code = new Buffer(options.runCode.binary, 'hex');
      var from = new Buffer('1337133713371337133713371337133713371337', 'hex');
      this.vm.runCode({
        code: code,
        data: code,
        account: account,
        gasLimit: this.DEFAULT_TX_GAS_LIMIT,
        address: from,
        caller: from,
        block: this.createNextBlock()
      }, (function(err, result) {
        if (err) return cb(err);
        this.contracts[options.address.toString('hex')] = options.runCode;
        account.storeCode(this.vm.trie, result.returnValue, cb);
      }).bind(this));
    }
    function storeCode(cb) {
      if (!options.hasOwnProperty('code')) cb();
      else account.storeCode(this.vm.trie, options.code, cb);
    }
    function saveStorage(cb) {
      if (!options.hasOwnProperty('storage')) return cb();
      var strie = this.vm.trie.copy();
      strie.root = account.stateRoot;
      async.forEachOfSeries(
        options.storage,
        function(val, key, cb) {
          try {
            strie.put(
              createBuffer(key),
              rlp.encode(new Buffer(val, 'hex')),
              function(err) {
                account.stateRoot = strie.root;
                cb(err);
              }
            );
          } catch (e) {
            return cb('Could not parse storage entry: ' + e.message);
          }
        },
        cb
      );
    }
  },
  createTx: function(options) {
    var tx = new Transaction(options);
    tx.sign(options.pkey);
    return tx;
  },
  runTx: function(options, cb) {
    options = util.toBuffers(options);
    if (!options.hasOwnProperty('gasLimit')) options.gasLimit = this.DEFAULT_TX_GAS_LIMIT;
    if (!options.hasOwnProperty('gasPrice')) options.gasPrice = this.DEFAULT_TX_GAS_PRICE;
    if (!options.from) options.from = this.defaultAccount;
    var address = options.from.toString('hex');
    if (!this.accounts.hasOwnProperty(address))
      return cb('Could not find a private key for ' + address);

    if (!options.hasOwnProperty('pkey')) {
      if (!this.accounts[address])
        return cb('Please, specify the private key for account ' + address);
      options.pkey = this.accounts[address];
    }

    async.waterfall([
      this.addNonce.bind(this, options),
      async.asyncify(this.createTx.bind(this)),
      runTx.bind(this)
    ], cb);
    
    function runTx(tx, cb) {
      var block = this.createNextBlock([tx]);
      this.vm.runTx({ tx: tx, block: block }, (function(err, results) {
        if (err) return cb(err);
        this.transactions.push(parseTx(tx, results));
        if (options.contract) {
          this.contracts[results.createdAddress.toString('hex')] = options.contract;
        }
        _.each(this.filters, function(filter) {
          if (filter.type === 'pending')
            filter.entries.push('0x' + tx.hash().toString('hex'));
        });
        cb(null, {
          returnValue: results.vm.returnValue ?
            results.vm.returnValue.toString('hex') : null
        });
      }).bind(this));
    }
    function parseTx(tx, results) {
      return {
        from: tx.getSenderAddress().toString('hex'),
        nonce: ethUtils.bufferToInt(tx.nonce),
        gasPrice: ethUtils.bufferToInt(tx.gasPrice),
        gasLimit: ethUtils.bufferToInt(tx.gasLimit),
        to: tx.to.toString('hex'),
        gasUsed: results.gasUsed.toString('hex'),
        value: ethUtils.bufferToInt(tx.value),
        data: tx.data.toString('hex'),
        createdAddress: results.createdAddress ? results.createdAddress.toString('hex') : '',
        returnValue: results.returnValue ? results.returnValue.toString('hex') : '',
        exception: results.exception,
        rlp: tx.serialize().toString('hex'),
        r : tx.r.toString('hex'),
        s : tx.s.toString('hex'),
        v : tx.v.toString('hex'),
        hash: tx.hash().toString('hex')
      };
    }
  },
  sendTx: function(options, cb) {
    options = util.toBuffers(options);
    options.gasLimit = options.gas;
    if (!options.hasOwnProperty('gasLimit')) options.gasLimit = this.DEFAULT_TX_GAS_LIMIT;
    if (!options.hasOwnProperty('gasPrice')) options.gasPrice = this.DEFAULT_TX_GAS_PRICE;
    var address = options.from.toString('hex');
    if (!this.accounts.hasOwnProperty(address))
      return cb('Could not find a private key for ' + address);
    options.pkey = this.accounts[address];

    async.waterfall([
      this.addNonce.bind(this, options),
      async.asyncify(this.createTx.bind(this)),
      this.addTx.bind(this)
    ], function(err, tx) {
      if (err) cb(err);
      else cb(null, util.toHex(tx.hash().toString('hex')));
    });
  },
  addNonce: function(options, cb) {
    this.vm.trie.get(options.from, function(err, raw) {
      if (err) return cb(err);
      options.nonce = new Ethereum.Account(raw).nonce;
      cb(null, options);
    });
  },
  addTx: function(tx, cb) {
    var block = this.createNextBlock([tx]);
    this.vm.runBlock({ blockchain: this.blockchain, block: block, gen: true }, function(err) {
      if (err) console.error(err);
    });
    cb(null, tx);
  },
  getAccounts: function(cb) {
    var stream = this.vm.trie.createReadStream();
    var accounts = {};
    stream.on('data', function(data) {
      accounts[data.key.toString('hex')] = data.value;
    });
    stream.on('end', (function() {
      async.forEachOf(
        accounts,
        (function(rawAccount, address, cb) {
          this.parseAccount(rawAccount, function(err, account) {
            accounts[address] = account;
            cb(err);
          });
        }).bind(this),
        function(err) {
          cb(err, accounts);
        }
      );
    }).bind(this));
  },
  getAccount: function(address, cb) {
    try {
      var addressBuf = new Buffer(address, 'hex');
    } catch (e) {
      return cb('Could not parse address ' + address + ': ' + e.message);
    }
    this.vm.trie.get(addressBuf, (function(err, value) {
      if (err) cb(err);
      else this.parseAccount(value, cb);
    }).bind(this));
  },
  parseAccount: function(data, cb) {
    var raw = new Ethereum.Account(data);
    var account = {
      nonce: raw.nonce.toString('hex'),
      balance: raw.balance.toString('hex'),
      storage: {},
      code: ''
    };
    
    async.parallel([
      readStorage.bind(this, raw, account),
      readCode.bind(this, raw, account)
    ], function(err) {
      cb(err, account);
    });
    
    function readStorage(raw, account, cb) {
      if (raw.stateRoot.toString('hex') === this.SHA3_RLP_NULL) return cb();
      
      var strie = this.vm.trie.copy();
      strie.root = raw.stateRoot;
      var stream = strie.createReadStream();
      stream.on('data', function(data) {
        account.storage[data.key.toString('hex')] = createBuffer(rlp.decode(data.value)).toString('hex');
      });
      stream.on('end', cb);
    }
    function readCode(raw, account, cb) {
      raw.getCode(this.vm.trie, function(err, code) {
        account.code = code.toString('hex');
        cb(err);
      });
    }
  },
  newFilter: function(type, cb) {
    if (typeof type === 'object') cb(null, addFilter.call(this, 'log'));
    else if (type == 'pending') cb(null, addFilter.call(this, 'pending'));
    else cb('Unknow type: ' + type);

    function addFilter(type) {
      var num = '0x' + pad((this.filtersCounter++).toString(16));
      this.filters[num] = {
        type: type,
        entries: []
      };
      return num;
    }
  },
  removeFilter: function(id, cb) {
    if (!this.filters.hasOwnProperty(id))
      return cb('Could not find filter with id ' + id);
    delete this.filters[id];
    cb(null, true);
  },
  getFilterChanges: function(id, cb) {
    if (!this.filters.hasOwnProperty(id))
      return cb('Could not find filter with id ' + id);
    var changes = this.filters[id].entries;
    this.filters[id].entries = [];
    cb(null, changes);
  },
  createNextBlock: function(transactions) {
    return new Ethereum.Block({
      header: {
        coinbase: this.coinbase,
        gasLimit: this.gasLimit,
        number: this.blockchain.head ? this.blockchain.head.number + 1 : 0,
        timestamp: new Buffer(util.pad(Date.now().toString(16)), 'hex')
      }, transactions: transactions || [],
      uncleHeaders: []
    });
  }
};

module.exports = Sandbox;

function createBuffer(str) {
  var msg = new Buffer(str, 'hex');
  var buf = new Buffer(32);
  buf.fill(0);
  msg.copy(buf, 32 - msg.length);
  return buf;
}

function fillWithZeroes(str, length, right) {
  if (str.length >= length) return str;
  var zeroes = _.repeat('0', length - str.length);
  return right ? str + zeroes : zeroes + str;
}

function sha3(str) {
  var sha = new SHA3Hash(256);
  sha.update(str);
  return sha.digest('hex');
}

function pad(str) {
  return str.length % 2 === 0 ? str : '0' + str;
}

function setField(target, source, name) {
  try {
    if (source.hasOwnProperty(name) && source[name]) {
      if (!/^[\dA-F]*$/i.test(source[name]))
        throw { message: 'Invalid hex string' };
      if (!/^0*$/.test(source[name]))
        target[name] = new Buffer(source[name], 'hex');
    }
  } catch (e) {
    throw 'Could not set field ' + name + ' to ' + source[name] + ': ' + e.message;
  }
}
