var _ = require('lodash');
var util = require('../util');
var BigNumber = require('bignumber.js');

var Filters = {
  currentBlockNum: new BigNumber(0),
  lastFilterNum: 0,
  filters: {},
  init: function(sandbox) {
    this.sandbox = sandbox;
    return this;
  },
  destroy: function() {
    this.sandbox = null;
    this.filters = {};
    this.currentBlockNum = null;
  },
  nextNum: function() { return '0x' + (this.lastFilterNum++).toString(16); },
  addFilter: function(details) {
    if (details.fromBlock == 'earliest') details.fromBlock = new BigNumber(0);
    else if (details.fromBlock == 'pending') details.fromBlock = this.currentBlockNum;
    else if (details.fromBlock == 'latest') details.fromBlock = this.currentBlockNum;
    
    if (details.toBlock == 'earliest') details.toBlock = 0;
    else if (details.toBlock == 'pending') details.toBlock = 'latest';

    var num = this.nextNum();
    this.filters[num] = {
      type: 'log',
      fromBlock: details.fromBlock,
      toBlock: details.toBlock,
      address: details.address,
      entries: [],
      sent: []
    };
    return num;
  },
  addPendingTxFilter: function() {
    var num = this.nextNum();
    this.filters[num] = {
      type: 'pending',
      entries: [],
      sent: []
    };
    return num;
  },
  addBlockFilter: function() {
    var num = this.nextNum();
    this.filters[num] = {
      type: 'block',
      entries: [],
      sent: []
    };
    return num;
  },
  newBlock: function(block) {
    this.currentBlockNum = util.toBigNumber(block.header.number);
    var hash = util.toHex(block.hash());
    _(this.filters)
      .filter({type: 'block'})
      .each(function(filter) {
        filter.entries.push(hash);
      })
      .value();
  },
  newLogs: function(logs) {
    _(this.filters)
      .filter({ type: 'log' })
      .filter((function(filter) {
        return filter.fromBlock.lessThanOrEqualTo(this.currentBlockNum) &&
          (filter.toBlock == 'latest' ||
           filter.toBlock.greaterThanOrEqualTo(this.currentBlockNum));
      }).bind(this))
      .each(function(filter) {
        if (filter.address) {
          _.each(logs, function(log) {
            if (filter.address === log.address) filter.entries.push(log);
          });
        } else {
          Array.prototype.push.apply(filter.entries, logs);
        }
      })
      .value();
  },
  newPendingTx: function(tx) {
    var hash = tx.hash();
    _(this.filters)
      .filter({type: 'pending'})
      .each(function(filter) {
        filter.entries.push(hash);
      })
      .value();
  },
  removeFilter: function(id) {
    if (this.filters.hasOwnProperty(id)) delete this.filters[id];
  },
  getChanges: function(id) {
    var entries = [];
    if (this.filters.hasOwnProperty(id)) {
      entries = this.filters[id].entries;
      Array.prototype.push.apply(this.filters[id].sent, entries);
      this.filters[id].entries = [];
    }
    return entries;
  },
  getEntries: function(id) {
    var entries = [];
    if (this.filters.hasOwnProperty(id)) {
      Array.prototype.push.apply(this.filters[id].sent, this.filters[id].entries);
      this.filters[id].entries = [];
      entries = this.filters[id].sent;
    }
    return entries;
  }
};

module.exports = Filters;