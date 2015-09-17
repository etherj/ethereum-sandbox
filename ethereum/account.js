var Account = require('ethereumjs-account');
var _ = require('lodash');
var util = require('../util');

module.exports = {
  init: function(dataOrDetails, address) {
    this.address = address;
    
    if (Buffer.isBuffer(dataOrDetails)) {
      this.raw = new Account(dataOrDetails);
      this.nonce = util.toBigNumber(this.raw.nonce);
      this.balance = util.toBigNumber(this.raw.balance);
    } else {
      _.assign(this, dataOrDetails);
    }
    return this;
  },
  readStorage: function(trie, cb) {
    this.storage = {};
    
    if (this.raw.stateRoot.toString('hex') === util.SHA3_RLP_NULL) return cb(null, {});
    
    var strie = trie.copy();
    strie.root = this.raw.stateRoot;
    var stream = strie.createReadStream();
    stream.on('data', (function(data) {
      this.storage[util.toHex(data.key)] = util.toHex(util.decodeRlp(data.value));
    }).bind(this));
    stream.on('end', cb.bind(null, null, this.storage));
  },
  readCode: function(trie, cb) {
    this.code = null;
    this.raw.getCode(trie, (function(err, code) {
      this.code = code.length === 0 ? null : util.toHex(code);
      cb(null, this.code);
    }).bind(this));
  },
  raw: function() {
    return new Account({
      nonce: this.nonce == null || this.nonce.isZero() ? null : util.toBuffer(this.nonce),
      balance: this.balance == null || this.balance.isZero() ? null : util.toBuffer(this.balance)
    });
  },
  getDetails: function() {
    return {
      nonce: this.nonce == null || this.nonce.isZero() ? null : util.toHex(this.nonce),
      balance: this.balance == null || this.balance.isZero() ? null : util.toHex(this.balance),
      storage: this.storage,
      code: this.code
    };
  }
};